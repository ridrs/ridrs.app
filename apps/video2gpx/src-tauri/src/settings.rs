use crate::ctx::Ctx;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

pub const DEFAULT_RSM_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../research/route-shape-matching");

/// Which input an import template is meant for.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Accepts {
    Url,
    Path,
    #[default]
    Any,
}

/// An import template: one command line with the placeholders `{input}` (or `{url}` / `{path}`) and `{out}` (see import.rs).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct ImportTemplate {
    pub id: String,
    pub name: String,
    pub template: String,
    /// shipped with the app (read-only in the UI); always false for stored templates
    pub builtin: bool,
    pub accepts: Accepts,
    /// "ffmpeg" | "ffprobe" | "yt-dlp" when the command is one of the tools the app looks up, else null
    pub tool: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    /// Python interpreter that can `import rsm.pipeline` (M1 sidecar)
    pub python: String,
    /// directory of the research package (working directory and PYTHONPATH)
    pub rsm_dir: String,
    /// developer mode ("Entwicklermodus: externes Python"): only then the external Python (`python`, `rsm_dir`) or an explicit `sidecar` path is used.
    /// Off (default): the pipeline bundled in the app (sidecar) always runs.
    pub dev_mode: bool,
    /// developer mode only: path of another frozen pipeline executable (PyInstaller onedir). Empty = Python.
    pub sidecar: String,
    /// empty = look up on PATH (and Homebrew locations)
    pub ffmpeg: String,
    pub ffprobe: String,
    /// optional downloader of the user (never bundled); empty = `RSM_YTDLP`, else look up like ffmpeg
    pub ytdlp: String,
    /// existing .osm.pbf files that are used in place (never copied)
    pub linked_pbfs: Vec<String>,
    /// commands of the former free import command: kept readable for a one-time migration list, never executed, never written
    pub import_history: Vec<String>,
    /// the user's own import templates (the built-in ones come from import.rs)
    pub import_templates: Vec<ImportTemplate>,
    /// template id used for a URL (empty: none chosen; the app ships no downloader template), and for "copy first" of a path
    pub import_default_url: String,
    pub import_default_copy: String,
    pub last_project: Option<String>,
    /// look up a place from the video title online (Nominatim) when a video is added
    pub suggest_online: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            python: format!("{DEFAULT_RSM_DIR}/.venv/bin/python"),
            rsm_dir: DEFAULT_RSM_DIR.into(),
            dev_mode: false,
            sidecar: String::new(),
            ffmpeg: String::new(),
            ffprobe: String::new(),
            ytdlp: String::new(),
            linked_pbfs: vec![],
            import_history: vec![],
            import_templates: vec![],
            import_default_url: String::new(),
            import_default_copy: "cp".into(),
            last_project: None,
            suggest_online: true,
        }
    }
}

fn path(ctx: &Ctx) -> PathBuf {
    ctx.data_dir.join("settings.json")
}

pub fn load(ctx: &Ctx) -> Settings {
    std::fs::read_to_string(path(ctx)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save(ctx: &Ctx, s: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(&ctx.data_dir).map_err(|e| e.to_string())?;
    let tmp = path(ctx).with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(s).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path(ctx)).map_err(|e| e.to_string())
}

/// Folders searched after PATH: a GUI app started from the Finder has a minimal PATH (Homebrew on Apple silicon and Intel, the system,
/// MacPorts, and `~/.local/bin` where pipx puts yt-dlp).
pub fn extra_dirs() -> Vec<PathBuf> {
    let mut d: Vec<PathBuf> = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/opt/local/bin"].iter().map(PathBuf::from).collect();
    if let Some(h) = std::env::var_os("HOME") {
        d.push(PathBuf::from(h).join(".local/bin"));
    }
    d
}

/// PATH of this process followed by `extra_dirs` (no duplicates).
pub fn search_dirs() -> Vec<PathBuf> {
    let path: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    let mut dirs: Vec<PathBuf> = vec![];
    for d in path.into_iter().chain(extra_dirs()) {
        if !d.as_os_str().is_empty() && !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs
}

/// The PATH given to child processes (pipeline, import command): `search_dirs` joined.
pub fn tool_path() -> String {
    std::env::join_paths(search_dirs()).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
}

/// The lookup without the login shell: an explicit setting wins and is never replaced by a search; else the first hit in `dirs`.
pub fn find_in(setting: &str, name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    if !setting.trim().is_empty() {
        let p = PathBuf::from(setting.trim());
        return if is_exec(&p) { Some(p) } else { None };
    }
    dirs.iter().map(|d| d.join(name)).find(|p| is_exec(p))
}

/// Find an executable: explicit setting, else PATH plus the usual locations, and as a last resort the user's login shell
/// (`command -v`), which knows a PATH set in `.zprofile`.
pub fn find_tool(setting: &str, name: &str) -> Option<PathBuf> {
    if let Some(p) = find_in(setting, name, &search_dirs()) {
        return Some(p);
    }
    if !setting.trim().is_empty() || cfg!(test) {
        return None;
    }
    shell_lookup(name)
}

static SHELL_CACHE: Mutex<Option<HashMap<String, (Instant, Option<PathBuf>)>>> = Mutex::new(None);
/// how long "not found" by the login shell is remembered (the environment check runs on every window focus)
const SHELL_MISS_TTL: Duration = Duration::from_secs(30);

fn tool_name_ok(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('-') && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

/// `$SHELL -l -c 'command -v -- "$1"' sh NAME`: the name is an argument, never part of the script. A hit is cached for the
/// run of the app, a miss for 30 s.
pub fn shell_lookup(name: &str) -> Option<PathBuf> {
    if !tool_name_ok(name) {
        return None;
    }
    if let Some((t, r)) = SHELL_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(name) {
        match r {
            Some(p) if is_exec(p) => return Some(p.clone()),
            None if t.elapsed() < SHELL_MISS_TTL => return None,
            _ => {}
        }
    }
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/') && is_exec(Path::new(s))).unwrap_or_else(|| "/bin/zsh".into());
    let mut c = Command::new(shell);
    c.args(["-l", "-c", "command -v -- \"$1\"", "sh", name]);
    let found = run_timeout(&mut c, Duration::from_secs(4))
        .and_then(|o| o.lines().last().map(|l| PathBuf::from(l.trim())))
        .filter(|p| p.is_absolute() && is_exec(p));
    SHELL_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(name.to_string(), (Instant::now(), found.clone()));
    found
}

/// stdout (or, if that is empty, stderr) of a short helper call; None when it cannot start, fails or takes longer than `limit`.
fn run_timeout(cmd: &mut Command, limit: Duration) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().ok()?;
    let t0 = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if t0.elapsed() < limit => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let o = child.wait_with_output().ok()?;
    if !o.status.success() {
        return None;
    }
    let out = String::from_utf8_lossy(&o.stdout).to_string();
    Some(if out.trim().is_empty() { String::from_utf8_lossy(&o.stderr).to_string() } else { out })
}

pub(crate) fn is_exec(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.is_file() && std::fs::metadata(p).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

pub fn ffmpeg(s: &Settings) -> Option<PathBuf> {
    find_tool(&s.ffmpeg, "ffmpeg")
}

/// ffprobe: its own setting, else next to the ffmpeg that was found (one installation is both), else the search.
pub fn ffprobe(s: &Settings) -> Option<PathBuf> {
    if s.ffprobe.trim().is_empty() {
        if let Some(p) = ffmpeg(s).and_then(|f| f.parent().map(|d| d.join("ffprobe"))).filter(|p| is_exec(p)) {
            return Some(p);
        }
    }
    find_tool(&s.ffprobe, "ffprobe")
}

/// yt-dlp is optional and never bundled: the setting, else `RSM_YTDLP`, else the search.
pub fn ytdlp(s: &Settings) -> Option<PathBuf> {
    if s.ytdlp.trim().is_empty() {
        if let Some(p) = std::env::var_os("RSM_YTDLP").map(PathBuf::from).filter(|p| is_exec(p)) {
            return Some(p);
        }
    }
    find_tool(&s.ytdlp, "yt-dlp")
}

/// Homebrew itself (only to choose the install hint).
pub fn brew() -> Option<PathBuf> {
    find_tool("", "brew")
}

/// The command that installs packages on this system, without the package names ("brew install", "sudo apt install", ...):
/// Homebrew on the Mac, else the first package manager found on Linux. None when none is known.
pub fn install_cmd() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        return Some("brew install");
    }
    [("apt", "sudo apt install"), ("dnf", "sudo dnf install"), ("pacman", "sudo pacman -S"), ("zypper", "sudo zypper install")]
        .into_iter()
        .find(|(bin, _)| find_in("", bin, &search_dirs()).is_some())
        .map(|(_, cmd)| cmd)
}

/// "brew install ffmpeg" or the like for this system, or a generic sentence when no package manager is known.
pub fn install_hint(pkg: &str) -> String {
    match install_cmd() {
        Some(c) => format!("{c} {pkg}"),
        None => format!("{pkg} mit dem Paketmanager des Systems"),
    }
}

/// The version out of the first line of `ffmpeg -version` ("ffmpeg version 7.1.1 Copyright ...") or `yt-dlp --version` ("2026.10.22").
pub fn parse_version(name: &str, output: &str) -> Option<String> {
    let line = output.lines().find(|l| !l.trim().is_empty())?.trim();
    let v = if name == "ffmpeg" || name == "ffprobe" {
        let mut w = line.split_whitespace();
        if w.next()? != name || w.next()? != "version" {
            return None;
        }
        w.next()?
    } else {
        line.split_whitespace().last()?
    };
    Some(v.to_string()).filter(|v| v.len() <= 80)
}

/// Leading number of a version ("7.1.1" -> 7, "n6.0" -> 6); None for git builds ("N-112233-g...").
pub fn major_version(version: &str) -> Option<u32> {
    let v = version.strip_prefix('n').unwrap_or(version);
    let digits: String = v.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || digits.len() > 4 { None } else { digits.parse().ok() }
}

static VERSION_CACHE: Mutex<Option<HashMap<(PathBuf, Option<SystemTime>), Option<String>>>> = Mutex::new(None);

/// Version of a found tool. The tool is started once per file and modification time (the environment check must stay fast).
pub fn tool_version(path: &Path, name: &str) -> Option<String> {
    let key = (path.to_path_buf(), std::fs::metadata(path).and_then(|m| m.modified()).ok());
    if let Some(v) = VERSION_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&key) {
        return v.clone();
    }
    let flag = if name == "ffmpeg" || name == "ffprobe" { "-version" } else { "--version" };
    let v = run_timeout(Command::new(path).arg(flag), Duration::from_secs(8)).and_then(|o| parse_version(name, &o));
    VERSION_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, v.clone());
    v
}

/// Environment for every pipeline / python call.
pub fn python_env(ctx: &Ctx, s: &Settings) -> Vec<(String, String)> {
    let mut env = vec![
        ("PYTHONPATH".to_string(), s.rsm_dir.clone()),
        ("RSM_DATA_DIR".to_string(), ctx.cache_dir().to_string_lossy().into()),
        ("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string()),
        ("PYTHONUNBUFFERED".to_string(), "1".to_string()),
    ];
    if let Some(f) = ffmpeg(s) {
        env.push(("RSM_FFMPEG".into(), f.to_string_lossy().into()));
    }
    if let Some(f) = ffprobe(s) {
        env.push(("RSM_FFPROBE".into(), f.to_string_lossy().into()));
    }
    env.push(("PATH".into(), tool_path()));
    env
}

/// The pipeline bundled with the app (`Contents/Resources/sidecar/rsm-pipeline/rsm-pipeline` next to the app executable, or `V2G_SIDECAR`).
pub fn bundled_sidecar() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = vec![];
    if let Ok(v) = std::env::var("V2G_SIDECAR") {
        cands.push(PathBuf::from(v));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            cands.push(dir.join("../Resources/sidecar/rsm-pipeline/rsm-pipeline"));
            cands.push(dir.join("../Resources/resources/sidecar/rsm-pipeline/rsm-pipeline"));
        }
    }
    cands.into_iter().find(|p| is_exec(p))
}

/// Which frozen pipeline runs. The bundled one wins, unless developer mode is on: then an explicit `sidecar` path, else None = the external
/// Python interpreter (`python -m rsm.pipeline`). Without developer mode and without a bundled pipeline there is none (the env check says so).
pub fn sidecar(s: &Settings) -> Option<PathBuf> {
    if s.dev_mode {
        let e = s.sidecar.trim();
        return if !e.is_empty() && is_exec(Path::new(e)) { Some(PathBuf::from(e)) } else { None };
    }
    bundled_sidecar()
}

/// Developer mode with an explicit sidecar path that is not executable: an error, not a silent fallback.
pub fn dev_sidecar_missing(s: &Settings) -> bool {
    s.dev_mode && !s.sidecar.trim().is_empty() && !is_exec(Path::new(s.sidecar.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_settings_without_dev_mode_use_the_bundle() {
        // the settings.json written before the feature: python = research venv, sidecar empty, no dev_mode key
        let old = r#"{"python":"/x/.venv/bin/python","rsm_dir":"/x","sidecar":"","ffmpeg":"","ffprobe":"","linked_pbfs":[],"import_history":[],"last_project":null,"suggest_online":true}"#;
        let s: Settings = serde_json::from_str(old).unwrap();
        assert!(!s.dev_mode);
        assert_eq!(sidecar(&s), bundled_sidecar()); // the bundle (or none in a test run), never an external Python
        let mut d = s.clone();
        d.dev_mode = true;
        assert!(sidecar(&d).is_none()); // developer mode without an explicit path: external Python
    }

    #[test]
    fn old_settings_get_the_import_defaults_and_templates_round_trip() {
        let s: Settings = serde_json::from_str(r#"{"ffmpeg":"","import_history":["yt-dlp x"]}"#).unwrap();
        assert_eq!((s.ytdlp.as_str(), s.import_default_url.as_str(), s.import_default_copy.as_str()), ("", "", "cp"));
        assert!(s.import_templates.is_empty() && s.import_history.len() == 1);
        // the field names of the UI contract, and a template with missing keys
        let s: Settings = serde_json::from_str(r#"{"ytdlp":"/x/yt-dlp","import_templates":[{"id":"a","name":"A","template":"rsync {input} {out}/","builtin":false,"accepts":"url","tool":null},{"id":"b","template":"cp {path} {out}"}]}"#).unwrap();
        assert_eq!(s.import_templates[0].accepts, Accepts::Url);
        assert_eq!(s.import_templates[1].accepts, Accepts::Any);
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["import_templates"][0]["accepts"], "url");
        assert!(v["import_templates"][0]["tool"].is_null() && v["import_default_copy"] == "cp");
    }

    fn exec_file(dir: &Path, name: &str, mode: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, "#!/bin/sh\necho hi\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
        p
    }

    #[test]
    fn tool_lookup_order_and_rules() {
        let d = std::env::temp_dir().join(format!("v2g-tools-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let a = exec_file(&d.join("a"), "tool", 0o755);
        let b = exec_file(&d.join("b"), "tool", 0o755);
        exec_file(&d.join("c"), "tool", 0o644); // not executable: skipped
        let dirs = vec![d.join("missing"), d.join("c"), d.join("b"), d.join("a")];
        assert_eq!(find_in("", "tool", &dirs), Some(b.clone())); // first hit in order
        assert_eq!(find_in("", "other", &dirs), None);
        assert_eq!(find_in(a.to_str().unwrap(), "tool", &dirs), Some(a.clone())); // the setting wins
        assert_eq!(find_in(&format!("  {}  ", a.display()), "tool", &dirs), Some(a.clone()));
        // a wrong setting is an error, never silently replaced by a search
        assert_eq!(find_in("/nonexistent/tool", "tool", &dirs), None);
        assert_eq!(find_in(d.join("c/tool").to_str().unwrap(), "tool", &dirs), None);
        assert_eq!(find_in(d.join("a").to_str().unwrap(), "tool", &dirs), None); // a folder is not a program
        // ffprobe is taken from next to the configured ffmpeg; yt-dlp from its setting
        exec_file(&d.join("ff"), "ffmpeg", 0o755);
        let fp = exec_file(&d.join("ff"), "ffprobe", 0o755);
        let mut s = Settings::default();
        s.ffmpeg = d.join("ff/ffmpeg").to_string_lossy().into();
        assert_eq!(ffprobe(&s), Some(fp));
        s.ytdlp = a.to_string_lossy().into();
        assert_eq!(ytdlp(&s), Some(a));
        s.ytdlp = "/nonexistent/yt-dlp".into();
        assert_eq!(ytdlp(&s), None);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn search_dirs_cover_homebrew_macports_and_local_bin() {
        let dirs = search_dirs();
        for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/opt/local/bin"] {
            assert!(dirs.contains(&PathBuf::from(d)), "{d}");
        }
        assert!(dirs.iter().any(|d| d.ends_with(".local/bin")));
        assert!(dirs.iter().enumerate().all(|(i, d)| !dirs[..i].contains(d)), "no duplicates");
        assert!(tool_path().contains("/opt/homebrew/bin"));
    }

    #[test]
    fn shell_lookup_takes_only_plain_names() {
        for bad in ["", "-v", "a b", "x;id", "$(id)", "a/b", "`id`", "a\nb"] {
            assert!(!tool_name_ok(bad), "{bad:?}");
            assert_eq!(shell_lookup(bad), None);
        }
        assert!(tool_name_ok("yt-dlp") && tool_name_ok("ffmpeg") && tool_name_ok("g++"));
    }

    #[test]
    fn versions() {
        assert_eq!(parse_version("ffmpeg", "ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with Apple clang").as_deref(), Some("7.1.1"));
        assert_eq!(parse_version("ffprobe", "ffprobe version n6.0 Copyright").as_deref(), Some("n6.0"));
        assert_eq!(parse_version("ffmpeg", "zsh: bad interpreter"), None);
        assert_eq!(parse_version("yt-dlp", "2026.10.22\n").as_deref(), Some("2026.10.22"));
        assert_eq!(parse_version("yt-dlp", ""), None);
        assert_eq!((major_version("7.1.1"), major_version("n6.0"), major_version("4.4"), major_version("N-112233-gabc")), (Some(7), Some(6), Some(4), None));
        // a real call, cached by path and modification time
        let d = std::env::temp_dir().join(format!("v2g-ver-{}", std::process::id()));
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("yt-dlp");
        std::fs::write(&p, "#!/bin/sh\necho 2026.01.02\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(tool_version(&p, "yt-dlp").as_deref(), Some("2026.01.02"));
        assert_eq!(tool_version(&p, "yt-dlp").as_deref(), Some("2026.01.02"));
        assert_eq!(tool_version(&d.join("none"), "yt-dlp"), None);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn developer_mode_ignores_the_bundle() {
        let mut s = Settings::default();
        s.dev_mode = true;
        s.sidecar = "/nonexistent/rsm-pipeline".into();
        assert!(sidecar(&s).is_none() && dev_sidecar_missing(&s));
    }
}
