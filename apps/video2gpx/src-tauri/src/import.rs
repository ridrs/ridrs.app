//! Import by template (APP_SPEC 8.2, DECISIONS P2): a template is one command line with placeholders. It is split into
//! words by quoting rules only, and the URL or path the user typed is put into the words after the split. No shell runs at
//! any point, so the typed text can never become code or a second argument. The command runs only on the user's click, in
//! the project's import folder, in its own process group; exactly one new video file counts as success.
use crate::ctx::Ctx;
use crate::proc;
use crate::settings::{self, Accepts, ImportTemplate, Settings};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const VIDEO_EXT: &[&str] = &["mp4", "mkv", "mov", "webm", "m4v", "avi", "mpg", "mpeg", "ts", "mts", "m2ts", "wmv"];
const MAX_URL: usize = 2048;
/// at most 4 `import-progress` events per second
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
const TAIL_LINES: usize = 20;

// ---------- files ----------

/// Unfinished or intermediate files of a downloader: `*.part`, `*.ytdl`, `*.temp.*`, `*.f<digits>.*` (one stream before the merge).
pub fn is_intermediate(name: &str) -> bool {
    let n = name.to_lowercase();
    if n.ends_with(".part") || n.ends_with(".ytdl") || n.contains(".temp.") || n.contains(".part-") {
        return true;
    }
    let parts: Vec<&str> = n.split('.').collect();
    parts.len() >= 3 && parts[1..parts.len() - 1].iter().any(|p| p.len() > 1 && p.starts_with('f') && p[1..].chars().all(|c| c.is_ascii_digit()))
}

/// Finished video files of a folder (by extension, without intermediate files), sorted.
pub fn list_videos(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().is_file())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| !n.starts_with('.') && !is_intermediate(n))
                .filter(|n| Path::new(n).extension().map(|x| VIDEO_EXT.contains(&x.to_string_lossy().to_lowercase().as_str())).unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

// ---------- template ----------

/// Split one line into words: single quotes (literal), double quotes (backslash escapes `"`, `\`, `$` and the backtick),
/// backslash outside quotes. Nothing is expanded: `$VAR`, backticks, `*`, `;`, `|` and `>` are ordinary characters.
pub fn split(line: &str) -> Result<Vec<String>, String> {
    if line.chars().any(|c| c == '\n' || c == '\r' || c == '\0') {
        return Err("Die Vorlage muss eine einzige Zeile sein.".into());
    }
    let mut words = vec![];
    let mut cur = String::new();
    let mut open = false; // a word has begun (also an empty quoted one)
    let mut it = line.chars();
    while let Some(c) = it.next() {
        match c {
            ' ' | '\t' => {
                if open {
                    words.push(std::mem::take(&mut cur));
                    open = false;
                }
            }
            '\'' => {
                open = true;
                loop {
                    match it.next() {
                        Some('\'') => break,
                        Some(x) => cur.push(x),
                        None => return Err("Ein einfaches Anführungszeichen (') ist nicht geschlossen.".into()),
                    }
                }
            }
            '"' => {
                open = true;
                loop {
                    match it.next() {
                        Some('"') => break,
                        Some('\\') => match it.next() {
                            Some(x) if matches!(x, '"' | '\\' | '$' | '`') => cur.push(x),
                            Some(x) => {
                                cur.push('\\');
                                cur.push(x);
                            }
                            None => return Err("Ein doppeltes Anführungszeichen (\") ist nicht geschlossen.".into()),
                        },
                        Some(x) => cur.push(x),
                        None => return Err("Ein doppeltes Anführungszeichen (\") ist nicht geschlossen.".into()),
                    }
                }
            }
            '\\' => match it.next() {
                Some(x) => {
                    open = true;
                    cur.push(x);
                }
                None => return Err("Die Vorlage endet mit einem einzelnen Rückstrich (\\).".into()),
            },
            x => {
                open = true;
                cur.push(x);
            }
        }
    }
    if open {
        words.push(cur);
    }
    Ok(words)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slot {
    Url,
    Path,
    Input,
}

impl Slot {
    fn name(self) -> &'static str {
        match self {
            Slot::Url => "{url}",
            Slot::Path => "{path}",
            Slot::Input => "{input}",
        }
    }
    pub fn accepts(self) -> Accepts {
        match self {
            Slot::Url => Accepts::Url,
            Slot::Path => Accepts::Path,
            Slot::Input => Accepts::Any,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Piece {
    Lit(String),
    In,
    Out,
}

/// A valid template: its words as pieces, the one input placeholder it uses, and warnings.
#[derive(Clone, Debug)]
pub struct Parsed {
    words: Vec<Vec<Piece>>,
    pub slot: Slot,
    pub warnings: Vec<String>,
}

impl Parsed {
    /// the program as written in the template (first word; never contains a placeholder)
    pub fn program(&self) -> &str {
        match self.words[0].first() {
            Some(Piece::Lit(s)) => s,
            _ => "",
        }
    }

    /// The argument list after the program. Each value stays inside the word of its placeholder, whatever it contains.
    pub fn args(&self, input: &str, out: &str) -> Vec<String> {
        self.words[1..]
            .iter()
            .map(|w| {
                w.iter()
                    .map(|p| match p {
                        Piece::Lit(s) => s.as_str(),
                        Piece::In => input,
                        Piece::Out => out,
                    })
                    .collect::<String>()
            })
            .collect()
    }
}

fn pieces(word: &str, slots: &mut Vec<Slot>, has_out: &mut bool, errors: &mut Vec<String>) -> Vec<Piece> {
    let mut out = vec![];
    let mut lit = String::new();
    let mut it = word.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '{' if it.peek() == Some(&'{') => {
                it.next();
                lit.push('{');
            }
            '}' if it.peek() == Some(&'}') => {
                it.next();
                lit.push('}');
            }
            '}' => errors.push("Eine schließende Klammer } steht ohne Platzhalter da. Für eine Klammer im Befehl }} schreiben.".into()),
            '{' => {
                let mut name = String::new();
                let mut closed = false;
                for x in it.by_ref() {
                    if x == '}' {
                        closed = true;
                        break;
                    }
                    name.push(x);
                }
                if !closed {
                    errors.push("Eine öffnende Klammer { ist nicht geschlossen. Für eine Klammer im Befehl {{ schreiben.".into());
                    continue;
                }
                let piece = match name.as_str() {
                    "url" => Some(Slot::Url),
                    "path" => Some(Slot::Path),
                    "input" => Some(Slot::Input),
                    "out" => None,
                    _ => {
                        errors.push(format!("Unbekannter Platzhalter {{{name}}}. Möglich sind {{input}}, {{url}}, {{path}} und {{out}}."));
                        continue;
                    }
                };
                if !lit.is_empty() {
                    out.push(Piece::Lit(std::mem::take(&mut lit)));
                }
                match piece {
                    Some(s) => {
                        slots.push(s);
                        out.push(Piece::In);
                    }
                    None => {
                        *has_out = true;
                        out.push(Piece::Out);
                    }
                }
            }
            x => lit.push(x),
        }
    }
    if !lit.is_empty() {
        out.push(Piece::Lit(lit));
    }
    out
}

/// Check a template (also on every keystroke of the editor). Errors are German sentences for the user.
pub fn parse(template: &str) -> Result<Parsed, Vec<String>> {
    let words = split(template.trim()).map_err(|e| vec![e])?;
    if words.is_empty() {
        return Err(vec!["Die Vorlage ist leer.".into()]);
    }
    let (mut slots, mut has_out, mut errors) = (vec![], false, vec![]);
    let parsed: Vec<Vec<Piece>> = words.iter().map(|w| pieces(w, &mut slots, &mut has_out, &mut errors)).collect();
    if parsed[0].len() != 1 || !matches!(parsed[0][0], Piece::Lit(_)) {
        errors.push("Das erste Wort ist das Programm. Es darf keinen Platzhalter enthalten und nicht leer sein.".into());
    }
    let mut kinds = slots.clone();
    kinds.dedup();
    kinds.sort_by_key(|s| s.name());
    kinds.dedup();
    match kinds.len() {
        0 => errors.push("Der Platzhalter {input} fehlt.".into()),
        1 => {}
        _ => errors.push(format!("Nur einer der Platzhalter {} darf vorkommen.", kinds.iter().map(|s| s.name()).collect::<Vec<_>>().join(", "))),
    }
    if !errors.is_empty() {
        errors.dedup();
        return Err(errors);
    }
    let mut warnings = vec![];
    if !has_out {
        warnings.push("Der Platzhalter {out} fehlt: der Befehl läuft im Import-Ordner des Projekts und muss die Datei dort ablegen.".into());
    }
    Ok(Parsed { words: parsed, slot: kinds[0], warnings })
}

// ---------- input ----------

#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    Url(String),
    Path(PathBuf),
}

impl Input {
    pub fn kind(&self) -> &'static str {
        match self {
            Input::Url(_) => "url",
            Input::Path(_) => "path",
        }
    }
    pub fn value(&self) -> String {
        match self {
            Input::Url(u) => u.clone(),
            Input::Path(p) => p.to_string_lossy().to_string(),
        }
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// What the user typed: an http(s) URL, or an existing local file (absolute, `~/…` or `file://…`). Everything else is
/// refused with a reason, in particular a text that starts with `-` (a program would read it as an option).
pub fn classify(text: &str) -> Result<Input, String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("Bitte eine Adresse (URL) oder einen Dateipfad eingeben.".into());
    }
    if t.starts_with('-') {
        return Err("Die Eingabe darf nicht mit einem Bindestrich beginnen.".into());
    }
    if t.chars().any(|c| c.is_control()) {
        return Err("Die Eingabe enthält Steuerzeichen (zum Beispiel einen Zeilenumbruch).".into());
    }
    let lower = t.to_ascii_lowercase(); // same byte offsets as `t`
    if lower.starts_with("http://") || lower.starts_with("https://") {
        if t.len() > MAX_URL {
            return Err(format!("Die Adresse ist zu lang (über {MAX_URL} Zeichen)."));
        }
        if t.chars().any(|c| c.is_whitespace()) {
            return Err("Eine Adresse (URL) darf keine Leerzeichen enthalten.".into());
        }
        let rest = &t[t.find("://").unwrap() + 3..];
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        let host = host.rsplit('@').next().unwrap_or("");
        if host.is_empty() || host.starts_with(':') {
            return Err("In der Adresse fehlt der Servername.".into());
        }
        return Ok(Input::Url(t.to_string()));
    }
    let mut p = t.to_string();
    if let Some(r) = lower.strip_prefix("file://").map(|r| &t[t.len() - r.len()..]) {
        let r = r.strip_prefix("localhost").unwrap_or(r);
        if !r.starts_with('/') {
            return Err("Eine file://-Adresse muss auf einen absoluten Pfad zeigen.".into());
        }
        p = percent_decode(r).ok_or("Die file://-Adresse ist nicht lesbar kodiert.")?;
    } else if lower.contains("://") {
        return Err("Nur Adressen mit http:// oder https:// werden angenommen.".into());
    } else if p == "~" || p.starts_with("~/") {
        let home = std::env::var("HOME").map_err(|_| "Der Benutzerordner (~) ist unbekannt.")?;
        p = format!("{home}{}", &p[1..]);
    }
    if !p.starts_with('/') {
        return Err("Das ist weder eine Adresse (http:// oder https://) noch ein absoluter Dateipfad.".into());
    }
    let path = std::fs::canonicalize(&p).map_err(|_| format!("Datei nicht gefunden: {p}"))?;
    if !path.is_file() {
        return Err(format!("Das ist keine Datei: {}", path.display()));
    }
    Ok(Input::Path(path))
}

// ---------- templates, preview ----------

/// Shipped with the app: one neutral example. No downloader template is shipped (DECISIONS P2); users write their own.
pub fn builtin_templates() -> Vec<ImportTemplate> {
    vec![ImportTemplate { id: "cp".into(), name: "Kopieren (cp)".into(), template: "cp -- {input} {out}/".into(), builtin: true, accepts: Accepts::Path, tool: None }]
}

fn tool_of(program: &str) -> Option<&'static str> {
    match Path::new(program).file_name().and_then(|n| n.to_str()) {
        Some("yt-dlp") => Some("yt-dlp"),
        Some("ffmpeg") => Some("ffmpeg"),
        Some("ffprobe") => Some("ffprobe"),
        _ => None,
    }
}

/// Built-in templates, then the user's (from the settings). `accepts` and `tool` are derived from the command where it says so.
pub fn templates(s: &Settings) -> Vec<ImportTemplate> {
    let mut all = builtin_templates();
    for t in &s.import_templates {
        if t.id.is_empty() || all.iter().any(|b| b.id == t.id) {
            continue;
        }
        let mut t = t.clone();
        t.builtin = false;
        if let Ok(p) = parse(&t.template) {
            if p.slot != Slot::Input {
                t.accepts = p.slot.accepts();
            }
            t.tool = tool_of(p.program()).map(String::from);
        }
        all.push(t);
    }
    all
}

/// One word as a shell would need it written, for display only.
pub fn quote(word: &str) -> String {
    if !word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c)) {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

pub fn display(argv: &[String]) -> String {
    argv.iter().map(|w| quote(w)).collect::<Vec<_>>().join(" ")
}

/// The program of a template: a path as written (`~/` expanded), the tools of the settings, else the search of `find_tool`.
fn program_path(s: &Settings, program: &str) -> Option<PathBuf> {
    if program.contains('/') {
        let p = match program.strip_prefix("~/") {
            Some(r) => PathBuf::from(std::env::var("HOME").ok()?).join(r),
            None => PathBuf::from(program),
        };
        return Some(p).filter(|p| p.is_absolute() && settings::is_exec(p));
    }
    match program {
        "yt-dlp" => settings::ytdlp(s),
        "ffmpeg" => settings::ffmpeg(s),
        "ffprobe" => settings::ffprobe(s),
        _ => settings::find_tool("", program),
    }
}

/// The result of checking a template against an input: what the UI shows (`ImportResolved`) and, without errors, what runs.
#[derive(Clone, Debug, Default)]
pub struct Resolved {
    /// the exact argument list, program first (resolved to its full path when found)
    pub argv: Vec<String>,
    pub display: String,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub tool: Option<Value>,
}

impl Resolved {
    pub fn to_json(&self) -> Value {
        json!({"display": self.display, "errors": self.errors, "warnings": self.warnings, "argv": self.argv, "tool": self.tool})
    }
}

/// Check and fill a template. `accepts` is the template's declared input kind (None: as its placeholder says).
pub fn resolve(s: &Settings, template: &str, accepts: Option<Accepts>, input: &str, out: &Path) -> Resolved {
    let mut r = Resolved::default();
    let parsed = match parse(template) {
        Ok(p) => p,
        Err(e) => {
            r.errors = e;
            r.display = template.trim().to_string();
            return r;
        }
    };
    r.warnings = parsed.warnings.clone();
    let value = match classify(input) {
        Ok(i) => {
            let want = if parsed.slot == Slot::Input { accepts.unwrap_or(Accepts::Any) } else { parsed.slot.accepts() };
            match (&i, want) {
                (Input::Path(_), Accepts::Url) => r.errors.push("Diese Vorlage erwartet eine Adresse (URL), keinen Dateipfad.".into()),
                (Input::Url(_), Accepts::Path) => r.errors.push("Diese Vorlage erwartet einen Dateipfad, keine Adresse (URL).".into()),
                _ => {}
            }
            i.value()
        }
        Err(e) => {
            r.errors.push(e);
            input.trim().chars().filter(|c| !c.is_control()).collect()
        }
    };
    let program = parsed.program().to_string();
    let found = program_path(s, &program);
    if let Some(name) = tool_of(&program) {
        r.tool = Some(match &found {
            Some(p) => {
                let mut t = json!({"ok": true, "path": p});
                if let Some(v) = settings::tool_version(p, name) {
                    t["version"] = json!(v);
                }
                t
            }
            None => json!({"ok": false, "message": format!("{name} nicht gefunden")}),
        });
    }
    if found.is_none() {
        r.errors.push(format!("Programm nicht gefunden: {program}"));
    }
    r.argv = vec![found.map(|p| p.to_string_lossy().to_string()).unwrap_or(program)];
    r.argv.extend(parsed.args(&value, &out.to_string_lossy()));
    r.display = display(&r.argv);
    r
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct ImportRequest {
    /// id of a stored or built-in template
    pub template_id: String,
    /// URL or path, as typed
    pub input: String,
}

fn import_dir(ctx: &Ctx, project: Option<&str>) -> Result<PathBuf, String> {
    match project {
        Some(p) => Ok(ctx.project_dir(p)?.join("import")),
        None => Ok(ctx.projects_dir().join("Projekt").join("import")), // sample folder for a preview without a project
    }
}

/// `importResolve`: a stored template with an input, for the line shown before the run.
pub fn resolve_request(ctx: &Ctx, project: Option<&str>, req: &ImportRequest) -> Result<Resolved, String> {
    let s = settings::load(ctx);
    let dir = import_dir(ctx, project)?;
    Ok(match templates(&s).into_iter().find(|t| t.id == req.template_id) {
        Some(t) => resolve(&s, &t.template, Some(t.accepts), &req.input, &dir),
        None => Resolved { errors: vec![format!("Die Import-Vorlage „{}“ gibt es nicht (mehr).", req.template_id)], ..Default::default() },
    })
}

/// `importPreview`: a template text from the editor, before it is saved.
pub fn preview(ctx: &Ctx, template: &str, input: &str) -> Result<Resolved, String> {
    Ok(resolve(&settings::load(ctx), template, None, input, &import_dir(ctx, None)?))
}

// ---------- progress ----------

fn parse_size(s: &str) -> Option<f64> {
    let s = s.trim().trim_start_matches('~').trim();
    let n = s.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(s.len());
    let v: f64 = s[..n].parse().ok()?;
    let unit: String = s[n..].trim().chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let binary = unit.contains('i');
    let k: f64 = if binary { 1024.0 } else { 1000.0 };
    let f = match unit.chars().next().map(|c| c.to_ascii_uppercase()) {
        None | Some('B') => 1.0,
        Some('K') => k,
        Some('M') => k * k,
        Some('G') => k * k * k,
        Some('T') => k * k * k * k,
        _ => return None,
    };
    Some(v * f)
}

fn parse_clock(s: &str) -> Option<u64> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    parts.iter().try_fold(0u64, |acc, p| p.parse::<u64>().ok().map(|v| acc * 60 + v))
}

/// The last `NN.N%` of a line (0–100).
fn last_percent(line: &str) -> Option<f64> {
    let mut best = None;
    for (i, _) in line.match_indices('%') {
        let head = &line[..i];
        let start = head.rfind(|c: char| !(c.is_ascii_digit() || c == '.')).map(|j| j + head[j..].chars().next().map(|c| c.len_utf8()).unwrap_or(1)).unwrap_or(0);
        if let Ok(v) = head[start..].parse::<f64>() {
            if (0.0..=100.0).contains(&v) {
                best = Some(v);
            }
        }
    }
    best
}

fn after<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.find(key).map(|i| line[i + key.len()..].trim_start())
}

fn first_word(s: &str) -> &str {
    s.split_whitespace().next().unwrap_or("")
}

/// Title from a downloader's file name: without folder, extension, a stream marker (`.f399`) and a trailing `[id]`.
pub fn title_from(path: &str) -> Option<String> {
    let name = Path::new(path).file_name()?.to_string_lossy().to_string();
    let name = name.strip_suffix(".part").unwrap_or(&name);
    let mut stem = Path::new(name).file_stem()?.to_string_lossy().to_string();
    if let Some(i) = stem.rfind(".f") {
        if stem.len() > i + 2 && stem[i + 2..].chars().all(|c| c.is_ascii_digit()) {
            stem.truncate(i);
        }
    }
    let t = stem.trim_end();
    let t = match (t.ends_with(']'), t.rfind(" [")) {
        (true, Some(i)) if !t[i + 2..t.len() - 1].contains(' ') => t[..i].trim_end(),
        _ => t,
    };
    Some(t.to_string()).filter(|t| !t.is_empty())
}

/// Progress read from the output of the import command: yt-dlp's `[download]` lines (several streams add up), or the last
/// percentage of a line (curl -#, wget, aria2, rsync). Output without either leaves everything empty; the caller then
/// counts the bytes of the growing file.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Progress {
    /// "starting" | "downloading" | "finishing"
    pub phase: &'static str,
    pub pct: Option<f64>,
    pub bytes: Option<u64>,
    pub total: Option<u64>,
    pub rate: Option<f64>,
    pub eta_s: Option<u64>,
    pub title: Option<String>,
    pub file: Option<String>,
    /// bytes of the streams that are complete, and of the current one
    done_prev: f64,
    cur_total: Option<f64>,
    cur_bytes: f64,
}

impl Progress {
    pub fn new() -> Self {
        Progress { phase: "starting", ..Default::default() }
    }

    /// Feed one output line; true when something changed.
    pub fn feed(&mut self, line: &str) -> bool {
        let before = self.clone();
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("[download]") {
            let rest = rest.trim();
            if let Some(dest) = rest.strip_prefix("Destination:") {
                self.done_prev += self.cur_total.unwrap_or(self.cur_bytes);
                self.cur_total = None;
                self.cur_bytes = 0.0;
                self.set_file(dest.trim());
                self.phase = "downloading";
                self.rate = None;
                self.eta_s = None;
            } else if let Some(f) = rest.strip_suffix("has already been downloaded") {
                self.set_file(f.trim());
                self.phase = "finishing";
            } else if let Some(pct) = last_percent(rest) {
                self.phase = "downloading";
                let total = after(rest, " of ").and_then(|s| {
                    let s = s.trim_start_matches('~').trim_start();
                    parse_size(first_word(s))
                });
                if let Some(t) = total {
                    self.cur_total = Some(t);
                    self.cur_bytes = t * pct / 100.0;
                    let (b, tt) = (self.done_prev + self.cur_bytes, self.done_prev + t);
                    self.bytes = Some(b as u64);
                    self.total = Some(tt as u64);
                    self.pct = Some(if tt > 0.0 { (100.0 * b / tt).min(100.0) } else { pct });
                } else {
                    self.pct = Some(pct);
                }
                self.rate = after(rest, " at ").map(first_word).and_then(|w| w.strip_suffix("/s")).and_then(parse_size);
                self.eta_s = after(rest, "ETA ").map(first_word).and_then(parse_clock);
            }
        } else if ["[Merger]", "[VideoRemuxer]", "[VideoConvertor]", "[ExtractAudio]", "[Fixup", "[Metadata]", "[MoveFiles]", "[EmbedSubtitle]", "[EmbedThumbnail]"].iter().any(|p| l.starts_with(p)) {
            self.phase = "finishing";
            self.rate = None;
            self.eta_s = None;
            if let Some(f) = after(l, "Merging formats into \"").and_then(|s| s.strip_suffix('"')) {
                self.set_file(f);
            }
        } else if let Some(pct) = last_percent(l) {
            self.phase = "downloading";
            self.pct = Some(pct);
        }
        *self != before
    }

    fn set_file(&mut self, f: &str) {
        if f.is_empty() {
            return;
        }
        self.file = Some(f.to_string());
        if self.title.is_none() {
            self.title = title_from(f);
        }
    }

    /// The command reports no sizes: take the bytes of the growing file, and with a percentage the total that follows from both.
    pub fn observe_file(&mut self, file: &str, size: u64) -> bool {
        if self.cur_total.is_some() {
            return false; // the command's own numbers are better
        }
        let before = self.clone();
        if self.file.is_none() {
            self.set_file(file);
        }
        if self.phase == "starting" && size > 0 {
            self.phase = "downloading";
        }
        self.bytes = Some(size);
        self.total = self.pct.filter(|p| *p >= 1.0 && size > 0).map(|p| (size as f64 * 100.0 / p) as u64);
        *self != before
    }

    /// `ImportProgress` of the UI contract. `processable` stays false: reading a growing file is not built (plan-speed 5.4 C).
    pub fn to_json(&self, project: &str) -> Value {
        json!({"project": project, "phase": self.phase, "pct": self.pct, "bytes": self.bytes, "total": self.total, "rate": self.rate,
            "eta_s": self.eta_s, "title": self.title, "file": self.file, "processable": false})
    }
}

// ---------- run ----------

struct Tracker {
    progress: Progress,
    last_emit: Option<Instant>,
    tail: VecDeque<String>,
}

fn publish(ctx: &Ctx, project: &str, tr: &mut Tracker, force: bool) {
    if !force && tr.last_emit.map(|t| t.elapsed() < PROGRESS_EVERY).unwrap_or(false) {
        return;
    }
    tr.last_emit = Some(Instant::now());
    let v = tr.progress.to_json(project);
    *ctx.running.import_progress.lock().unwrap() = Some(v.clone());
    ctx.emit("import-progress", v);
    crate::pipeline::import_progress(ctx, project, &tr.progress);
}

fn on_line(ctx: &Ctx, project: &str, tracker: &Mutex<Tracker>, stream: &str, line: String) {
    let mut tr = tracker.lock().unwrap();
    let phase = tr.progress.phase;
    if tr.progress.feed(&line) {
        let force = tr.progress.phase != phase;
        publish(ctx, project, &mut tr, force);
    }
    if tr.tail.len() == TAIL_LINES {
        tr.tail.pop_front();
    }
    tr.tail.push_back(line.clone());
    drop(tr);
    ctx.emit("import-log", json!({"project": project, "stream": stream, "line": line}));
}

/// Newest file of the import folder that was not there before the command started.
fn growing_file(dir: &Path, before: &[String]) -> Option<(String, u64)> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| !before.contains(&e.file_name().to_string_lossy().to_string()) && !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            if !m.is_file() || e.file_name().to_string_lossy().ends_with(".ytdl") {
                return None;
            }
            Some((m.modified().ok()?, e.path().to_string_lossy().to_string(), m.len()))
        })
        .max_by_key(|x| x.0)
        .map(|x| (x.1, x.2))
}

fn all_files(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir).map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default()
}

/// Run a template only because the user clicked "Importieren". The working directory and `$OUT` are the project's import
/// folder; the program gets exactly the previewed arguments. Events: `import-progress`, `import-log`, `import-done`.
pub fn start(ctx: &Ctx, project: &str, req: &ImportRequest) -> Result<(), String> {
    let dir = ctx.project_dir(project)?.join("import");
    let r = resolve_request(ctx, Some(project), req)?;
    if !r.errors.is_empty() {
        return Err(r.errors.join(" "));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let before = list_videos(&dir);
    let before_all = all_files(&dir);
    let mut g = ctx.running.import.lock().unwrap();
    if g.is_some() {
        return Err("Ein Import läuft bereits".into());
    }
    let mut cmd = Command::new(&r.argv[0]);
    cmd.args(&r.argv[1..]).current_dir(&dir).env("OUT", &dir).env("PATH", settings::tool_path());
    let mut child = proc::spawn_group(&mut cmd).map_err(|e| format!("Der Befehl konnte nicht gestartet werden: {e}"))?;
    *g = Some((child.id() as i32, project.to_string()));
    drop(g);
    ctx.running.import_cancelled.store(false, Ordering::SeqCst);
    let tracker = Arc::new(Mutex::new(Tracker { progress: Progress::new(), last_emit: None, tail: VecDeque::new() }));
    publish(ctx, project, &mut tracker.lock().unwrap(), true);
    let finished = Arc::new(AtomicBool::new(false));
    let (so, se) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let (c1, p1, k1) = (ctx.clone(), project.to_string(), tracker.clone());
    let t1 = std::thread::spawn(move || proc::read_lines(so, |l| on_line(&c1, &p1, &k1, "stdout", l)));
    let (c2, p2, k2) = (ctx.clone(), project.to_string(), tracker.clone());
    let t2 = std::thread::spawn(move || proc::read_lines(se, |l| on_line(&c2, &p2, &k2, "stderr", l)));
    // commands that print no sizes: watch the growing file
    let (c4, p4, k4, f4, d4) = (ctx.clone(), project.to_string(), tracker.clone(), finished.clone(), dir.clone());
    std::thread::spawn(move || {
        while !f4.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(500));
            if let Some((file, size)) = growing_file(&d4, &before_all) {
                let mut tr = k4.lock().unwrap();
                if !f4.load(Ordering::SeqCst) && tr.progress.observe_file(&file, size) {
                    publish(&c4, &p4, &mut tr, false);
                }
            }
        }
    });
    let (c3, p3) = (ctx.clone(), project.to_string());
    std::thread::spawn(move || {
        let st = child.wait();
        let _ = t1.join();
        let _ = t2.join();
        finished.store(true, Ordering::SeqCst);
        let tail: Vec<String> = tracker.lock().unwrap().tail.iter().cloned().collect();
        *c3.running.import.lock().unwrap() = None;
        *c3.running.import_progress.lock().unwrap() = None;
        let cancelled = c3.running.import_cancelled.load(Ordering::SeqCst);
        let code = st.ok().and_then(|s| s.code());
        let after = list_videos(&dir);
        let new: Vec<&String> = after.iter().filter(|n| !before.contains(n)).collect();
        let mut file = None;
        let mut payload = if cancelled {
            json!({"ok": false, "cancelled": true, "error": "Abgebrochen"})
        } else if code != Some(0) {
            json!({"ok": false, "error": match code { Some(c) => format!("Der Befehl endete mit Code {c}."), None => "Der Befehl wurde von außen beendet.".to_string() }})
        } else if new.len() == 1 {
            file = Some(dir.join(new[0]));
            json!({"ok": true, "file": file})
        } else if new.is_empty() {
            json!({"ok": false, "error": "Der Befehl hat keine neue Videodatei im Import-Ordner abgelegt ({out})."})
        } else {
            json!({"ok": false, "error": format!("Es sind {} neue Videodateien entstanden ({}); erwartet wird genau eine.", new.len(), new.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "))})
        };
        payload["project"] = json!(p3);
        payload["code"] = json!(code);
        payload["tail"] = json!(tail);
        c3.emit("import-done", payload.clone());
        crate::pipeline::import_finished(&c3, &p3, file.as_deref(), payload["error"].as_str(), cancelled);
    });
    Ok(())
}

/// `importStatus`: the last progress of the running import, or None.
pub fn status(ctx: &Ctx) -> Option<Value> {
    if ctx.running.import.lock().unwrap().is_none() {
        return None;
    }
    ctx.running.import_progress.lock().unwrap().clone()
}

/// SIGTERM to the whole process group of the import command, SIGKILL after 3 s.
pub fn cancel(ctx: &Ctx) -> bool {
    let g = ctx.running.import.lock().unwrap().clone();
    let Some((pgid, _)) = g else { return false };
    ctx.running.import_cancelled.store(true, Ordering::SeqCst);
    proc::kill_group(pgid, libc::SIGTERM);
    let ctx2 = ctx.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        if ctx2.running.import.lock().unwrap().as_ref().map(|g| g.0) == Some(pgid) {
            proc::kill_group(pgid, libc::SIGKILL);
        }
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &str) -> Vec<String> {
        split(s).unwrap()
    }

    #[test]
    fn split_follows_quoting_rules_and_expands_nothing() {
        assert_eq!(words("cp  -- {input}\t{out}/"), ["cp", "--", "{input}", "{out}/"]);
        assert_eq!(words(r#"a "b c" 'd e' f\ g"#), ["a", "b c", "d e", "f g"]);
        assert_eq!(words(r#"x "a\"b\\c\$d\`e\nf" 'it'\''s'"#), ["x", r#"a"b\c$d`e\nf"#, "it's"]);
        assert_eq!(words(r#"p "" '' a""b"#), ["p", "", "", "ab"]);
        assert_eq!(words(r#"yt -f "bv*[height<=1080]+ba/b" -o "%(title).150B [%(id)s].%(ext)s""#), ["yt", "-f", "bv*[height<=1080]+ba/b", "-o", "%(title).150B [%(id)s].%(ext)s"]);
        // shell syntax is plain text
        assert_eq!(words("a ; rm -rf ~ | b > c && $HOME `id` $(id) *"), ["a", ";", "rm", "-rf", "~", "|", "b", ">", "c", "&&", "$HOME", "`id`", "$(id)", "*"]);
        assert!(words("").is_empty() && words("   ").is_empty());
        for bad in ["a 'b", "a \"b", "a \\", "a\nb", "a \"b\\"] {
            assert!(split(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn validation() {
        let p = parse("cp -- {input} {out}/").unwrap();
        assert_eq!((p.program(), p.slot, p.warnings.len()), ("cp", Slot::Input, 0));
        assert_eq!(parse("tool {url} {out} {url}").unwrap().slot, Slot::Url);
        assert_eq!(parse("/bin/cp {path} {out}").unwrap().slot.accepts(), Accepts::Path);
        assert_eq!(parse("curl -O {url}").unwrap().warnings.len(), 1); // {out} missing: allowed
        let err = |t: &str| parse(t).unwrap_err().join(" | ");
        assert!(err("").contains("leer"));
        assert!(err("cp a {out}").contains("{input} fehlt"));
        assert!(err("{input} a").contains("erste Wort"));
        assert!(err("x{out} {input}").contains("erste Wort"));
        assert!(err("'' {input}").contains("erste Wort"));
        assert!(err("cp {url} {path}").contains("Nur einer"));
        assert!(err("cp {input} {url}").contains("Nur einer"));
        assert!(err("cp {input} {OUT}").contains("Unbekannter Platzhalter {OUT}"));
        assert!(err("cp {input} {}").contains("Unbekannter Platzhalter {}"));
        assert!(err("cp {input} {out").contains("nicht geschlossen"));
        assert!(err("cp {input} out}").contains("schließende Klammer"));
        assert!(err("cp '{input}").contains("Anführungszeichen"));
        // literal braces
        let p = parse("tool --fmt {{a}}{input}{{ {out}").unwrap();
        assert_eq!(p.args("X", "/o"), ["--fmt", "{a}X{", "/o"]);
    }

    /// Whatever the value contains, it stays one argument, in the word of its placeholder.
    #[test]
    fn values_never_split_or_run() {
        let p = parse(r#"prog -o "{out}/%(title)s.%(ext)s" --ref=x:{input} -- {input}"#).unwrap();
        for evil in ["'; rm -rf ~ #", "$(touch /tmp/pwned)", "`id`", "a b  c", "x\" -o \"/etc", "a\nb", "-rf", "; reboot", "{out}", "{input}", "a'b\"c\\d", "$HOME/*", "http://h/?a=1&b=2;c|d>e"] {
            let a = p.args(evil, "/out dir");
            assert_eq!(a.len(), 5, "{evil:?}");
            assert_eq!(a[0], "-o");
            assert_eq!(a[1], "/out dir/%(title)s.%(ext)s");
            assert_eq!(a[2], format!("--ref=x:{evil}"));
            assert_eq!(a[3], "--");
            assert_eq!(a[4], evil);
        }
    }

    /// The same through a real process: a hostile value arrives as one argument, byte for byte, and nothing of it is executed.
    #[test]
    fn hostile_value_reaches_the_program_as_one_argument() {
        let d = std::env::temp_dir().join(format!("v2g-import-argv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let marker = d.join("pwned");
        let evil = format!("x'; touch '{m}'; $(touch '{m}') `touch '{m}'` | touch {m} & \"", m = marker.display());
        let p = parse("/bin/sh -c 'printf \"%s|%s\" \"$#\" \"$1\"' sh {input}").unwrap();
        let o = Command::new(p.program()).args(p.args(&evil, "/o")).current_dir(&d).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&o.stdout), format!("1|{evil}"));
        assert!(!marker.exists());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn input_classification() {
        assert_eq!(classify(" https://example.org/v?id=1&x=a;b ").unwrap(), Input::Url("https://example.org/v?id=1&x=a;b".into()));
        assert_eq!(classify("HTTP://user@Example.org:8080/a").unwrap().kind(), "url");
        for bad in [
            "", "   ", "-o/etc/passwd", "--exec=id", "- https://a.b/", "https://", "https:///path", "http://:80/", "https://a.b/c d",
            "https://a.b/\nc", "https://a.b/\u{7}", "ftp://a.b/c", "file:c", "javascript://x", "ssh://host/x", "'; rm -rf ~ #", "$(id)", "`id`",
            "relative/file.mp4", "/nonexistent/v2g/video.mp4", "file://server/share/x.mp4", "file:///nonexistent/v2g.mp4", "/tmp",
        ] {
            assert!(classify(bad).is_err(), "{bad:?} -> {:?}", classify(bad));
        }
        assert!(classify(&format!("https://a.b/{}", "x".repeat(MAX_URL))).is_err());
        // local files: absolute, file://, percent-encoded, ~/ ; the result is the canonical path
        let d = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("v2g-import-cls-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("my ride; $(x).mp4");
        std::fs::write(&f, b"x").unwrap();
        assert_eq!(classify(f.to_str().unwrap()).unwrap(), Input::Path(f.clone()));
        assert_eq!(classify(&format!("{}/../{}/my ride; $(x).mp4", d.display(), d.file_name().unwrap().to_string_lossy())).unwrap(), Input::Path(f.clone()));
        assert_eq!(classify(&format!("file://{}", f.display()).replace(' ', "%20")).unwrap(), Input::Path(f.clone()));
        assert_eq!(classify(&format!("file://localhost{}", f.display())).unwrap(), Input::Path(f.clone()));
        assert!(classify(&format!("file://{}/%zz", d.display())).is_err());
        assert!(classify(d.to_str().unwrap()).is_err()); // a folder
        if let Ok(home) = std::env::var("HOME") {
            if let Ok(rel) = f.strip_prefix(std::fs::canonicalize(&home).unwrap_or_default()) {
                assert_eq!(classify(&format!("~/{}", rel.display())).unwrap(), Input::Path(f.clone()));
            }
        }
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn display_quotes_like_a_shell() {
        assert_eq!(quote("a-b_c.mp4"), "a-b_c.mp4");
        assert_eq!(quote(""), "''");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(display(&["/bin/cp".into(), "--".into(), "/a b/c.mp4".into(), "/o/$x".into()]), "/bin/cp -- '/a b/c.mp4' '/o/$x'");
        // the displayed line splits back into the same arguments
        let argv: Vec<String> = ["p", "a b", "it's", "$(x)", "", "é;|&"].iter().map(|s| s.to_string()).collect();
        assert_eq!(split(&display(&argv)).unwrap(), argv);
    }

    #[test]
    fn resolve_reports_what_runs_and_what_is_wrong() {
        let d = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("v2g-import-res-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("a b.mp4");
        std::fs::write(&f, b"x").unwrap();
        let s = Settings::default();
        let out = Path::new("/p/import");
        let r = resolve(&s, "cp -- {input} {out}/", Some(Accepts::Path), f.to_str().unwrap(), out);
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let cp = settings::find_tool("", "cp").unwrap().to_string_lossy().to_string();
        assert_eq!(r.argv, [cp.as_str(), "--", f.to_str().unwrap(), "/p/import/"]);
        assert_eq!(r.display, format!("{cp} -- '{}' /p/import/", f.display()));
        assert!(r.tool.is_none());
        // wrong kind of input, missing program, bad input: errors, and the line is still shown
        let r = resolve(&s, "cp -- {input} {out}/", Some(Accepts::Path), "https://a.b/c", out);
        assert!(r.errors.iter().any(|e| e.contains("Dateipfad")));
        let r = resolve(&s, "cp -- {url} {out}/", None, f.to_str().unwrap(), out);
        assert!(r.errors.iter().any(|e| e.contains("Adresse")));
        let r = resolve(&s, "v2g-no-such-program {input} {out}", None, "https://a.b/c", out);
        assert_eq!(r.errors, ["Programm nicht gefunden: v2g-no-such-program"]);
        assert_eq!(r.display, "v2g-no-such-program https://a.b/c /p/import");
        let r = resolve(&s, "/nonexistent/prog {input}", None, "https://a.b/c", out);
        assert!(r.errors.iter().any(|e| e.contains("/nonexistent/prog")) && r.warnings.len() == 1);
        let r = resolve(&s, "cp -- {input} {out}/", None, "-rf", out);
        assert!(r.errors.iter().any(|e| e.contains("Bindestrich")));
        let r = resolve(&s, "cp {input", None, "https://a.b/c", out);
        assert!(!r.errors.is_empty() && r.argv.is_empty());
        // a template for yt-dlp names its tool; with a wrong path in the settings it is reported as missing
        let mut s2 = Settings::default();
        s2.ytdlp = "/nonexistent/yt-dlp".into();
        let r = resolve(&s2, "yt-dlp -P {out} -- {url}", None, "https://a.b/c", out);
        assert_eq!(r.tool.as_ref().unwrap()["ok"], json!(false));
        assert!(r.errors.contains(&"Programm nicht gefunden: yt-dlp".to_string()));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn template_list_has_one_neutral_builtin_and_the_users() {
        let b = builtin_templates();
        assert_eq!(b.len(), 1);
        assert!(b[0].builtin && b[0].id == "cp" && b[0].accepts == Accepts::Path && b[0].tool.is_none());
        assert!(parse(&b[0].template).unwrap().warnings.is_empty());
        assert_eq!(Settings::default().import_default_copy, b[0].id);
        let mut s = Settings::default();
        let t = |id: &str, template: &str| ImportTemplate { id: id.into(), name: id.into(), template: template.into(), builtin: true, accepts: Accepts::Any, tool: None };
        s.import_templates = vec![t("mine", "yt-dlp -P {out} -- {url}"), t("cp", "rm -rf {input}"), t("", "x {input}"), t("any", "rsync {input} {out}/"), t("broken", "x {")];
        let all = templates(&s);
        assert_eq!(all.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["cp", "mine", "any", "broken"]);
        assert_eq!(all[0].template, b[0].template); // a stored template cannot replace the built-in
        assert!(!all[1].builtin && all[1].accepts == Accepts::Url && all[1].tool.as_deref() == Some("yt-dlp"));
        assert!(all[2].accepts == Accepts::Any && all[2].tool.is_none());
    }

    #[test]
    fn intermediate_files_are_not_results() {
        for n in ["a.mp4.part", "a.f399.mp4", "a.f251.webm", "a.temp.mp4", "a.mp4.ytdl", "A.F137.MP4", "a.mp4.part-Frag3"] {
            assert!(is_intermediate(n), "{n}");
        }
        for n in ["a.mp4", "ride.final.mkv", "a.fx.mp4", "f399.mp4", "a.f.mp4", "tour.f1 [x].mp4"] {
            assert!(!is_intermediate(n), "{n}");
        }
        let d = std::env::temp_dir().join(format!("v2g-import-list-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        for n in ["b.mkv", "a.mp4", "a.f399.mp4", "c.webm.part", "notes.txt", ".hidden.mp4"] {
            std::fs::write(d.join(n), b"x").unwrap();
        }
        assert_eq!(list_videos(&d), ["a.mp4", "b.mkv"]);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn sizes_clocks_percent_titles() {
        assert_eq!(parse_size("1.20GiB"), Some(1.2 * 1024.0 * 1024.0 * 1024.0));
        assert_eq!(parse_size("~3.4MiB"), Some(3.4 * 1024.0 * 1024.0));
        assert_eq!((parse_size("512B"), parse_size("2k"), parse_size("5MB"), parse_size("10")), (Some(512.0), Some(2000.0), Some(5e6), Some(10.0)));
        assert_eq!((parse_size("Unknown"), parse_size(""), parse_size("1.2XB")), (None, None, None));
        assert_eq!((parse_clock("00:12"), parse_clock("01:02:03"), parse_clock("7"), parse_clock("Unknown"), parse_clock("1:2:3:4")), (Some(12), Some(3723), Some(7), None, None));
        assert_eq!(last_percent("######                 12.3%"), Some(12.3));
        assert_eq!(last_percent(" 5% then 47%  1.2M/s"), Some(47.0));
        assert_eq!((last_percent("no progress"), last_percent("250% off"), last_percent("%"), last_percent("é 100%")), (None, None, None, Some(100.0)));
        assert_eq!(title_from("/x/Col de la Madone 4K [abcDEF12345].f399.mp4").as_deref(), Some("Col de la Madone 4K"));
        assert_eq!(title_from("/x/Tour [1] nach Rom.webm.part").as_deref(), Some("Tour [1] nach Rom"));
        assert_eq!(title_from("ride.mp4").as_deref(), Some("ride"));
        assert_eq!(title_from("/x/"), Some("x".to_string()));
    }

    /// Lines as yt-dlp prints them with `--newline` (video stream, audio stream, merge).
    #[test]
    fn progress_of_yt_dlp() {
        let gib = 1024.0 * 1024.0 * 1024.0;
        let mib = 1024.0 * 1024.0;
        let mut p = Progress::new();
        assert_eq!(p.phase, "starting");
        assert!(!p.feed("[youtube] Extracting URL: https://www.youtube.com/watch?v=abcDEF12345"));
        assert!(!p.feed("[info] abcDEF12345: Downloading 1 format(s): 399+251"));
        assert!(p.feed("[download] Destination: /p/import/Col de la Madone [abcDEF12345].f399.mp4"));
        assert_eq!((p.phase, p.title.as_deref(), p.bytes), ("downloading", Some("Col de la Madone"), None));
        assert_eq!(p.file.as_deref(), Some("/p/import/Col de la Madone [abcDEF12345].f399.mp4"));
        assert!(p.feed("[download]  12.3% of ~ 1.20GiB at    3.40MiB/s ETA 05:12 (frag 3/120)"));
        assert_eq!(p.total, Some((1.2 * gib) as u64));
        assert!((p.bytes.unwrap() as f64 - 1.2 * gib * 0.123).abs() < 2.0);
        assert_eq!((p.rate, p.eta_s), (Some(3.4 * mib), Some(312)));
        assert!((p.pct.unwrap() - 12.3).abs() < 1e-9);
        assert!(p.feed("[download]  50.0% of 1.20GiB at Unknown B/s ETA Unknown"));
        assert_eq!((p.rate, p.eta_s), (None, None));
        assert!(!p.feed("[download]  50.0% of 1.20GiB at Unknown B/s ETA Unknown")); // nothing new
        assert!(p.feed("[download] 100% of 1.20GiB in 00:05:10 at 3.87MiB/s"));
        assert_eq!((p.bytes, p.total, p.eta_s), (Some((1.2 * gib) as u64), Some((1.2 * gib) as u64), None));
        // the audio stream adds to the total; bytes never go back
        assert!(p.feed("[download] Destination: /p/import/Col de la Madone [abcDEF12345].f251.webm"));
        assert!(p.feed("[download]  50.0% of 100.00MiB at 10.00MiB/s ETA 00:05"));
        assert_eq!(p.bytes, Some((1.2 * gib + 50.0 * mib) as u64));
        assert_eq!(p.total, Some((1.2 * gib + 100.0 * mib) as u64));
        assert!(p.pct.unwrap() > 95.0 && p.pct.unwrap() < 100.0);
        assert_eq!(p.title.as_deref(), Some("Col de la Madone"));
        assert!(p.feed("[Merger] Merging formats into \"/p/import/Col de la Madone [abcDEF12345].mp4\""));
        assert_eq!((p.phase, p.file.as_deref(), p.eta_s), ("finishing", Some("/p/import/Col de la Madone [abcDEF12345].mp4"), None));
        assert!(!p.feed("Deleting original file /p/import/Col de la Madone [abcDEF12345].f251.webm (pass -k to keep)"));
        // the file sizes of the folder do not replace the command's own numbers
        assert!(!p.observe_file("/p/import/x.mp4", 5));
        let v = p.to_json("pr");
        assert_eq!((v["project"].as_str(), v["phase"].as_str(), v["processable"].as_bool()), (Some("pr"), Some("finishing"), Some(false)));
        for k in ["bytes", "total", "rate", "eta_s", "title", "file", "pct"] {
            assert!(v.get(k).is_some(), "{k}");
        }
        // an existing download
        let mut p = Progress::new();
        assert!(p.feed("[download] /p/import/Ride [id1].mp4 has already been downloaded"));
        assert_eq!((p.phase, p.title.as_deref()), ("finishing", Some("Ride")));
    }

    /// curl -# and other tools: a percentage only; sizes come from the growing file.
    #[test]
    fn progress_generic_and_by_file_size() {
        let mut p = Progress::new();
        assert!(p.feed("##################################                          50.0%"));
        assert_eq!((p.phase, p.pct, p.bytes, p.total), ("downloading", Some(50.0), None, None));
        assert!(p.observe_file("/p/import/video.mp4", 1_460_000));
        assert_eq!((p.bytes, p.total, p.title.as_deref()), (Some(1_460_000), Some(2_920_000), Some("video")));
        assert!(p.feed("     1,234,567  47%  1.20MB/s    0:00:12")); // rsync --progress
        assert_eq!(p.pct, Some(47.0));
        // no output at all (cp): a byte counter without a total
        let mut p = Progress::new();
        assert!(!p.feed("copying"));
        assert!(p.observe_file("/p/import/ride.mp4", 0));
        assert_eq!((p.phase, p.bytes, p.total), ("starting", Some(0), None));
        assert!(p.observe_file("/p/import/ride.mp4", 4096));
        assert_eq!((p.phase, p.bytes, p.total, p.file.as_deref()), ("downloading", Some(4096), None, Some("/p/import/ride.mp4")));
        assert!(!p.observe_file("/p/import/ride.mp4", 4096));
    }

    fn wait_done(log: &Arc<Mutex<Vec<(String, Value)>>>) -> Value {
        let t0 = Instant::now();
        loop {
            if let Some((_, v)) = log.lock().unwrap().iter().find(|(n, _)| n == "import-done") {
                return v.clone();
            }
            assert!(t0.elapsed() < Duration::from_secs(20), "no import-done");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// The whole path with small system programs: the built-in cp template imports one file; no file and two files are
    /// errors; cancel kills the process group.
    #[test]
    fn run_copies_one_file_and_applies_the_result_rules() {
        let d = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("v2g-import-run-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let log: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(vec![]));
        let l2 = log.clone();
        let ctx = Ctx::new(d.clone(), Arc::new(move |n, p| l2.lock().unwrap().push((n.to_string(), p))));
        let idir = ctx.project_dir("p1").unwrap().join("import");
        std::fs::create_dir_all(&idir).unwrap();
        let src = d.join("my ride; $(touch pwned).mp4");
        std::fs::write(&src, vec![7u8; 5000]).unwrap();
        let mut s = settings::load(&ctx);
        let t = |id: &str, template: &str| ImportTemplate { id: id.into(), name: id.into(), template: template.into(), ..Default::default() };
        s.import_templates = vec![
            t("none", "/usr/bin/true {input} {out}"),
            t("two", "/bin/sh -c 'echo hello; echo oops 1>&2; cp \"$1\" \"$2/a.mp4\"; cp \"$1\" \"$2/b.mkv\"; cp \"$1\" \"$OUT/c.f399.mp4\"' sh {input} {out}"),
            t("fail", "/bin/sh -c 'echo broken 1>&2; exit 3' sh {input}"),
            t("slow", "/bin/sh -c 'sleep 300 & sleep 300' sh {input}"),
        ];
        settings::save(&ctx, &s).unwrap();
        let req = |id: &str| ImportRequest { template_id: id.into(), input: src.to_string_lossy().into() };

        // refused before anything runs
        assert!(start(&ctx, "p1", &ImportRequest { template_id: "cp".into(), input: "https://a.b/c".into() }).unwrap_err().contains("Dateipfad"));
        assert!(start(&ctx, "p1", &req("gone")).unwrap_err().contains("gibt es nicht"));
        assert!(start(&ctx, "../x", &req("cp")).is_err());
        assert!(status(&ctx).is_none());

        let r = resolve_request(&ctx, Some("p1"), &req("cp")).unwrap();
        let cp = settings::find_tool("", "cp").unwrap().to_string_lossy().to_string();
        assert_eq!(r.argv, [cp.as_str(), "--", src.to_str().unwrap(), &format!("{}/", idir.display())]);
        start(&ctx, "p1", &req("cp")).unwrap();
        let done = wait_done(&log);
        assert_eq!(done["ok"], json!(true), "{done}");
        assert_eq!(done["file"], json!(idir.join(src.file_name().unwrap())));
        assert_eq!((done["project"].as_str(), done["code"].as_i64()), (Some("p1"), Some(0)));
        assert_eq!(std::fs::read(idir.join(src.file_name().unwrap())).unwrap().len(), 5000);
        assert!(!idir.join("pwned").exists() && !d.join("pwned").exists());
        assert!(log.lock().unwrap().iter().any(|(n, v)| n == "import-progress" && v["phase"] == "starting" && v["processable"] == json!(false)));
        assert!(status(&ctx).is_none() && ctx.running.import.lock().unwrap().is_none());
        assert!(settings::load(&ctx).import_history.is_empty()); // the history is no longer written

        log.lock().unwrap().clear();
        start(&ctx, "p1", &req("none")).unwrap();
        let done = wait_done(&log);
        assert!(done["ok"] == json!(false) && done["error"].as_str().unwrap().contains("keine neue Videodatei"), "{done}");

        log.lock().unwrap().clear();
        start(&ctx, "p1", &req("two")).unwrap();
        let done = wait_done(&log);
        assert!(done["ok"] == json!(false) && done["error"].as_str().unwrap().contains("2 neue"), "{done}"); // c.f399.mp4 does not count
        let mut tail: Vec<&str> = done["tail"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        tail.sort();
        assert_eq!(tail, ["hello", "oops"]);
        let logs: Vec<String> = log.lock().unwrap().iter().filter(|(n, _)| n == "import-log").map(|(_, v)| format!("{}:{}", v["stream"].as_str().unwrap(), v["line"].as_str().unwrap())).collect();
        assert!(logs.contains(&"stdout:hello".to_string()) && logs.contains(&"stderr:oops".to_string()), "{logs:?}");

        log.lock().unwrap().clear();
        start(&ctx, "p1", &req("fail")).unwrap();
        let done = wait_done(&log);
        assert!(done["ok"] == json!(false) && done["code"] == json!(3) && done["tail"] == json!(["broken"]), "{done}");

        log.lock().unwrap().clear();
        start(&ctx, "p1", &req("slow")).unwrap();
        assert!(start(&ctx, "p1", &req("cp")).unwrap_err().contains("läuft bereits"));
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(status(&ctx).unwrap()["project"], json!("p1"));
        let pg = ctx.running.import.lock().unwrap().clone().unwrap().0;
        assert!(cancel(&ctx));
        let done = wait_done(&log);
        assert_eq!(done["cancelled"], json!(true));
        std::thread::sleep(Duration::from_millis(300));
        assert!(!proc::group_alive(pg), "process group must be dead");
        assert!(!cancel(&ctx));
        let _ = std::fs::remove_dir_all(d);
    }
}
