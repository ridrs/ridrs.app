//! The POV Drive Atlas round trip (docs/FEATURE_atlas.md): read a job file (`<id>.v2g.json`), download the atlas route as the
//! project's route hint, write the result file (`<id>.atlas.json`). The job and the payload are built and checked in the frontend
//! (src/atlas.ts); this module only moves bytes, with limits.
use crate::ctx::Ctx;
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::time::Duration;

const UA: &str = "video2gpx/0.1 (desktop beta; open-source tool)";
const MAX_JOB: u64 = 1_000_000;
const MAX_HINT: u64 = 30_000_000;
const MAX_RESULT: usize = 2_000_000;

/// The text of a job file; only `*.v2g.json`, at most 1 MB.
pub fn job_read(path: &str) -> Result<String, String> {
    if !path.to_lowercase().ends_with(".v2g.json") {
        return Err("Nur Job-Dateien des Atlas (.v2g.json) lassen sich so öffnen.".into());
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("Job-Datei nicht lesbar: {e}"))?;
    if meta.len() > MAX_JOB {
        return Err("Die Job-Datei ist zu groß (über 1 MB).".into());
    }
    std::fs::read_to_string(path).map_err(|e| format!("Job-Datei nicht lesbar: {e}"))
}

/// A file name for the hint folder: letters, digits, `-`, `_`, `.`; must end in `.gpx`.
fn hint_name(name: &str) -> Result<String, String> {
    let ok = !name.is_empty() && name.len() <= 80 && name.ends_with(".gpx") && !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if ok { Ok(name.to_string()) } else { Err("Ungültiger Name des Routenhinweises".into()) }
}

/// Only plain http(s) URLs without spaces or control characters (the job comes from a file).
fn check_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) || url.chars().any(|c| c.is_whitespace() || c.is_control()) || url.len() > 2000 {
        return Err("Die Routenadresse der Job-Datei ist keine http(s)-Adresse.".into());
    }
    Ok(())
}

/// Checks a downloaded hint: text, at most 30 MB, a GPX document.
fn check_gpx(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() as u64 > MAX_HINT {
        return Err("Die Route ist zu groß für einen Routenhinweis (über 30 MB).".into());
    }
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| "Die Route ist keine Textdatei (GPX).".to_string())?;
    if !text.contains("<gpx") {
        return Err("Die Antwort des Atlas ist keine GPX-Datei.".into());
    }
    Ok(text)
}

/// Downloads the atlas route (job `route_gpx`) into the project's hint folder, replacing a previous hint, as `hint_import` does for a local file.
pub fn hint_download(ctx: &Ctx, project: &str, url: &str, name: &str) -> Result<Value, String> {
    check_url(url)?;
    let name = hint_name(name)?;
    let dir = ctx.project_dir(project)?.join("hint");
    let resp = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))
        .user_agent(UA)
        .build()
        .get(url)
        .call()
        .map_err(|e| format!("Route nicht geladen ({url}): {e}"))?;
    let mut buf = Vec::new();
    resp.into_reader().take(MAX_HINT + 1).read_to_end(&mut buf).map_err(|e| format!("Route nicht geladen: {e}"))?;
    let text = check_gpx(&buf)?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dst = dir.join(&name);
    std::fs::write(&dst, &text).map_err(|e| format!("Speichern fehlgeschlagen: {e}"))?;
    Ok(json!({"name": name, "path": dst, "text": text}))
}

/// Writes the result file chosen in the save dialog: `*.atlas.json`, a JSON object, at most 2 MB.
pub fn result_write(dest: &str, text: &str) -> Result<Value, String> {
    if !dest.to_lowercase().ends_with(".atlas.json") {
        return Err("Die Datei für den Atlas muss auf .atlas.json enden.".into());
    }
    if text.len() > MAX_RESULT {
        return Err("Das Ergebnis ist zu groß für den Atlas (über 2 MB).".into());
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(_)) => {}
        _ => return Err("Das Ergebnis ist kein JSON-Objekt.".into()),
    }
    if let Some(parent) = Path::new(dest).parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err("Der Zielordner existiert nicht.".into());
        }
    }
    std::fs::write(dest, text).map_err(|e| format!("Speichern fehlgeschlagen: {e}"))?;
    Ok(json!({"path": dest, "bytes": text.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_files_only() {
        assert!(job_read("/tmp/x.json").unwrap_err().contains(".v2g.json"));
        assert!(job_read("/nonexistent/x.v2g.json").unwrap_err().contains("nicht lesbar"));
    }

    #[test]
    fn hint_names_and_urls_are_checked() {
        assert_eq!(hint_name("V2Gexample1.gpx").unwrap(), "V2Gexample1.gpx");
        for bad in ["../x.gpx", "a/b.gpx", "x.kml", ".gpx", ""] {
            assert!(hint_name(bad).is_err(), "{bad}");
        }
        assert!(check_url("https://atlas.example.org/gpx/x.gpx").is_ok());
        for bad in ["file:///etc/passwd", "ftp://x", "https://a b", "-https://x"] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
        assert!(check_gpx(b"<?xml version=\"1.0\"?><gpx></gpx>").is_ok());
        assert!(check_gpx(b"<html></html>").is_err());
        assert!(check_gpx(&[0xff, 0xfe]).is_err());
    }

    #[test]
    fn result_is_a_json_object_with_the_right_name() {
        let dir = std::env::temp_dir().join(format!("v2g-atlas-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ok = dir.join("V2Gexample1.atlas.json");
        assert_eq!(result_write(ok.to_str().unwrap(), "{\"video_id\":\"x\"}").unwrap()["bytes"], 16);
        assert!(result_write(dir.join("x.json").to_str().unwrap(), "{}").is_err());
        assert!(result_write(ok.to_str().unwrap(), "[1]").is_err());
        assert!(result_write(dir.join("missing/x.atlas.json").to_str().unwrap(), "{}").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
