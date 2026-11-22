//! The Python sidecar (M1): environment check and `rsm.pipeline run/retime`. The import by template is in import.rs.
use crate::ctx::Ctx;
use crate::proc;
use crate::settings::{self, Settings};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

/// The pipeline command: the bundled frozen sidecar (default), or in developer mode the external `python -m rsm.pipeline`. The caller adds the
/// sub-command (`run`, `retime`, ...) and its arguments.
pub(crate) fn pipeline_cmd(ctx: &Ctx, s: &Settings) -> Command {
    let mut c;
    if let Some(sc) = settings::sidecar(s) {
        c = Command::new(sc);
        c.current_dir(&ctx.data_dir);
    } else {
        // only reached in developer mode (the env check refuses everything else)
        c = Command::new(&s.python);
        c.current_dir(&s.rsm_dir).args(["-m", "rsm.pipeline"]);
    }
    for (k, v) in settings::python_env(ctx, s) {
        if settings::sidecar(s).is_some() && k == "PYTHONPATH" {
            continue; // the frozen bundle carries its own modules
        }
        c.env(k, v);
    }
    c
}

fn python_cmd(ctx: &Ctx, s: &Settings) -> Command {
    let mut c = Command::new(&s.python);
    c.current_dir(&s.rsm_dir);
    for (k, v) in settings::python_env(ctx, s) {
        c.env(k, v);
    }
    c
}

static SIDECAR_CACHE: Mutex<Option<HashMap<(PathBuf, Option<SystemTime>), (Value, Value)>>> = Mutex::new(None);

/// Does the frozen pipeline start, and which version is it: `(rsm, pipeline)` of the environment check. Starting the frozen
/// executable takes about a second, so a good answer is kept per file and modification time (the check runs on every window focus).
fn sidecar_check(ctx: &Ctx, s: &Settings, sc: &Path, mode: &str) -> (Value, Value) {
    let key = (sc.to_path_buf(), std::fs::metadata(sc).and_then(|m| m.modified()).ok());
    if let Some(v) = SIDECAR_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&key) {
        return v.clone();
    }
    let mut rsm = json!({"ok": false, "dir": sc});
    match pipeline_cmd(ctx, s).args(["run", "--help"]).output() {
        Ok(o) if o.status.success() => rsm["ok"] = json!(true),
        Ok(o) => rsm["message"] = json!(format!("Das gebündelte Sidecar startet nicht: {}", String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or(""))),
        Err(e) => rsm["message"] = json!(format!("Das gebündelte Sidecar startet nicht: {e}")),
    }
    let pipeline = pipeline_version(ctx, s, mode, rsm["ok"] == json!(true));
    if rsm["ok"] == json!(true) {
        SIDECAR_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, (rsm.clone(), pipeline.clone()));
    }
    (rsm, pipeline)
}

/// Version of the pipeline that will run (frozen.json: version and code hash); older sidecars do not know the command.
fn pipeline_version(ctx: &Ctx, s: &Settings, mode: &str, ok: bool) -> Value {
    let mut pipeline = json!({"mode": mode, "version": null, "code_hash": null});
    if ok {
        if let Ok(o) = pipeline_cmd(ctx, s).arg("version").output() {
            if let Some(v) = String::from_utf8_lossy(&o.stdout).lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find(|v| v["type"] == "version") {
                pipeline["version"] = v["version"].clone();
                pipeline["code_hash"] = v["code_hash"].clone();
            }
        }
    }
    pipeline
}

static HASH_CACHE: Mutex<Option<HashMap<(PathBuf, Option<SystemTime>), Option<String>>>> = Mutex::new(None);

/// Code hash of the pipeline that will run (`rsm.pipeline version`), for comparing with the `pipeline_hash` of stored results. Kept per
/// executable (sidecar) or, in developer mode, per frozen.json and its modification time. None when the pipeline cannot tell.
pub(crate) fn code_hash(ctx: &Ctx, s: &Settings) -> Option<String> {
    let key = match settings::sidecar(s) {
        Some(sc) => (sc.clone(), std::fs::metadata(&sc).and_then(|m| m.modified()).ok()),
        None => {
            let f = Path::new(&s.rsm_dir).join("rsm").join("pipeline").join("frozen.json");
            (f.clone(), std::fs::metadata(&f).and_then(|m| m.modified()).ok())
        }
    };
    if let Some(v) = HASH_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&key) {
        return v.clone();
    }
    let h = pipeline_cmd(ctx, s).arg("version").output().ok().and_then(|o| {
        String::from_utf8_lossy(&o.stdout).lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find(|v| v["type"] == "version").and_then(|v| v["code_hash"].as_str().map(|x| x.to_string()))
    });
    if h.is_some() {
        HASH_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, h.clone());
    }
    h
}

/// One tool of the environment check (`ToolCheck`): found path and version, or what to do. ffmpeg and ffprobe are required,
/// yt-dlp is optional (only templates that name it need it).
fn tool_check(name: &str, found: Option<PathBuf>, setting: &str, required: bool) -> Value {
    let Some(p) = found else {
        let message = if !setting.trim().is_empty() {
            format!("{name} nicht gefunden: {} ist keine ausführbare Datei. Bitte den Pfad in den Einstellungen korrigieren oder leeren.", setting.trim())
        } else if required {
            format!("{name} nicht gefunden. Bitte installieren ({}) oder den Pfad in den Einstellungen setzen.", settings::install_hint("ffmpeg"))
        } else {
            format!("{name} nicht gefunden (optional). Installieren zum Beispiel mit: {}", settings::install_hint(name))
        };
        return json!({"ok": false, "path": setting, "message": message, "required": required});
    };
    let mut t = json!({"ok": true, "path": p, "required": required});
    match settings::tool_version(&p, name) {
        Some(v) => {
            if (name == "ffmpeg" || name == "ffprobe") && settings::major_version(&v).map(|m| m < 6).unwrap_or(false) {
                t["warning"] = json!(format!("{name} {v} ist alt. Empfohlen ist Version 6 oder neuer."));
            }
            t["version"] = json!(v);
        }
        None => t["warning"] = json!(format!("{name} wurde gefunden, hat aber keine Version gemeldet.")),
    }
    t
}

/// Clear status for the settings screen and before every run. The tools are looked up as in settings.rs; Python and the
/// research folder are checked in developer mode only (otherwise `python` and `rsm` describe the bundled pipeline).
pub fn env_check(ctx: &Ctx) -> Value {
    let s = settings::load(ctx);
    let mut py = json!({"ok": false, "path": s.python});
    let mut rsm = json!({"ok": false, "dir": s.rsm_dir});
    let mut mode = "sidecar";
    let mut pipeline = None;
    if let Some(sc) = settings::sidecar(&s) {
        // the frozen pipeline needs neither Python nor the research folder
        py = json!({"ok": true, "path": sc, "version": "gebündelte Pipeline (Sidecar)"});
        let (r, p) = sidecar_check(ctx, &s, &sc, mode);
        rsm = r;
        pipeline = Some(p);
    } else if !s.dev_mode {
        let m = "In dieser App ist keine Pipeline gebündelt. Bitte die App aus dem Release-Paket starten, oder in den Einstellungen den Entwicklermodus (externes Python) einschalten.";
        py["message"] = json!(m);
        rsm["message"] = json!(m);
    } else if settings::dev_sidecar_missing(&s) {
        mode = "python";
        py["message"] = json!(format!("Entwicklermodus: das Sidecar {} ist nicht ausführbar.", s.sidecar));
    } else {
        mode = "python";
        if !Path::new(&s.python).is_file() {
            py["message"] = json!(format!("Python nicht gefunden: {}. Bitte in den Einstellungen den Pfad zum Interpreter setzen.", s.python));
        } else if !Path::new(&s.rsm_dir).is_dir() {
            py["ok"] = json!(true);
            rsm["message"] = json!(format!("Pipeline-Ordner nicht gefunden: {}", s.rsm_dir));
        } else {
            match python_cmd(ctx, &s).args(["-c", "import sys, rsm.pipeline; print(sys.version.split()[0])"]).output() {
                Ok(o) if o.status.success() => {
                    py["ok"] = json!(true);
                    py["version"] = json!(String::from_utf8_lossy(&o.stdout).trim());
                    rsm["ok"] = json!(true);
                }
                Ok(o) => {
                    py["ok"] = json!(true);
                    let e = String::from_utf8_lossy(&o.stderr);
                    rsm["message"] = json!(format!("rsm.pipeline lässt sich nicht importieren: {}", e.lines().last().unwrap_or("")));
                }
                Err(e) => py["message"] = json!(format!("Python lässt sich nicht starten: {e}")),
            }
        }
    }
    let pipeline = pipeline.unwrap_or_else(|| pipeline_version(ctx, &s, mode, rsm["ok"] == json!(true)));
    let brew = match settings::brew() {
        Some(p) => json!({"ok": true, "path": p}),
        None => json!({"ok": false, "message": "Homebrew nicht gefunden (https://brew.sh)."}),
    };
    json!({
        "python": py, "rsm": rsm, "pipeline": pipeline, "dev_mode": s.dev_mode,
        "ffmpeg": tool_check("ffmpeg", settings::ffmpeg(&s), &s.ffmpeg, true),
        "ffprobe": tool_check("ffprobe", settings::ffprobe(&s), &s.ffprobe, true),
        "ytdlp": tool_check("yt-dlp", settings::ytdlp(&s), &s.ytdlp, false),
        "brew": brew,
        "os": std::env::consts::OS,
        "install_cmd": settings::install_cmd(),
        "data_dir": ctx.data_dir, "cache_dir": ctx.cache_dir(),
    })
}

pub(crate) fn require_env(ctx: &Ctx) -> Result<Settings, String> {
    let e = env_check(ctx);
    for k in ["python", "rsm", "ffmpeg", "ffprobe"] {
        if e[k]["ok"] != json!(true) {
            return Err(e[k]["message"].as_str().unwrap_or("Umgebung unvollständig").to_string());
        }
    }
    Ok(settings::load(ctx))
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct RunParams {
    pub project: String,
    pub video: String,
    /// [south, west, north, east]
    pub bbox: [f64; 4],
    pub pbf: String,
    pub vehicle: Option<String>,
    pub offset_m: Option<f64>,
    pub start_time: Option<String>,
    pub resume: bool,
    pub decoys: Option<u32>,
    /// start / end frame [south, west, north, east] (optional hints, see docs/FEATURE_area_hints.md)
    pub start_bbox: Option<[f64; 4]>,
    pub end_bbox: Option<[f64; 4]>,
    /// route hint file (.gpx / .kml, a copy inside the project), corridor half-width in m, fallback "auto" | "off"
    pub hint: Option<String>,
    pub hint_buffer_m: Option<f64>,
    pub hint_fallback: Option<String>,
    /// bike paths for a bike: "on" | "fallback" (pipeline `--bike-paths`); anything else / missing = roads only (the option is left out)
    pub bike_paths: Option<String>,
    /// dense heading alignment in refine: "posterior" (wherever it is sure, weighted) | "turns" (only strong turns) (`--align-mode`); missing = pipeline default
    pub align_mode: Option<String>,
    /// user anchors [{t, bbox: [S,W,N,E]}] ("Ortsangaben"): written to `<project>/anchors.json` and passed as `--anchors` (docs/USER_ANCHORS.md)
    pub anchors: Option<Vec<Value>>,
    /// video second at which the intro ends, set by hand ("Intro-Ende hier setzen"): replaces the intro found from the scene cuts (`--intro-end`)
    pub intro_end: Option<f64>,
    /// with `resume`: reuse the steps before this one as they are and rerun it and all later ones (`--from-step`)
    pub from_step: Option<String>,
    /// The video is still being imported: accept the start now, wait for the end of the import and run with the imported
    /// file (`video` may be empty). Until then `{type: "input"}` events report how much of the video is there.
    pub follow_import: bool,
}

pub fn build_args(p: &RunParams, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec!["run".to_string()];
    a.extend(["--video".into(), p.video.clone()]);
    a.extend(["--bbox".into(), format!("{:.6},{:.6},{:.6},{:.6}", p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3])]);
    a.extend(["--pbf".into(), p.pbf.clone(), "--out".into(), out.to_string_lossy().into()]);
    if let Some(v) = p.vehicle.as_ref().filter(|v| !v.is_empty() && *v != "auto") {
        a.extend(["--vehicle".into(), v.clone()]);
    }
    if let Some(o) = p.offset_m {
        a.extend(["--offset-m".into(), format!("{o}")]);
    }
    if let Some(t) = p.start_time.as_ref().filter(|t| !t.is_empty()) {
        a.extend(["--start-time".into(), t.clone()]);
    }
    if let Some(d) = p.decoys.filter(|d| *d > 0) {
        a.extend(["--decoys".into(), d.to_string()]);
    }
    let bb = |b: &[f64; 4]| format!("{:.6},{:.6},{:.6},{:.6}", b[0], b[1], b[2], b[3]);
    if let Some(b) = &p.start_bbox {
        a.extend(["--start-bbox".into(), bb(b)]);
    }
    if let Some(b) = &p.end_bbox {
        a.extend(["--end-bbox".into(), bb(b)]);
    }
    if let Some(h) = p.hint.as_ref().filter(|h| !h.is_empty()) {
        a.extend(["--hint".into(), h.clone()]);
        if let Some(m) = p.hint_buffer_m {
            a.extend(["--hint-buffer-m".into(), format!("{m}")]);
        }
        if let Some(f) = p.hint_fallback.as_ref().filter(|f| *f == "off") {
            a.extend(["--hint-fallback".into(), f.clone()]);
        }
    }
    if let Some(b) = p.bike_paths.as_ref().filter(|b| *b == "on" || *b == "fallback") {
        a.extend(["--bike-paths".into(), b.clone()]);
    }
    if let Some(m) = p.align_mode.as_ref().filter(|m| *m == "posterior" || *m == "turns") {
        a.extend(["--align-mode".into(), m.clone()]);
    }
    if let Some(t) = p.intro_end.filter(|t| t.is_finite() && *t > 0.0) {
        a.extend(["--intro-end".into(), format!("{t:.2}")]);
    }
    if p.anchors.as_ref().is_some_and(|v| !v.is_empty()) {
        a.extend(["--anchors".into(), anchors_path(out).to_string_lossy().into()]);
    }
    if p.resume {
        a.push("--resume".into());
        if let Some(s) = p.from_step.as_ref().filter(|s| STEPS.contains(&s.as_str())) {
            a.extend(["--from-step".into(), s.clone()]);
        }
    }
    a
}

/// the pipeline steps in order (rsm.pipeline.config.STEPS)
const STEPS: [&str; 7] = ["motion", "rotation", "map", "route_search", "plausibility", "refine", "gpx"];

/// the anchors file of a run: next to the out dir, in the project folder
fn anchors_path(out: &Path) -> PathBuf {
    out.parent().unwrap_or(out).join("anchors.json")
}

/// writes the anchors of a run for `--anchors` (or removes an old file when there are none)
fn write_anchors(p: &RunParams, out: &Path) -> Result<(), String> {
    let f = anchors_path(out);
    match p.anchors.as_ref().filter(|v| !v.is_empty()) {
        Some(v) => std::fs::write(&f, serde_json::to_vec(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string()),
        None => {
            let _ = std::fs::remove_file(&f);
            Ok(())
        }
    }
}

/// Copy a route hint file (.gpx / .kml) into the project (`hint/`, one file at a time) and return its name, new path and text for display.
pub fn hint_import(ctx: &Ctx, project: &str, src: &str) -> Result<Value, String> {
    let srcp = Path::new(src);
    let ext = srcp.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if ext != "gpx" && ext != "kml" {
        return Err("Als Routenhinweis werden nur .gpx- und .kml-Dateien unterstützt.".into());
    }
    let meta = std::fs::metadata(srcp).map_err(|e| format!("Datei nicht lesbar: {e}"))?;
    if meta.len() > 30_000_000 {
        return Err("Die Datei ist zu groß für einen Routenhinweis (über 30 MB).".into());
    }
    let dir = ctx.project_dir(project)?.join("hint");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = srcp.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| format!("hint.{ext}"));
    let dst = dir.join(&name);
    std::fs::copy(srcp, &dst).map_err(|e| format!("Kopieren fehlgeschlagen: {e}"))?;
    let text = std::fs::read_to_string(&dst).map_err(|e| format!("Datei ist kein Text (XML): {e}"))?;
    Ok(json!({"name": name, "path": dst, "text": text}))
}

/// The stored hint of a project as text (for drawing it on reopening).
pub fn hint_read(ctx: &Ctx, project: &str, path: &str) -> Result<String, String> {
    let dir = ctx.project_dir(project)?.join("hint");
    let p = Path::new(path);
    if !p.starts_with(&dir) || path.contains("..") {
        return Err("Ungültiger Pfad des Routenhinweises".into());
    }
    std::fs::read_to_string(p).map_err(|e| format!("Routenhinweis nicht lesbar: {e}"))
}

pub fn hint_remove(ctx: &Ctx, project: &str) -> Result<(), String> {
    let dir = ctx.project_dir(project)?.join("hint");
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_without_hints_are_unchanged() {
        let p = RunParams { project: "p".into(), video: "v.mp4".into(), bbox: [1.0, 2.0, 3.0, 4.0], pbf: "x.pbf".into(), ..Default::default() };
        let a = build_args(&p, Path::new("/o")).join(" ");
        assert_eq!(a, "run --video v.mp4 --bbox 1.000000,2.000000,3.000000,4.000000 --pbf x.pbf --out /o");
    }

    #[test]
    fn args_with_frames_and_hint() {
        let p = RunParams { project: "p".into(), video: "v.mp4".into(), bbox: [1.0, 2.0, 3.0, 4.0], pbf: "x.pbf".into(), start_bbox: Some([1.5, 2.5, 1.6, 2.6]), end_bbox: Some([2.0, 3.0, 2.1, 3.1]),
            hint: Some("/p/hint/r.gpx".into()), hint_buffer_m: Some(500.0), hint_fallback: Some("off".into()), resume: true, ..Default::default() };
        let a = build_args(&p, Path::new("/o")).join(" ");
        assert!(a.contains("--start-bbox 1.500000,2.500000,1.600000,2.600000"));
        assert!(a.contains("--end-bbox 2.000000,3.000000,2.100000,3.100000"));
        assert!(a.contains("--hint /p/hint/r.gpx --hint-buffer-m 500 --hint-fallback off"));
        assert!(a.ends_with("--resume"));
    }

    #[test]
    fn args_with_bike_paths_only_when_on_or_fallback() {
        let base = RunParams { project: "p".into(), video: "v.mp4".into(), bbox: [1.0, 2.0, 3.0, 4.0], pbf: "x.pbf".into(), ..Default::default() };
        for (v, want) in [(Some("on"), Some("--bike-paths on")), (Some("fallback"), Some("--bike-paths fallback")), (Some("off"), None), (Some("x"), None), (None, None)] {
            let p = RunParams { bike_paths: v.map(String::from), ..base.clone() };
            let a = build_args(&p, Path::new("/o")).join(" ");
            match want {
                Some(w) => assert!(a.ends_with(w), "{a}"),
                None => assert!(!a.contains("--bike-paths"), "{a}"),
            }
        }
        let p: RunParams = serde_json::from_str(r#"{"project":"p","video":"v.mp4","bbox":[1,2,3,4],"pbf":"x.pbf","bike_paths":"fallback"}"#).unwrap();
        assert_eq!(p.bike_paths.as_deref(), Some("fallback"));
    }

    #[test]
    fn args_with_align_mode_only_when_known() {
        let base = RunParams { project: "p".into(), video: "v.mp4".into(), bbox: [1.0, 2.0, 3.0, 4.0], pbf: "x.pbf".into(), ..Default::default() };
        for (v, want) in [(Some("posterior"), Some("--align-mode posterior")), (Some("turns"), Some("--align-mode turns")), (Some("x"), None), (None, None)] {
            let p = RunParams { align_mode: v.map(String::from), ..base.clone() };
            let a = build_args(&p, Path::new("/o")).join(" ");
            match want {
                Some(w) => assert!(a.ends_with(w), "{a}"),
                None => assert!(!a.contains("--align-mode"), "{a}"),
            }
        }
    }

    #[test]
    fn args_with_an_intro_end_set_by_hand() {
        let p: RunParams = serde_json::from_str(r#"{"project":"p","video":"v.mp4","bbox":[1,2,3,4],"pbf":"x.pbf","intro_end":49.254}"#).unwrap();
        assert!(build_args(&p, Path::new("/o")).join(" ").ends_with("--intro-end 49.25"));
        for t in [None, Some(0.0), Some(-3.0), Some(f64::NAN)] {
            let p = RunParams { intro_end: t, ..p.clone() };
            assert!(!build_args(&p, Path::new("/o")).join(" ").contains("--intro-end"));
        }
    }

    #[test]
    fn args_with_anchors_and_from_step() {
        let p: RunParams = serde_json::from_str(r#"{"project":"p","video":"v.mp4","bbox":[1,2,3,4],"pbf":"x.pbf","resume":true,"from_step":"route_search",
            "anchors":[{"t":68,"bbox":[46.633,8.592,46.635,8.596]}]}"#).unwrap();
        let a = build_args(&p, Path::new("/proj/out")).join(" ");
        assert!(a.contains("--anchors /proj/anchors.json"), "{a}");
        assert!(a.ends_with("--resume --from-step route_search"), "{a}");
        // no anchors, an unknown step, or no resume: the options are left out
        for js in [r#"{"project":"p","video":"v","bbox":[1,2,3,4],"pbf":"x","resume":true,"from_step":"nope","anchors":[]}"#,
                   r#"{"project":"p","video":"v","bbox":[1,2,3,4],"pbf":"x","resume":false,"from_step":"refine"}"#] {
            let a = build_args(&serde_json::from_str(js).unwrap(), Path::new("/proj/out")).join(" ");
            assert!(!a.contains("--anchors") && !a.contains("--from-step"), "{a}");
        }
        let d = std::env::temp_dir().join(format!("v2g-anchors-test-{}", std::process::id()));
        let out = d.join("out");
        std::fs::create_dir_all(&out).unwrap();
        write_anchors(&p, &out).unwrap();
        let v: Value = serde_json::from_slice(&std::fs::read(d.join("anchors.json")).unwrap()).unwrap();
        assert_eq!(v[0]["t"], 68);
        write_anchors(&RunParams::default(), &out).unwrap();
        assert!(!d.join("anchors.json").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn run_params_of_the_ui_and_follow_import() {
        // follow_import is optional; it never becomes a pipeline argument (the run starts with the complete file)
        let p: RunParams = serde_json::from_str(r#"{"project":"p","video":"","bbox":[1,2,3,4],"pbf":"x.pbf","resume":false,"follow_import":true}"#).unwrap();
        assert!(p.follow_import);
        assert!(!build_args(&p, Path::new("/o")).iter().any(|a| a.contains("follow")));
        let p: RunParams = serde_json::from_str(r#"{"project":"p","video":"v.mp4","bbox":[1,2,3,4],"pbf":"x.pbf","resume":true}"#).unwrap();
        assert!(!p.follow_import && p.resume);
    }

    #[test]
    fn tool_checks_of_the_environment() {
        let t = tool_check("ffmpeg", None, "", true);
        assert!(t["ok"] == json!(false) && t["required"] == json!(true) && t["message"].as_str().unwrap().contains(&settings::install_hint("ffmpeg")));
        let t = tool_check("yt-dlp", None, "", false);
        assert!(t["ok"] == json!(false) && t["required"] == json!(false) && t["message"].as_str().unwrap().contains("optional"));
        let t = tool_check("yt-dlp", None, "/x/yt-dlp", false);
        assert!(t["message"].as_str().unwrap().contains("/x/yt-dlp") && t["path"] == json!("/x/yt-dlp"));
        // found tools carry their version; an old ffmpeg is a warning, not an error
        let d = std::env::temp_dir().join(format!("v2g-envtool-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let ff = d.join("ffmpeg");
        std::fs::write(&ff, "#!/bin/sh\necho 'ffmpeg version 4.4.1 Copyright (c) 2000-2021'\n").unwrap();
        std::fs::set_permissions(&ff, std::fs::Permissions::from_mode(0o755)).unwrap();
        let t = tool_check("ffmpeg", Some(ff.clone()), "", true);
        assert!(t["ok"] == json!(true) && t["version"] == json!("4.4.1") && t["warning"].as_str().unwrap().contains("alt"), "{t}");
        // the whole check has the keys of the UI contract and needs no Python outside developer mode
        let ctx = Ctx::new(d.join("data"), std::sync::Arc::new(|_, _| {}));
        let mut s = settings::load(&ctx);
        s.ffmpeg = ff.to_string_lossy().into();
        s.ytdlp = "/nonexistent/yt-dlp".into();
        settings::save(&ctx, &s).unwrap();
        let e = env_check(&ctx);
        for k in ["python", "rsm", "pipeline", "ffmpeg", "ffprobe", "ytdlp", "brew", "data_dir", "cache_dir", "dev_mode"] {
            assert!(!e[k].is_null(), "{k}");
        }
        assert_eq!((e["ffmpeg"]["ok"].as_bool(), e["ytdlp"]["ok"].as_bool(), e["ytdlp"]["required"].as_bool()), (Some(true), Some(false), Some(false)));
        assert!(e["brew"]["ok"].is_boolean());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn hint_copy_and_read_stay_inside_the_project() {
        let d = std::env::temp_dir().join(format!("v2g-hint-test-{}", std::process::id()));
        let ctx = Ctx::new(d.clone(), std::sync::Arc::new(|_, _| {}));
        std::fs::create_dir_all(ctx.project_dir("p1").unwrap()).unwrap();
        let src = d.join("tour.gpx");
        std::fs::write(&src, "<gpx><trk><trkseg><trkpt lat=\"1\" lon=\"2\"/></trkseg></trk></gpx>").unwrap();
        let r = hint_import(&ctx, "p1", src.to_str().unwrap()).unwrap();
        assert_eq!(r["name"], "tour.gpx");
        let path = r["path"].as_str().unwrap().to_string();
        assert!(hint_read(&ctx, "p1", &path).unwrap().contains("trkpt"));
        assert!(hint_read(&ctx, "p1", src.to_str().unwrap()).is_err());
        assert!(hint_import(&ctx, "p1", d.join("x.txt").to_str().unwrap()).is_err());
        hint_remove(&ctx, "p1").unwrap();
        assert!(hint_read(&ctx, "p1", &path).is_err());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn reroute_args_waypoints_and_reset() {
        let a = reroute_args(Path::new("/o"), Some(r#"{"vias":[]}"#), false);
        assert_eq!(a, vec!["reroute", "--out", "/o", "--waypoints", r#"{"vias":[]}"#]);
        let b = reroute_args(Path::new("/o"), None, true);
        assert_eq!(b, vec!["reroute", "--out", "/o", "--reset"]);
    }
}

/// Start the pipeline as a child process in its own process group. Events go to `pipeline-event` (and to the project's
/// events.jsonl); the end goes to `pipeline-exit`.
pub fn start(ctx: &Ctx, mut p: RunParams) -> Result<(), String> {
    let s = require_env(ctx)?;
    if p.follow_import {
        // decided under the import lock: the end of the import takes the same lock before it looks for a waiting run
        let g = ctx.running.import.lock().unwrap();
        if g.as_ref().map(|(_, pr)| pr == &p.project).unwrap_or(false) {
            if !Path::new(&p.pbf).is_file() {
                return Err(format!("Kartendatei nicht gefunden: {}", p.pbf));
            }
            ctx.project_dir(&p.project)?;
            let mut q = ctx.running.queued_run.lock().unwrap();
            if q.is_some() || ctx.running.pipeline.lock().unwrap().is_some() {
                return Err("Es läuft bereits eine Berechnung".into());
            }
            ctx.running.pipeline_cancelled.store(false, Ordering::SeqCst);
            let project = p.project.clone();
            *q = Some(p);
            drop(q);
            drop(g);
            let last = ctx.running.import_progress.lock().unwrap().clone().unwrap_or(Value::Null);
            ctx.emit("pipeline-event", json!({"project": project, "event": input_event("growing", &last)}));
            return Ok(());
        }
        p.follow_import = false; // no import (any more): an ordinary start with the given video
    }
    if !Path::new(&p.video).is_file() {
        return Err(format!("Video nicht gefunden: {}", p.video));
    }
    if !Path::new(&p.pbf).is_file() {
        return Err(format!("Kartendatei nicht gefunden: {}", p.pbf));
    }
    let pdir = ctx.project_dir(&p.project)?;
    let out = pdir.join("out");
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    write_anchors(&p, &out)?;
    {
        let mut g = ctx.running.pipeline.lock().unwrap();
        if g.is_some() {
            return Err("Es läuft bereits eine Berechnung".into());
        }
        let events_path = pdir.join("events.jsonl");
        let log = std::sync::Arc::new(std::sync::Mutex::new(std::fs::File::create(&events_path).map_err(|e| e.to_string())?));
        let mut cmd = pipeline_cmd(ctx, &s);
        cmd.args(build_args(&p, &out));
        let mut child = proc::spawn_group(&mut cmd).map_err(|e| format!("Python konnte nicht gestartet werden: {e}"))?;
        let pgid = child.id() as i32;
        *g = Some((pgid, p.project.clone()));
        ctx.running.pipeline_cancelled.store(false, Ordering::SeqCst);
        let (so, se) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let (c1, l1, proj1) = (ctx.clone(), log.clone(), p.project.clone());
        let t1 = std::thread::spawn(move || {
            proc::read_lines(so, |line| {
                let ev: Value = serde_json::from_str(&line).unwrap_or_else(|_| json!({"type": "log", "level": "info", "message": line}));
                let _ = writeln!(l1.lock().unwrap(), "{}", ev);
                c1.emit("pipeline-event", json!({"project": proj1, "event": ev}));
            })
        });
        let (c2, l2, proj2) = (ctx.clone(), log.clone(), p.project.clone());
        let t2 = std::thread::spawn(move || {
            proc::read_lines(se, |line| {
                let ev = json!({"type": "log", "level": "stderr", "message": line});
                let _ = writeln!(l2.lock().unwrap(), "{}", ev);
                c2.emit("pipeline-event", json!({"project": proj2, "event": ev}));
            })
        });
        let (c3, proj3) = (ctx.clone(), p.project.clone());
        std::thread::spawn(move || {
            let status = child.wait();
            let _ = t1.join();
            let _ = t2.join();
            *c3.running.pipeline.lock().unwrap() = None;
            let cancelled = c3.running.pipeline_cancelled.load(Ordering::SeqCst);
            let code = status.as_ref().ok().and_then(|s| s.code());
            let ev = json!({"type": "exit", "code": code, "cancelled": cancelled});
            let _ = writeln!(log.lock().unwrap(), "{}", ev);
            c3.emit("pipeline-exit", json!({"project": proj3, "code": code, "cancelled": cancelled}));
        });
    }
    Ok(())
}

/// The project whose run is going on, or waits for its import.
pub fn status(ctx: &Ctx) -> Option<String> {
    let running = ctx.running.pipeline.lock().unwrap().as_ref().map(|(_, p)| p.clone());
    running.or_else(|| ctx.running.queued_run.lock().unwrap().as_ref().map(|p| p.project.clone()))
}

/// `{type: "input"}`: how much of the video the import has delivered (`pct` in percent, null when the command does not say).
fn input_event(state: &str, progress: &Value) -> Value {
    json!({"type": "input", "state": state, "pct": progress["pct"], "bytes": progress["bytes"].as_u64().unwrap_or(0), "total": progress["total"]})
}

/// Called by the import for every progress it publishes: passed on to a run that waits for this import.
pub(crate) fn import_progress(ctx: &Ctx, project: &str, progress: &crate::import::Progress) {
    if ctx.running.queued_run.lock().unwrap().as_ref().map(|p| p.project == project).unwrap_or(false) {
        ctx.emit("pipeline-event", json!({"project": project, "event": input_event("growing", &progress.to_json(project))}));
    }
}

/// Called at the end of an import: a run that waited for it starts with the imported file, or ends with the import's error.
pub(crate) fn import_finished(ctx: &Ctx, project: &str, file: Option<&Path>, error: Option<&str>, cancelled: bool) {
    let queued = {
        let _g = ctx.running.import.lock().unwrap();
        let mut q = ctx.running.queued_run.lock().unwrap();
        if q.as_ref().map(|p| p.project == project).unwrap_or(false) { q.take() } else { None }
    };
    let Some(mut p) = queued else { return };
    let result = match file {
        Some(f) => {
            let size = std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
            ctx.emit("pipeline-event", json!({"project": project, "event": {"type": "input", "state": "complete", "pct": 100.0, "bytes": size, "total": size}}));
            p.video = f.to_string_lossy().to_string();
            p.follow_import = false;
            start(ctx, p)
        }
        None => Err(format!("Der Import ist fehlgeschlagen: {}", error.unwrap_or("unbekannter Fehler"))),
    };
    if let Err(e) = result {
        if !cancelled {
            ctx.emit("pipeline-event", json!({"project": project, "event": {"type": "log", "level": "error", "message": e}}));
        }
        ctx.emit("pipeline-exit", json!({"project": project, "code": null, "cancelled": cancelled}));
    }
}

/// SIGTERM to the pipeline's process group (the pipeline stops its step and exits 130), SIGKILL after 15 s.
pub fn cancel(ctx: &Ctx) -> bool {
    if let Some(p) = ctx.running.queued_run.lock().unwrap().take() {
        // the run only waited for its import: nothing to stop (the import goes on)
        ctx.emit("pipeline-exit", json!({"project": p.project, "code": null, "cancelled": true}));
        return true;
    }
    let g = ctx.running.pipeline.lock().unwrap().clone();
    let Some((pgid, _)) = g else { return false };
    ctx.running.pipeline_cancelled.store(true, Ordering::SeqCst);
    proc::kill_group(pgid, libc::SIGTERM);
    let ctx2 = ctx.clone();
    std::thread::spawn(move || {
        for _ in 0..30 {
            std::thread::sleep(Duration::from_millis(500));
            if ctx2.running.pipeline.lock().unwrap().is_none() {
                return;
            }
        }
        proc::kill_group(pgid, libc::SIGKILL);
    });
    true
}

/// `rsm.pipeline retime DIR --start-time ...`: rewrites <time> in route.gpx only. Returns the `result` line.
pub fn retime(ctx: &Ctx, project: &str, start_time: &str) -> Result<Value, String> {
    let s = require_env(ctx)?;
    let out = ctx.project_dir(project)?.join("out");
    let o = pipeline_cmd(ctx, &s)
        .arg("retime")
        .arg(&out)
        .args(["--start-time", start_time])
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&o.stdout);
    let result = stdout.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|v| v["type"] == "result").last();
    if !o.status.success() || result.is_none() {
        let err = stdout.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|v| v["level"] == "error").map(|v| v["message"].as_str().unwrap_or("").to_string()).last();
        return Err(format!("Zeit ändern fehlgeschlagen (Code {:?}): {}", o.status.code(), err.unwrap_or_else(|| String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or("").to_string())));
    }
    Ok(result.unwrap())
}

pub fn reroute_args(out: &Path, waypoints_json: Option<&str>, reset: bool) -> Vec<String> {
    let mut a = vec!["reroute".to_string(), "--out".to_string(), out.to_string_lossy().into()];
    if reset {
        a.push("--reset".to_string());
    } else if let Some(w) = waypoints_json {
        a.extend(["--waypoints".to_string(), w.to_string()]);
    }
    a
}

/// `rsm.pipeline reroute --out OUT (--waypoints JSON | --reset)`: fast interactive route adjustment + timeline fit.
pub fn reroute(ctx: &Ctx, project: &str, waypoints: Option<Value>, reset: bool) -> Result<Value, String> {
    let s = require_env(ctx)?;
    let out = ctx.project_dir(project)?.join("out");
    let wp_str = if reset {
        None
    } else {
        let v = waypoints.ok_or_else(|| "Keine Wegpunkte angegeben.".to_string())?;
        Some(serde_json::to_string(&v).map_err(|e| e.to_string())?)
    };
    let o = pipeline_cmd(ctx, &s)
        .args(reroute_args(&out, wp_str.as_deref(), reset))
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&o.stdout);
    let result = stdout.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|v| v["type"] == "result").last();
    if !o.status.success() || result.is_none() {
        let err = stdout.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|v| v["level"] == "error").map(|v| v["message"].as_str().unwrap_or("").to_string()).last();
        return Err(err.unwrap_or_else(|| format!("Route neu berechnen fehlgeschlagen (Code {:?}): {}", o.status.code(), String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or(""))));
    }
    Ok(result.unwrap())
}
