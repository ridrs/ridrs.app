//! "Für Incyclist speichern": one ZIP (or folder) that Incyclist imports as a video route (docs/FEATURE_incyclist_export.md).
//! Steps: elevation check (the data are downloaded in the Höhe stage; a current elevation_profile.json is reused), the GPX with elevation (`rsm.pipeline export`), the video
//! (copy, remux or re-encode with the external ffmpeg), the ZIP (ZIP64, video stored, `.part` then rename).
use crate::ctx::Ctx;
use crate::{pipeline, proc, settings};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

const UA: &str = "video2gpx/0.1 (desktop beta; open-source tool)";
pub const DEM_ATTRIB: &str = "Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA";
pub const OSM_ATTRIB: &str = "© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)";
/// rough size of a GLO-30 tile when the server is not asked (25-60 MB)
const TILE_GUESS: u64 = 40_000_000;
const CANCELLED: &str = "__cancelled__";

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(default)]
pub struct ExportOptions {
    pub title: String,
    /// ASCII-safe base name of the files (safe_name is applied again)
    pub name: String,
    /// ISO 3166 alpha-2
    pub country: String,
    pub drop_audio: bool,
    /// HDR (PQ / HLG) to SDR by re-encoding
    pub sdr: bool,
    /// re-encode to at most this height (1440, 1080); None = keep
    pub max_height: Option<u32>,
    /// write a folder instead of a ZIP
    pub folder: bool,
    pub start_time: Option<String>,
    /// ignored since the Höhe stage: the elevation data are downloaded there, not during the export (kept so that saved options still load)
    pub download_dem: bool,
    /// URL of the video's source (GPX <link>, video2gpx.json, LIESMICH.txt). None = from the file name (source_link), "" = none
    pub source_url: Option<String>,
    /// convert the video to MP4 (copy / remux / encode, the plan ladder). false = the source file goes into the package as it is, with its own extension
    pub convert: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        ExportOptions { title: String::new(), name: String::new(), country: String::new(), drop_audio: true, sdr: false, max_height: None, folder: false, start_time: None, download_dem: true, source_url: None, convert: true }
    }
}

// ---------------------------------------------------------------- names, XML, id

fn fold(c: char) -> Option<&'static str> {
    Some(match c {
        'ä' => "ae", 'ö' => "oe", 'ü' => "ue", 'Ä' => "Ae", 'Ö' => "Oe", 'Ü' => "Ue", 'ß' => "ss",
        'à' | 'á' | 'â' | 'ã' | 'å' | 'ā' | 'ă' | 'ą' => "a", 'À' | 'Á' | 'Â' | 'Ã' | 'Å' | 'Ā' => "A",
        'æ' => "ae", 'Æ' => "Ae", 'ç' | 'ć' | 'č' => "c", 'Ç' | 'Ć' | 'Č' => "C", 'ď' | 'đ' => "d",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => "e", 'È' | 'É' | 'Ê' | 'Ë' | 'Ě' => "E",
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'ı' => "i", 'Ì' | 'Í' | 'Î' | 'Ï' | 'İ' => "I", 'ł' => "l", 'Ł' => "L",
        'ñ' | 'ń' | 'ň' => "n", 'Ñ' | 'Ń' => "N", 'ò' | 'ó' | 'ô' | 'õ' | 'ø' | 'ō' | 'ő' => "o", 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ø' => "O",
        'œ' => "oe", 'Œ' => "Oe", 'ř' => "r", 'ś' | 'š' | 'ș' | 'ş' => "s", 'Ś' | 'Š' | 'Ș' | 'Ş' => "S", 'ť' | 'ț' | 'ţ' => "t",
        'ù' | 'ú' | 'û' | 'ū' | 'ů' | 'ű' => "u", 'Ù' | 'Ú' | 'Û' | 'Ů' => "U", 'ý' | 'ÿ' => "y", 'Ý' => "Y", 'ž' | 'ź' | 'ż' => "z", 'Ž' | 'Ź' | 'Ż' => "Z",
        _ => return None,
    })
}

/// File-name-safe ASCII: letters, digits, `_` and `-`; accents folded; at most 60 characters.
pub fn safe_name(s: &str) -> String {
    // a run of other characters becomes one `_`, unless it is a single `-` ("Rousset - 3" -> "Rousset_3", "Saint-Roch" stays)
    let mut out = String::new();
    let mut sep = String::new();
    let push = |out: &mut String, sep: &mut String, w: &str| {
        if !sep.is_empty() && !out.is_empty() {
            out.push(if sep == "-" { '-' } else { '_' });
        }
        sep.clear();
        out.push_str(w);
    };
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            push(&mut out, &mut sep, &c.to_string());
        } else if let Some(f) = fold(c) {
            push(&mut out, &mut sep, f);
        } else {
            sep.push(c);
        }
    }
    let mut t: String = out.chars().take(60).collect();
    while t.ends_with('_') || t.ends_with('-') {
        t.pop();
    }
    if t.is_empty() { "video2gpx_route".into() } else { t }
}

pub fn xml_text(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .map(|c| match c {
            '&' => "&amp;".to_string(),
            '<' => "&lt;".to_string(),
            '>' => "&gt;".to_string(),
            c => c.to_string(),
        })
        .collect()
}

/// An attribute value; a line break becomes the two characters `\n` (as in the community control files, Ridrs reads it so).
pub fn xml_attr(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c {
            '\n' => Some("\\n".to_string()),
            '&' => Some("&amp;".to_string()),
            '<' => Some("&lt;".to_string()),
            '>' => Some("&gt;".to_string()),
            '"' => Some("&quot;".to_string()),
            c if c.is_control() => None,
            c => Some(c.to_string()),
        })
        .collect()
}

/// FNV-1a 64: stable across Rust versions (the id must stay the same for the same video and result).
pub fn fnv64(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for p in parts {
        for b in p.iter().chain([0xffu8].iter()) {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    h
}

pub struct Note {
    pub distance: u32,
    pub de: String,
    pub en: String,
}

pub fn control_xml(name: &str, video_file: &str, id: &str, country: &str, title: &str, fps: f64, start_frame: u64, notes: &[Note]) -> String {
    let mut s = String::from("<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\"?>\n<gpx-import>\n");
    s += &format!("    <name>{}</name>\n", xml_text(name));
    s += &format!("    <id>{}</id>\n", xml_text(id));
    if !country.is_empty() {
        s += &format!("    <country>{}</country>\n", xml_text(country));
    }
    s += &format!("    <title>{}</title>\n", xml_text(title));
    s += &format!("    <video-file-path>{}</video-file-path>\n", xml_text(video_file));
    s += &format!("    <gpx-file-path>{}.gpx</gpx-file-path>\n", xml_text(name));
    s += &format!("    <framerate>{}</framerate>\n", fmt_fps(fps));
    s += &format!("    <start-frame>{start_frame}</start-frame>\n");
    s += "    <informations>\n";
    for n in notes {
        s += &format!("        <information distance=\"{}\" de=\"{}\" en=\"{}\" />\n", n.distance, xml_attr(&n.de), xml_attr(&n.en));
    }
    s += "    </informations>\n    <segments/>\n</gpx-import>\n";
    s
}

/// 50 -> "50.0", 29.97002997 -> "29.97003" (never rounded to 30)
pub fn fmt_fps(f: f64) -> String {
    let s = format!("{f:.5}");
    let s = s.trim_end_matches('0');
    if s.ends_with('.') { format!("{s}0") } else { s.to_string() }
}

fn de_num(x: f64, d: usize) -> String {
    format!("{x:.d$}").replace('.', ",")
}

pub fn notes(title: &str, km: f64, ascent: Option<f64>, has_ele: bool) -> Vec<Note> {
    let (de1, en1) = match ascent {
        Some(a) => (format!("{title}\nLänge: {} km – Anstieg: {:.0} hm", de_num(km, 1), a), format!("{title}\nLength: {km:.1} km – Ascent: {a:.0} m")),
        None => (format!("{title}\nLänge: {} km", de_num(km, 1)), format!("{title}\nLength: {km:.1} km")),
    };
    let (de2, en2) = if has_ele {
        ("Strecke aus dem Video rekonstruiert mit video2gpx (kein GPS)\nKarte © OpenStreetMap-Mitwirkende, Höhen © Copernicus DEM".to_string(),
         "Route reconstructed from the video with video2gpx (no GPS)\nMap © OpenStreetMap contributors, elevation © Copernicus DEM".to_string())
    } else {
        ("Strecke aus dem Video rekonstruiert mit video2gpx (kein GPS)\nKarte © OpenStreetMap-Mitwirkende; ohne Höhendaten".to_string(),
         "Route reconstructed from the video with video2gpx (no GPS)\nMap © OpenStreetMap contributors; no elevation data".to_string())
    };
    vec![Note { distance: 20, de: de1, en: en1 }, Note { distance: 100, de: de2, en: en2 }]
}

/// YouTube id in the file name ("… [aBcDeFgHiJk].webm", yt-dlp's default) -> the video's URL
pub fn source_link(video: &str) -> Option<String> {
    let name = Path::new(video).file_stem()?.to_string_lossy().to_string();
    let open = name.rfind('[')?;
    let id = name[open + 1..].strip_suffix(']')?;
    if id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Some(format!("https://www.youtube.com/watch?v={id}"))
    } else {
        None
    }
}

/// the source URL of the package: the one typed in the export options, else the YouTube link from the file name.
/// Only http(s) without spaces or control characters: it ends up in an XML attribute and a text file.
pub fn effective_link(o: &ExportOptions, video: &str) -> Result<Option<String>, String> {
    match o.source_url.as_deref().map(str::trim) {
        None => Ok(source_link(video)),
        Some("") => Ok(None),
        Some(u) => {
            let lower = u.to_ascii_lowercase();
            let scheme_ok = (lower.starts_with("https://") || lower.starts_with("http://")) && u.len() > lower.find("://").unwrap() + 3;
            if !scheme_ok || u.chars().any(|c| c.is_whitespace() || c.is_control()) || u.len() > 2000 {
                return Err("Quelle: bitte eine vollständige Adresse mit http:// oder https:// eingeben (ohne Leerzeichen).".into());
            }
            Ok(Some(u.to_string()))
        }
    }
}

// ---------------------------------------------------------------- preview image

/// Incyclist shows `<video name>_preview.png|jpg` next to the video as the route's picture (incyclist-services, routes/list/service.ts,
/// checkExistingPreviewFiles). The image the user drops is kept in the project folder as `incyclist_preview.<ext>` and goes into the package.
const PREVIEW_MAX: u64 = 20_000_000;
const PREVIEW_EXTS: [&str; 2] = ["png", "jpg"];

/// "png" or "jpg" from the first bytes; anything else is refused (Incyclist reads only these two)
pub fn image_kind(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if head.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else {
        None
    }
}

/// the stored preview of the project, if any
pub fn preview_path(ctx: &Ctx, project: &str) -> Option<PathBuf> {
    let d = ctx.project_dir(project).ok()?;
    PREVIEW_EXTS.iter().map(|e| d.join(format!("incyclist_preview.{e}"))).find(|p| p.is_file())
}

/// checks the image and copies it into the project folder (replacing an earlier one); returns the stored path
pub fn preview_set(ctx: &Ctx, project: &str, src: &str) -> Result<PathBuf, String> {
    let meta = std::fs::metadata(src).map_err(|e| format!("Bild nicht lesbar: {e}"))?;
    if !meta.is_file() {
        return Err("Bitte eine Bilddatei ablegen.".into());
    }
    if meta.len() > PREVIEW_MAX {
        return Err(format!("Das Bild ist zu groß ({:.0} MB, höchstens {} MB).", meta.len() as f64 / 1e6, PREVIEW_MAX / 1_000_000));
    }
    let bytes = std::fs::read(src).map_err(|e| format!("Bild nicht lesbar: {e}"))?;
    let kind = image_kind(&bytes).ok_or("Nur PNG- oder JPEG-Bilder: Incyclist liest keine anderen Formate.")?;
    let d = ctx.project_dir(project)?;
    let dest = d.join(format!("incyclist_preview.{kind}"));
    let tmp = d.join(format!("incyclist_preview.{kind}.part"));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    preview_clear(ctx, project)?;
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

pub fn preview_clear(ctx: &Ctx, project: &str) -> Result<(), String> {
    let d = ctx.project_dir(project)?;
    for e in PREVIEW_EXTS {
        let p = d.join(format!("incyclist_preview.{e}"));
        if p.is_file() {
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- DEM tiles

pub fn tile_name(lat: i32, lon: i32) -> String {
    format!("Copernicus_DSM_COG_10_{}{:02}_00_{}{:03}_00_DEM", if lat >= 0 { 'N' } else { 'S' }, lat.abs(), if lon >= 0 { 'E' } else { 'W' }, lon.abs())
}

fn valid_tile(n: &str) -> bool {
    n.len() == 40 && n.starts_with("Copernicus_DSM_COG_10_") && n.ends_with("_DEM") && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub fn tiles_for(bbox: [f64; 4], pad_m: f64) -> Vec<String> {
    let (s, w, n, e) = (bbox[0], bbox[1], bbox[2], bbox[3]);
    let dlat = pad_m / 111_320.0;
    let dlon = pad_m / (111_320.0 * ((s + n) / 2.0).to_radians().cos().max(0.1));
    let mut v = vec![];
    for la in ((s - dlat).floor() as i32)..=((n + dlat).floor() as i32) {
        for lo in ((w - dlon).floor() as i32)..=((e + dlon).floor() as i32) {
            v.push(tile_name(la, lo));
        }
    }
    v
}

fn tile_state(dir: &Path, n: &str) -> &'static str {
    if dir.join(format!("{n}.tif")).is_file() {
        "present"
    } else if dir.join(format!("{n}.none")).is_file() {
        "sea"
    } else {
        "missing"
    }
}

/// bbox [S, W, N, E] of the decoded part of a result (route_points.json)
pub fn route_bbox(out: &Path) -> Result<[f64; 4], String> {
    let rp: Value = serde_json::from_str(&std::fs::read_to_string(out.join("route_points.json")).map_err(|e| format!("route_points.json fehlt: {e}"))?).map_err(|e| e.to_string())?;
    let pts = rp["points"].as_array().ok_or("route_points.json ohne Punkte")?;
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    let mut any = false;
    for p in pts.iter().filter(|p| p["extrapolated"] != json!(true)) {
        let (Some(la), Some(lo)) = (p["lat"].as_f64(), p["lon"].as_f64()) else { continue };
        b = [b[0].min(la), b[1].min(lo), b[2].max(la), b[3].max(lo)];
        any = true;
    }
    if any { Ok(b) } else { Err("Keine Routenpunkte".into()) }
}

fn http() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(60)).user_agent(UA).build()
}

fn tile_url(n: &str) -> String {
    format!("https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif")
}

/// Which tiles the project's route needs and which are there. `online`: ask the server for the sizes of the missing ones.
pub fn dem_status(ctx: &Ctx, project: &str, online: bool) -> Result<Value, String> {
    let out = ctx.project_dir(project)?.join("out");
    let tiles = tiles_for(route_bbox(&out)?, 500.0);
    let dir = ctx.dem_dir();
    let mut list = vec![];
    let mut missing_bytes = 0u64;
    let mut exact = true;
    for n in &tiles {
        let st = tile_state(&dir, n);
        let mut bytes = std::fs::metadata(dir.join(format!("{n}.tif"))).map(|m| m.len()).ok();
        if st == "missing" {
            let head = if online { http().head(&tile_url(n)).call().ok() } else { None };
            bytes = head.as_ref().and_then(|r| r.header("Content-Length").and_then(|s| s.parse().ok()));
            if head.is_none() && online {
                // 403 / 404: no tile there (sea)
            }
            if bytes.is_none() {
                exact = false;
            }
            missing_bytes += bytes.unwrap_or(TILE_GUESS);
        }
        list.push(json!({"name": n, "state": st, "bytes": bytes}));
    }
    let ready = list.iter().all(|t| t["state"] != "missing");
    // the national / regional sources (optional: the profile works without them, they make it better where they exist)
    let extras = extras_plan(ctx, &out);
    let extra_bytes = extras["missing_bytes"].as_u64().unwrap_or(0);
    Ok(json!({"tiles": list, "ready": ready, "missing_bytes": missing_bytes, "exact": exact, "dir": dir, "extras": extras, "extra_missing_bytes": extra_bytes}))
}

/// Which extra elevation blocks the route needs (`rsm.pipeline dem-plan`, offline): national / regional terrain models and the Copernicus
/// fill mask. Null when the pipeline cannot tell (then only Copernicus is used).
pub fn extras_plan(ctx: &Ctx, out: &Path) -> Value {
    let s = settings::load(ctx);
    let mut cmd = pipeline::pipeline_cmd(ctx, &s);
    cmd.arg("dem-plan").arg("--out").arg(out).arg("--dem-dir").arg(ctx.dem_dir());
    match cmd.output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .find(|v| v["type"] == "result")
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// written after extra blocks were downloaded: profiles older than this are recomputed
fn extras_stamp(ctx: &Ctx) -> PathBuf {
    ctx.dem_dir().join(".extras-updated")
}

/// Download the missing extra blocks of a result (`rsm.pipeline dem-fetch`, sequential, polite). `on(done, of, bytes)`.
/// Ok((false, _)) = cancelled; Ok((true, Some(note))) = finished, but a source failed (it is used next time it works).
pub fn fetch_extras(ctx: &Ctx, out: &Path, cancel: &dyn Fn() -> bool, on: &mut dyn FnMut(usize, usize, u64)) -> Result<(bool, Option<String>), String> {
    let s = settings::load(ctx);
    let mut cmd = pipeline::pipeline_cmd(ctx, &s);
    cmd.arg("dem-fetch").arg("--out").arg(out).arg("--dem-dir").arg(ctx.dem_dir());
    let mut child = proc::spawn_group(&mut cmd).map_err(|e| format!("Pipeline nicht startbar: {e}"))?;
    let pgid = child.id() as i32;
    let se = child.stderr.take().unwrap();
    let errt = std::thread::spawn(move || {
        let mut last = String::new();
        proc::read_lines(se, |l| last = l);
        last
    });
    let mut res = Value::Null;
    let mut stopped = false;
    proc::read_lines(child.stdout.take().unwrap(), |l| {
        if !stopped && cancel() {
            stopped = true;
            proc::kill_group(pgid, libc::SIGTERM);
        }
        if let Ok(ev) = serde_json::from_str::<Value>(&l) {
            if ev["type"] == "progress" {
                on(ev["index"].as_u64().unwrap_or(0) as usize, ev["of"].as_u64().unwrap_or(0) as usize, ev["bytes"].as_u64().unwrap_or(0));
            } else if ev["type"] == "result" {
                res = ev;
            }
        }
    });
    let _ = child.wait();
    let err = errt.join().unwrap_or_default();
    if stopped || cancel() {
        return Ok((false, None));
    }
    if res.is_null() {
        return Err(format!("Genauere Höhendaten: kein Ergebnis der Pipeline ({err})"));
    }
    if res["fetched"].as_u64().unwrap_or(0) > 0 {
        let _ = std::fs::write(extras_stamp(ctx), "extra elevation blocks downloaded\n");
    }
    let note = res["errors"].as_object().filter(|m| !m.is_empty()).map(|m| {
        format!("Genauere Höhendaten teilweise nicht geladen ({}); es wird mit den vorhandenen gerechnet", m.keys().cloned().collect::<Vec<_>>().join(", "))
    });
    Ok((true, note))
}

/// Download the missing tiles (sequentially). A tile the server does not have (403 / 404: open sea) gets a `.none` marker.
/// `on(index, of, bytes, total)`. Ok(false) = cancelled.
pub fn download_tiles(ctx: &Ctx, tiles: &[String], cancel: &dyn Fn() -> bool, on: &mut dyn FnMut(usize, usize, u64, u64)) -> Result<bool, String> {
    let dir = ctx.dem_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let todo: Vec<&String> = tiles.iter().filter(|n| tile_state(&dir, n) == "missing").collect();
    for (i, n) in todo.iter().enumerate() {
        if !valid_tile(n) {
            return Err(format!("Ungültiger Kachelname: {n}"));
        }
        let part = dir.join(format!("{n}.tif.part"));
        let res = (|| -> Result<bool, String> {
            let resp = match http().get(&tile_url(n)).call() {
                Ok(r) => r,
                Err(ureq::Error::Status(403 | 404, _)) => {
                    std::fs::write(dir.join(format!("{n}.none")), "no Copernicus tile here (sea)\n").map_err(|e| e.to_string())?;
                    return Ok(true);
                }
                Err(e) => return Err(format!("Höhendaten: Netzwerkfehler bei {n}: {e}")),
            };
            let total: u64 = resp.header("Content-Length").and_then(|s| s.parse().ok()).unwrap_or(0);
            let mut rd = resp.into_reader();
            let mut f = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            let (mut done, mut last) = (0u64, Instant::now());
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                if cancel() {
                    return Ok(false);
                }
                let k = rd.read(&mut buf).map_err(|e| format!("Download abgebrochen: {e}"))?;
                if k == 0 {
                    break;
                }
                f.write_all(&buf[..k]).map_err(|e| e.to_string())?;
                done += k as u64;
                if last.elapsed() > Duration::from_millis(300) {
                    last = Instant::now();
                    on(i, todo.len(), done, total);
                }
            }
            f.flush().map_err(|e| e.to_string())?;
            if total > 0 && done != total {
                return Err(format!("Unvollständig: {done} von {total} Bytes"));
            }
            let mut head = [0u8; 4];
            std::fs::File::open(&part).and_then(|mut f| f.read_exact(&mut head)).map_err(|e| e.to_string())?;
            if &head != b"II*\0" && &head != b"MM\0*" {
                return Err(format!("{n}: keine TIFF-Datei"));
            }
            std::fs::rename(&part, dir.join(format!("{n}.tif"))).map_err(|e| e.to_string())?;
            on(i, todo.len(), done, total);
            Ok(true)
        })();
        match res {
            Ok(true) => {}
            other => {
                let _ = std::fs::remove_file(&part);
                return other;
            }
        }
    }
    Ok(true)
}

/// `dem_download` command: in a thread, events `dem-progress` and `dem-done`.
pub fn dem_download(ctx: &Ctx, tiles: Vec<String>, project: Option<String>) -> Result<(), String> {
    if tiles.iter().any(|t| !valid_tile(t)) {
        return Err("Ungültiger Kachelname".into());
    }
    if ctx.running.dem_active.swap(true, Ordering::SeqCst) {
        return Err("Es läuft bereits ein Download der Höhendaten".into());
    }
    ctx.running.dem_cancel.store(false, Ordering::SeqCst);
    let c = ctx.clone();
    std::thread::spawn(move || {
        let c2 = c.clone();
        let cancel = move || c2.running.dem_cancel.load(Ordering::SeqCst);
        let c3 = c.clone();
        let r = download_tiles(&c, &tiles, &cancel, &mut |i, of, b, t| c3.emit("dem-progress", json!({"index": i, "of": of, "bytes": b, "total": t})));
        // then the national / regional blocks of the project's route (failures there only leave the profile on Copernicus)
        let mut note: Option<String> = None;
        let r = match (r, project.as_deref().and_then(|p| c.project_dir(p).ok())) {
            (Ok(true), Some(pd)) => {
                let c4 = c.clone();
                match fetch_extras(&c, &pd.join("out"), &cancel, &mut |i, of, b| c4.emit("dem-progress", json!({"index": i, "of": of, "bytes": b, "total": 0, "extra": true}))) {
                    Ok((false, _)) => Ok(false),
                    Ok((true, n)) => { note = n; Ok(true) }
                    Err(e) => { note = Some(e); Ok(true) }
                }
            }
            (r, _) => r,
        };
        c.running.dem_active.store(false, Ordering::SeqCst);
        match r {
            Ok(true) => c.emit("dem-done", json!({"ok": true, "note": note})),
            Ok(false) => c.emit("dem-done", json!({"ok": false, "cancelled": true})),
            Err(e) => c.emit("dem-done", json!({"ok": false, "error": e})),
        }
    });
    Ok(())
}

pub fn dem_cancel(ctx: &Ctx) {
    ctx.running.dem_cancel.store(true, Ordering::SeqCst);
}

/// The stored tiles (settings: "Höhendaten").
pub fn dem_list(ctx: &Ctx) -> Vec<Value> {
    let mut v: Vec<Value> = std::fs::read_dir(ctx.dem_dir())
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    let (stem, sea) = if let Some(s) = n.strip_suffix(".tif") { (s.to_string(), false) } else if let Some(s) = n.strip_suffix(".none") { (s.to_string(), true) } else { return None };
                    Some(json!({"name": stem, "sea": sea, "bytes": e.metadata().map(|m| m.len()).unwrap_or(0), "path": e.path()}))
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    // national / regional sources: one row per source directory
    if let Ok(rd) = std::fs::read_dir(ctx.dem_dir()) {
        let mut ex: Vec<Value> = rd
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir() && valid_source(&e.file_name().to_string_lossy()))
            .map(|e| {
                let (mut bytes, mut blocks) = (0u64, 0u64);
                if let Ok(files) = std::fs::read_dir(e.path()) {
                    for f in files.filter_map(|f| f.ok()) {
                        bytes += f.metadata().map(|m| m.len()).unwrap_or(0);
                        blocks += 1;
                    }
                }
                json!({"name": e.file_name().to_string_lossy(), "sea": false, "bytes": bytes, "path": e.path(), "source": true, "blocks": blocks})
            })
            .collect();
        ex.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        v.extend(ex);
    }
    v
}

/// a source directory name of the pipeline's registry (demsrc.SOURCES): lower-case letters, digits, underscore
fn valid_source(n: &str) -> bool {
    !n.is_empty() && n.len() <= 40 && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') && !n.starts_with("copernicus")
}

pub fn dem_remove(ctx: &Ctx, name: &str) -> Result<(), String> {
    if valid_source(name) && ctx.dem_dir().join(name).is_dir() {
        std::fs::remove_dir_all(ctx.dem_dir().join(name)).map_err(|e| e.to_string())?;
        let _ = std::fs::write(extras_stamp(ctx), "extra elevation source removed\n");
        return Ok(());
    }
    if !valid_tile(name) {
        return Err("Ungültiger Kachelname".into());
    }
    let d = ctx.dem_dir();
    let _ = std::fs::remove_file(d.join(format!("{name}.none")));
    match std::fs::remove_file(d.join(format!("{name}.tif"))) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------------------------------------------------------------- video

#[derive(Serialize, Clone, Debug, Default)]
pub struct VideoInfo {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub container: String,
    pub codec: String,
    pub width: u64,
    pub height: u64,
    /// r_frame_rate as given ("50/1", "30000/1001") and as a number
    pub r_frame_rate: String,
    pub fps: f64,
    pub duration: f64,
    pub nb_frames: Option<u64>,
    pub transfer: String,
    pub hdr: bool,
    pub audio: Option<String>,
    pub start_time: f64,
}

fn ratio(s: &str) -> Option<f64> {
    let (a, b) = s.split_once('/').unwrap_or((s, "1"));
    let (a, b) = (a.trim().parse::<f64>().ok()?, b.trim().parse::<f64>().ok()?);
    if b > 0.0 && a > 0.0 { Some(a / b) } else { None }
}

pub fn probe(ffprobe: &Path, path: &str) -> Result<VideoInfo, String> {
    let o = Command::new(ffprobe)
        .args(["-v", "error", "-show_entries", "stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_frames,color_transfer,start_time,duration:format=duration,format_name,start_time", "-of", "json", path])
        .output()
        .map_err(|e| format!("ffprobe konnte nicht gestartet werden: {e}"))?;
    if !o.status.success() {
        return Err(format!("ffprobe: {}", String::from_utf8_lossy(&o.stderr).trim()));
    }
    let v: Value = serde_json::from_slice(&o.stdout).map_err(|e| e.to_string())?;
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let vs = streams.iter().find(|s| s["codec_type"] == "video").ok_or("Keine Videospur")?;
    let audio = streams.iter().find(|s| s["codec_type"] == "audio").and_then(|s| s["codec_name"].as_str().map(|x| x.to_string()));
    let num = |x: &Value| x.as_str().and_then(|s| s.parse::<f64>().ok());
    let rfr = vs["r_frame_rate"].as_str().unwrap_or("").to_string();
    let transfer = vs["color_transfer"].as_str().unwrap_or("").to_string();
    Ok(VideoInfo {
        path: path.to_string(),
        name: Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        container: v["format"]["format_name"].as_str().unwrap_or("").to_string(),
        codec: vs["codec_name"].as_str().unwrap_or("").to_string(),
        width: vs["width"].as_u64().unwrap_or(0),
        height: vs["height"].as_u64().unwrap_or(0),
        fps: ratio(&rfr).unwrap_or(0.0),
        r_frame_rate: rfr,
        duration: num(&v["format"]["duration"]).or_else(|| num(&vs["duration"])).unwrap_or(0.0),
        nb_frames: vs["nb_frames"].as_str().and_then(|s| s.parse().ok()),
        hdr: transfer == "smpte2084" || transfer == "arib-std-b67",
        transfer,
        audio,
        start_time: num(&vs["start_time"]).unwrap_or(0.0),
    })
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct VideoPlan {
    /// "copy" | "remux" | "encode"
    pub mode: String,
    pub reasons: Vec<String>,
    pub est_bytes: u64,
    pub est_seconds: f64,
    pub out_height: u64,
}

fn mbps_for(h: u64) -> f64 {
    match h {
        0..=720 => 5.0,
        721..=1080 => 10.0,
        1081..=1440 => 20.0,
        _ => 35.0,
    }
}

/// The ladder of the plan (section 4): MP4 with a Chromium codec is copied, other containers with such a codec are remuxed,
/// everything else (and SDR conversion, smaller resolution) is re-encoded with VideoToolbox HEVC.
pub fn plan_video(v: &VideoInfo, o: &ExportOptions) -> VideoPlan {
    if !o.convert {
        let ext = video_ext(&v.path);
        return VideoPlan { mode: "original".into(), reasons: vec![format!("Originaldatei (.{ext}) wird unverändert übernommen, keine Umwandlung")], est_bytes: v.bytes, est_seconds: v.bytes as f64 / 400e6, out_height: v.height };
    }
    let mp4 = v.container.contains("mp4") || v.container.contains("mov");
    let copy_codec = matches!(v.codec.as_str(), "h264" | "hevc" | "av1");
    let remux_codec = copy_codec || v.codec == "vp9";
    let mut reasons = vec![];
    let scale = o.max_height.filter(|h| (*h as u64) < v.height);
    if o.sdr && v.hdr {
        reasons.push("HDR → SDR".to_string());
    }
    if let Some(h) = scale {
        reasons.push(format!("auf {h}p verkleinern"));
    }
    if !remux_codec {
        reasons.push(format!("Codec {} wird neu kodiert", v.codec));
    }
    let out_height = scale.map(|h| h as u64).unwrap_or(v.height);
    if !reasons.is_empty() {
        let est = (mbps_for(out_height) * 1e6 / 8.0 * v.duration) as u64;
        return VideoPlan { mode: "encode".into(), reasons, est_bytes: est, est_seconds: v.duration * if v.height > 1440 { 1.5 } else { 0.8 }, out_height };
    }
    let audio_out = v.audio.is_some() && !o.drop_audio;
    if !mp4 || !copy_codec {
        reasons.push(format!("{} → MP4 (Videospur unverändert)", v.container.split(',').next().unwrap_or("")));
    } else if v.audio.is_some() && o.drop_audio {
        reasons.push("Ton entfernen (Videospur unverändert)".into());
    } else if audio_out && v.audio.as_deref() != Some("aac") && v.audio.as_deref() != Some("mp3") && v.audio.as_deref() != Some("opus") {
        reasons.push("Ton → AAC".into());
    }
    if reasons.is_empty() {
        return VideoPlan { mode: "copy".into(), reasons: vec!["MP4 wird unverändert übernommen".into()], est_bytes: v.bytes, est_seconds: v.bytes as f64 / 400e6, out_height };
    }
    VideoPlan { mode: "remux".into(), reasons, est_bytes: v.bytes, est_seconds: v.bytes as f64 / 150e6, out_height }
}

/// the extension of the video file in the package: "mp4" after a conversion, else the source's own (lower case, ASCII; "mp4" when it has none)
pub fn video_ext(path: &str) -> String {
    Path::new(path).extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).filter(|e| !e.is_empty() && e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric())).unwrap_or_else(|| "mp4".into())
}

fn hdr_lut_value(x: f64, hlg: bool) -> f64 {
    // signal -> scene/display linear, relative to 100 nits = 1
    if hlg {
        let (a, b, c) = (0.17883277, 0.28466892, 0.55991073);
        let l = if x <= 0.5 { x * x / 3.0 } else { (((x - c) / a).exp() + b) / 12.0 };
        l * 10.0 // HLG nominal peak 1000 nits
    } else {
        let (m1, m2, c1, c2, c3) = (0.1593017578125, 78.84375, 0.8359375, 18.8515625, 18.6875);
        let p = x.max(0.0).powf(1.0 / m2);
        ((p - c1).max(0.0) / (c2 - c3 * p)).powf(1.0 / m1) * 100.0
    }
}

fn hable(x: f64) -> f64 {
    let (a, b, c, d, e, f) = (0.15, 0.50, 0.10, 0.20, 0.02, 0.30);
    ((x * (a * x + c * b) + d * e) / (x * (a * x + b) + d * f)) - e / f
}

/// A 3D LUT (.cube, 33³) from PQ / HLG BT.2020 R'G'B' to SDR BT.709 R'G'B' (Hable tone mapping, 1000 nits peak). The Homebrew ffmpeg
/// has no zscale, so the transfer is done with lut3d.
pub fn hdr_to_sdr_cube(hlg: bool) -> String {
    const N: usize = 33;
    let m = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]];
    let white = hable(10.0);
    let oetf = |l: f64| -> f64 {
        let l = l.clamp(0.0, 1.0);
        if l < 0.018 { 4.5 * l } else { 1.099 * l.powf(0.45) - 0.099 }
    };
    let mut s = format!("TITLE \"video2gpx HDR->SDR\"\nLUT_3D_SIZE {N}\n");
    for bi in 0..N {
        for gi in 0..N {
            for ri in 0..N {
                let f = |i: usize| hdr_lut_value(i as f64 / (N - 1) as f64, hlg);
                let rgb = [f(ri), f(gi), f(bi)];
                let mut o = [0.0; 3];
                for k in 0..3 {
                    let lin = (m[k][0] * rgb[0] + m[k][1] * rgb[1] + m[k][2] * rgb[2]).max(0.0);
                    o[k] = oetf(hable(lin * 1.6) / white);
                }
                s += &format!("{:.6} {:.6} {:.6}\n", o[0], o[1], o[2]);
            }
        }
    }
    s
}

pub fn ffmpeg_args(v: &VideoInfo, o: &ExportOptions, plan: &VideoPlan, dest: &Path, lut: Option<&Path>) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostats", "-loglevel", "error", "-y", "-i", &v.path, "-map", "0:v:0"].iter().map(|s| s.to_string()).collect();
    if v.audio.is_some() && !o.drop_audio {
        a.extend(["-map", "0:a:0"].map(String::from));
    }
    if plan.mode == "encode" {
        let mut vf: Vec<String> = vec![];
        let scale = if plan.out_height < v.height { format!("-2:{}", plan.out_height) } else { "iw:ih".into() };
        if let (true, Some(l)) = (o.sdr && v.hdr, lut) {
            vf.push(format!("scale={scale}:in_color_matrix=bt2020:in_range=tv:flags=bicubic,format=gbrp16le"));
            vf.push(format!("lut3d=file='{}':interp=tetrahedral", l.to_string_lossy().replace('\'', "\\'")));
            vf.push("scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv".into());
        } else if plan.out_height < v.height {
            vf.push(format!("scale={scale}:flags=bicubic"));
        }
        if !vf.is_empty() {
            a.extend(["-vf".to_string(), vf.join(",")]);
        }
        let mb = mbps_for(plan.out_height);
        a.extend(["-c:v", "hevc_videotoolbox", "-tag:v", "hvc1", "-fps_mode", "passthrough"].map(String::from));
        a.extend(["-b:v".to_string(), format!("{mb:.0}M"), "-maxrate".to_string(), format!("{:.0}M", mb * 1.5), "-bufsize".to_string(), format!("{:.0}M", mb * 2.0)]);
        if o.sdr && v.hdr {
            a.extend(["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"].map(String::from));
        }
    } else {
        a.extend(["-c:v", "copy"].map(String::from));
        if v.codec == "hevc" {
            a.extend(["-tag:v", "hvc1"].map(String::from));
        }
    }
    if v.audio.is_some() && !o.drop_audio {
        if matches!(v.audio.as_deref(), Some("aac")) {
            a.extend(["-c:a", "copy"].map(String::from));
        } else {
            a.extend(["-c:a", "aac", "-b:a", "160k"].map(String::from));
        }
    } else {
        a.push("-an".into());
    }
    a.extend(["-sn", "-dn", "-movflags", "+faststart", "-progress", "pipe:1"].map(String::from));
    a.push(dest.to_string_lossy().into());
    a
}

// ---------------------------------------------------------------- child processes (cancel kills the group)

fn cancelled(ctx: &Ctx) -> bool {
    ctx.running.export_cancel.load(Ordering::SeqCst)
}

fn run_child(ctx: &Ctx, cmd: &mut Command, on_line: &mut dyn FnMut(&str)) -> Result<(i32, String), String> {
    let mut child = proc::spawn_group(cmd).map_err(|e| format!("Prozess konnte nicht gestartet werden: {e}"))?;
    let pgid = child.id() as i32;
    *ctx.running.export_child.lock().unwrap() = Some(pgid);
    if cancelled(ctx) {
        proc::kill_group(pgid, libc::SIGTERM);
    }
    let se = child.stderr.take().unwrap();
    let errt = std::thread::spawn(move || {
        let mut lines: Vec<String> = vec![];
        proc::read_lines(se, |l| {
            lines.push(l);
            if lines.len() > 40 {
                lines.remove(0);
            }
        });
        lines.join("\n")
    });
    let so = child.stdout.take().unwrap();
    proc::read_lines(so, |l| on_line(&l));
    let st = child.wait().map_err(|e| e.to_string())?;
    *ctx.running.export_child.lock().unwrap() = None;
    let err = errt.join().unwrap_or_default();
    if cancelled(ctx) {
        return Err(CANCELLED.into());
    }
    Ok((st.code().unwrap_or(-1), err))
}

fn run_ffmpeg(ctx: &Ctx, ff: &Path, args: &[String], duration: f64, on_pct: &mut dyn FnMut(f64)) -> Result<(), String> {
    let mut cmd = Command::new(ff);
    cmd.args(args);
    let (code, err) = run_child(ctx, &mut cmd, &mut |l| {
        if let Some(us) = l.strip_prefix("out_time_us=").or_else(|| l.strip_prefix("out_time_ms=")) {
            if let Ok(x) = us.trim().parse::<f64>() {
                if duration > 0.0 {
                    on_pct((100.0 * x / 1e6 / duration).clamp(0.0, 99.9));
                }
            }
        }
    })?;
    if code != 0 {
        return Err(format!("ffmpeg endete mit Code {code}: {}", err.lines().last().unwrap_or("")));
    }
    Ok(())
}

pub fn cancel(ctx: &Ctx) -> bool {
    if !ctx.running.export_active.load(Ordering::SeqCst) {
        return false;
    }
    ctx.running.export_cancel.store(true, Ordering::SeqCst);
    if let Some(pg) = *ctx.running.export_child.lock().unwrap() {
        proc::kill_group(pg, libc::SIGTERM);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(5));
            if proc::group_alive(pg) {
                proc::kill_group(pg, libc::SIGKILL);
            }
        });
    }
    true
}

// ---------------------------------------------------------------- ZIP / folder

pub enum Src {
    File(PathBuf),
    Bytes(Vec<u8>),
}

impl Src {
    fn len(&self) -> u64 {
        match self {
            Src::File(p) => std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
            Src::Bytes(b) => b.len() as u64,
        }
    }
}

fn part_of(dest: &Path) -> PathBuf {
    PathBuf::from(format!("{}.part", dest.to_string_lossy()))
}

fn copy_chunks(r: &mut dyn Read, w: &mut dyn Write, cancel: &dyn Fn() -> bool, done: &mut u64, total: u64, progress: &mut dyn FnMut(u64, u64)) -> Result<(), String> {
    let mut buf = vec![0u8; 4 << 20];
    let mut last = Instant::now();
    loop {
        if cancel() {
            return Err(CANCELLED.into());
        }
        let n = r.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(());
        }
        w.write_all(&buf[..n]).map_err(|e| format!("Schreiben fehlgeschlagen: {e}"))?;
        *done += n as u64;
        if last.elapsed() > Duration::from_millis(250) {
            last = Instant::now();
            progress(*done, total);
        }
    }
}

/// ZIP64 where needed; files (the video) are stored, text is deflated. Written to `<dest>.part`, renamed at the end; nothing is left on error or cancel.
pub fn write_zip(dest: &Path, entries: &[(String, Src)], cancel: &dyn Fn() -> bool, progress: &mut dyn FnMut(u64, u64)) -> Result<u64, String> {
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;
    let part = part_of(dest);
    let total: u64 = entries.iter().map(|(_, s)| s.len()).sum();
    let res = (|| -> Result<(), String> {
        let f = std::fs::File::create(&part).map_err(|e| format!("ZIP kann nicht angelegt werden: {e}"))?;
        let mut z = zip::ZipWriter::new(BufWriter::with_capacity(1 << 20, f));
        let when = local_zip_time();
        let mut done = 0u64;
        for (name, src) in entries {
            match src {
                Src::File(p) => {
                    let len = src.len();
                    let opt = SimpleFileOptions::default().compression_method(CompressionMethod::Stored).large_file(len >= 0xFFFF_0000).unix_permissions(0o644).last_modified_time(when);
                    z.start_file(name.as_str(), opt).map_err(|e| e.to_string())?;
                    let mut r = std::fs::File::open(p).map_err(|e| format!("{}: {e}", p.display()))?;
                    copy_chunks(&mut r, &mut z, cancel, &mut done, total, progress)?;
                }
                Src::Bytes(b) => {
                    let opt = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).unix_permissions(0o644).last_modified_time(when);
                    z.start_file(name.as_str(), opt).map_err(|e| e.to_string())?;
                    z.write_all(b).map_err(|e| e.to_string())?;
                    done += b.len() as u64;
                }
            }
        }
        let mut w = z.finish().map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
        w.get_ref().sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    std::fs::rename(&part, dest).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        e.to_string()
    })?;
    progress(total, total);
    Ok(std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0))
}

/// The same files in a folder (`<dest>.part/` renamed at the end). A temporary video (`move_files`) is moved, not copied.
pub fn write_folder(dest: &Path, entries: &[(String, Src)], move_files: &[PathBuf], cancel: &dyn Fn() -> bool, progress: &mut dyn FnMut(u64, u64)) -> Result<u64, String> {
    if dest.exists() {
        return Err(format!("Der Ordner {} existiert bereits", dest.display()));
    }
    let part = part_of(dest);
    let _ = std::fs::remove_dir_all(&part);
    let total: u64 = entries.iter().map(|(_, s)| s.len()).sum();
    let res = (|| -> Result<(), String> {
        std::fs::create_dir_all(&part).map_err(|e| e.to_string())?;
        let mut done = 0u64;
        for (name, src) in entries {
            let to = part.join(name);
            match src {
                Src::File(p) if move_files.contains(p) && std::fs::rename(p, &to).is_ok() => done += std::fs::metadata(&to).map(|m| m.len()).unwrap_or(0),
                Src::File(p) => {
                    let mut r = std::fs::File::open(p).map_err(|e| e.to_string())?;
                    let mut w = std::fs::File::create(&to).map_err(|e| e.to_string())?;
                    copy_chunks(&mut r, &mut w, cancel, &mut done, total, progress)?;
                }
                Src::Bytes(b) => {
                    std::fs::write(&to, b).map_err(|e| e.to_string())?;
                    done += b.len() as u64;
                }
            }
        }
        Ok(())
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_dir_all(&part);
        return Err(e);
    }
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    progress(total, total);
    Ok(total)
}

pub fn free_bytes(dir: &Path) -> Option<u64> {
    let c = std::ffi::CString::new(dir.to_string_lossy().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } == 0 {
        Some(s.f_bavail as u64 * s.f_frsize as u64)
    } else {
        None
    }
}

// ---------------------------------------------------------------- texts

pub fn liesmich(title: &str, name: &str, video_file: &str, summary: &Value, plan: &VideoPlan, has_ele: bool, source: Option<&str>) -> String {
    let km = summary["length_m"].as_f64().unwrap_or(0.0) / 1000.0;
    let asc = summary["ascent_m"].as_f64();
    let conf = summary["confidence_mean"].as_f64().unwrap_or(0.0);
    let low = summary["confidence_below_05"].as_f64().unwrap_or(0.0);
    let verdict = summary["verdict"].as_str().unwrap_or("");
    let verdict_de = match verdict { "confident" => "sicher", "uncertain" => "unsicher", "no_route" => "keine verlässliche Route", v => v };
    let enc = plan.mode == "encode";
    let mut s = String::new();
    s += &format!("{title}\n{}\n\n", "=".repeat(title.chars().count().min(70)));
    s += "DEUTSCH\n\n";
    s += &format!("Dieses Paket ist eine Videostrecke für Incyclist (Import „Eigenes Video“): {name}.xml (Steuerdatei), {video_file} (Video), {name}.gpx (Strecke, ein Punkt pro Videosekunde{}).\n\n", if has_ele { ", mit Höhen" } else { ", ohne Höhen" });
    s += &format!("Position aus dem Video rekonstruiert, kein GPS. Die Strecke wurde mit video2gpx aus der Bewegung im Video und der OpenStreetMap-Karte berechnet. Ergebnis: {verdict_de}; mittlere Sicherheit {:.0} %, {:.0} % der Zeit unter 50 %. Länge {} km{}.\n", conf * 100.0, low * 100.0, de_num(km, 1), asc.map(|a| format!(", Anstieg {a:.0} hm")).unwrap_or_default());
    s += "Die Fahrlinie ist eine Näherung (feste Verschiebung von der Straßenmitte). Die Höhen stammen aus Geländemodellen (Copernicus 30 m, wo vorhanden genauere nationale oder regionale Modelle), nicht aus einer Messung.\n\n";
    s += &format!("Quellen und Lizenzen:\n- Karte: {OSM_ATTRIB}\n");
    if has_ele {
        for a in elevation_attributions(summary) {
            s += &format!("- Höhen: {a}\n");
        }
    }
    if enc {
        s += "- Video neu kodiert mit FFmpeg (https://ffmpeg.org, LGPL) und dem Apple-VideoToolbox-Encoder.\n";
    }
    s += "\nDie Rechte am Video bleiben bei seiner Urheberin oder seinem Urheber";
    if let Some(src) = source {
        s += &format!(" ({src})");
    }
    s += ". Pakete aus Videos Dritter (z. B. YouTube) sind nur für den privaten Gebrauch bestimmt und dürfen nicht weitergegeben werden.\n\n";
    s += "ENGLISH\n\n";
    s += &format!("This package is a video route for Incyclist (\"own video\" import): {name}.xml (control file), {video_file} (video), {name}.gpx (track, one point per video second{}).\n\n", if has_ele { ", with elevation" } else { ", no elevation" });
    s += &format!("Position reconstructed from the video, no GPS. The route was computed with video2gpx from the motion in the video and the OpenStreetMap map. Result: {verdict}; mean confidence {:.0} %, {:.0} % of the time below 50 %. Length {km:.1} km{}.\n", conf * 100.0, low * 100.0, asc.map(|a| format!(", ascent {a:.0} m")).unwrap_or_default());
    s += "The driving line is an approximation (a fixed offset from the road centre). The elevation comes from terrain models (Copernicus 30 m and, where available, more detailed national or regional models), not from a measurement.\n\n";
    s += &format!("Sources and licences:\n- Map: {OSM_ATTRIB}\n");
    if has_ele {
        for a in elevation_attributions(summary) {
            s += &format!("- Elevation: {a}\n");
        }
    }
    if enc {
        s += "- Video re-encoded with FFmpeg (https://ffmpeg.org, LGPL) and Apple's VideoToolbox encoder.\n";
    }
    s += "\nThe rights to the video stay with its author";
    if let Some(src) = source {
        s += &format!(" ({src})");
    }
    s += ". Packages made from third-party videos (e.g. YouTube) are for private use only and must not be passed on.\n";
    s
}

/// the attribution lines of the elevation sources the export actually used (pipeline summary), Copernicus when the summary has none
fn elevation_attributions(summary: &Value) -> Vec<String> {
    let v: Vec<String> = summary["elevation"]["sources"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| s["attribution"].as_str().map(|x| x.to_string())).collect())
        .unwrap_or_default();
    if v.is_empty() { vec![DEM_ATTRIB.to_string()] } else { v }
}

// ---------------------------------------------------------------- the export job

fn emit_step(ctx: &Ctx, project: &str, step: u32, pct: f64, message: &str) {
    let label = ["", "Höhendaten prüfen", "Höhen übernehmen", "Video vorbereiten", "ZIP schreiben"][step as usize];
    ctx.emit("incyclist-progress", json!({"project": project, "step": step, "of": 4, "label": label, "pct": (pct * 10.0).round() / 10.0, "message": message}));
}

/// What the dialog shows before the export: the video (probe), the plan for the options, the elevation tiles, the size estimate.
pub fn info(ctx: &Ctx, project: &str, o: &ExportOptions, video: &str, online: bool) -> Result<Value, String> {
    let s = settings::load(ctx);
    let fp = settings::ffprobe(&s).ok_or("ffprobe nicht gefunden")?;
    let v = probe(&fp, video)?;
    let plan = plan_video(&v, o);
    let dem = dem_status(ctx, project, online)?;
    let out = ctx.project_dir(project)?.join("out");
    let (lat, lon) = std::fs::read_to_string(out.join("route_points.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|rp| rp["points"].as_array().and_then(|a| a.iter().find(|p| p["extrapolated"] != json!(true)).map(|p| (p["lat"].as_f64(), p["lon"].as_f64()))))
        .unwrap_or((None, None));
    let profile = profile_status(ctx, project, dem["extras"].as_object().map(|_| &dem["extras"]));
    Ok(json!({"video": v, "plan": plan, "dem": dem, "profile": profile, "est_bytes": plan.est_bytes + 2_000_000, "start": {"lat": lat, "lon": lon}, "link": source_link(video),
        "preview": preview_path(ctx, project)}))
}

/// The whole export, synchronous (the command runs it in a thread). Returns the result for `incyclist-done`.
pub fn run_export(ctx: &Ctx, project: &str, video: &str, o: &ExportOptions, dest: &Path) -> Result<Value, String> {
    let s = pipeline::require_env(ctx)?;
    let ff = settings::ffmpeg(&s).ok_or("ffmpeg nicht gefunden")?;
    let fp = settings::ffprobe(&s).ok_or("ffprobe nicht gefunden")?;
    let pdir = ctx.project_dir(project)?;
    let out = pdir.join("out");
    let work = pdir.join("export");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    let res = (|| -> Result<Value, String> {
        let name = safe_name(if o.name.trim().is_empty() { &o.title } else { &o.name });
        let title = if o.title.trim().is_empty() { name.replace('_', " ") } else { o.title.trim().to_string() };
        let country = o.country.trim().to_uppercase();
        if !country.is_empty() && !(country.len() == 2 && country.chars().all(|c| c.is_ascii_uppercase())) {
            return Err("Land: bitte einen zweistelligen ISO-Code eingeben (z. B. FR, DE, IT)".into());
        }
        let v = probe(&fp, video)?;
        if v.fps <= 0.0 {
            return Err("Bildrate des Videos unbekannt".into());
        }
        let plan = plan_video(&v, o);
        // disk space: the output (video + 10 %) and a temporary video in the project folder
        let dest_dir = dest.parent().unwrap_or(Path::new("/"));
        let need_out = plan.est_bytes + plan.est_bytes / 10 + 5_000_000;
        let need_tmp = if plan.mode == "copy" || plan.mode == "original" { 0 } else { plan.est_bytes + plan.est_bytes / 10 };
        let same_vol = free_bytes(dest_dir).is_some() && free_bytes(dest_dir) == free_bytes(&work);
        if let Some(f) = free_bytes(dest_dir) {
            let need = need_out + if same_vol { need_tmp } else { 0 };
            if f < need {
                return Err(format!("Zu wenig freier Speicher am Ziel: {:.1} GB frei, etwa {:.1} GB nötig", f as f64 / 1e9, need as f64 / 1e9));
            }
        }
        if !same_vol && need_tmp > 0 {
            if let Some(f) = free_bytes(&work) {
                if f < need_tmp {
                    return Err(format!("Zu wenig freier Speicher im Projektordner: {:.1} GB frei, etwa {:.1} GB nötig", f as f64 / 1e9, need_tmp as f64 / 1e9));
                }
            }
        }
        // 1. elevation data: nothing is downloaded here any more (the Höhe stage does that); the export uses what is cached and reuses a current profile
        emit_step(ctx, project, 1, 0.0, "");
        let tiles = tiles_for(route_bbox(&out)?, 500.0);
        let dem_dir = ctx.dem_dir();
        let missing: Vec<String> = tiles.iter().filter(|t| tile_state(&dem_dir, t) == "missing").cloned().collect();
        let dem_note = if missing.is_empty() { None } else { Some("Höhendaten fehlen; Export ohne Höhen (Incyclist fährt die Strecke flach)".to_string()) };
        if cancelled(ctx) {
            return Err(CANCELLED.into());
        }
        let have_dem = missing.is_empty();
        emit_step(ctx, project, 1, 100.0, dem_note.as_deref().unwrap_or(""));
        // 2. GPX with elevation (rsm.pipeline export)
        emit_step(ctx, project, 2, 0.0, "");
        let gpx = work.join(format!("{name}.gpx"));
        let summ_f = work.join("export_summary.json");
        let mut cmd = pipeline::pipeline_cmd(ctx, &s);
        cmd.arg("export").arg("--out").arg(&out).arg("--dest").arg(&gpx).arg("--summary").arg(&summ_f);
        cmd.args(["--fps".to_string(), format!("{}", v.fps), "--title".to_string(), title.clone(), "--app-version".to_string(), env!("CARGO_PKG_VERSION").to_string()]);
        if have_dem {
            cmd.arg("--dem-dir").arg(&dem_dir);
        }
        if let Some(t) = o.start_time.as_ref().filter(|t| !t.is_empty()) {
            cmd.args(["--start-time", t]);
        }
        let link = effective_link(o, video)?;
        if let Some(l) = &link {
            cmd.args(["--link", l]);
        }
        let mut perr: Option<String> = None;
        let (code, stderr) = run_child(ctx, &mut cmd, &mut |l| {
            if let Ok(ev) = serde_json::from_str::<Value>(l) {
                if ev["type"] == "step" {
                    emit_step(ctx, project, 2, ev["pct"].as_f64().unwrap_or(0.0), ev["phase"].as_str().unwrap_or(""));
                } else if ev["type"] == "log" && ev["level"] == "error" {
                    perr = ev["message"].as_str().map(|s| s.to_string());
                }
            }
        })?;
        if code != 0 {
            return Err(format!("GPX-Export der Pipeline fehlgeschlagen (Code {code}): {}", perr.unwrap_or_else(|| stderr.lines().last().unwrap_or("").to_string())));
        }
        let summary: Value = serde_json::from_str(&std::fs::read_to_string(&summ_f).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let has_ele = summary["elevation"]["source"].is_string();
        emit_step(ctx, project, 2, 100.0, "");
        // 3. video
        emit_step(ctx, project, 3, 0.0, &plan.reasons.join(", "));
        let (video_file, temp_video, check) = if plan.mode == "copy" || plan.mode == "original" {
            (PathBuf::from(video), None, json!({"mode": plan.mode}))
        } else {
            let tmp = work.join(format!("{name}.mp4"));
            let lut = if plan.mode == "encode" && o.sdr && v.hdr {
                let l = work.join("hdr2sdr.cube");
                std::fs::write(&l, hdr_to_sdr_cube(v.transfer == "arib-std-b67")).map_err(|e| e.to_string())?;
                Some(l)
            } else {
                None
            };
            let args = ffmpeg_args(&v, o, &plan, &tmp, lut.as_deref());
            let t1 = Instant::now();
            run_ffmpeg(ctx, &ff, &args, v.duration, &mut |p| emit_step(ctx, project, 3, p, &plan.reasons.join(", ")))?;
            let w = probe(&fp, &tmp.to_string_lossy())?;
            // the GPX is tied to the video time: the output must start at 0 and last as long as the source
            if w.start_time.abs() > 1.0 / v.fps + 1e-6 {
                return Err(format!("Das neue Video beginnt nicht bei 0 s (erste Zeit {:.3} s)", w.start_time));
            }
            if (w.duration - v.duration).abs() > 1.0 {
                return Err(format!("Das neue Video ist {:.2} s lang, das Original {:.2} s", w.duration, v.duration));
            }
            let chk = json!({"mode": plan.mode, "seconds": t1.elapsed().as_secs_f64(), "bytes": w.bytes, "codec": w.codec, "fps": w.r_frame_rate, "duration": w.duration,
                             "source_duration": v.duration, "start_time": w.start_time, "nb_frames": w.nb_frames, "source_nb_frames": v.nb_frames, "height": w.height});
            (tmp.clone(), Some(tmp), chk)
        };
        if cancelled(ctx) {
            return Err(CANCELLED.into());
        }
        emit_step(ctx, project, 3, 100.0, "");
        // 4. ZIP / folder
        emit_step(ctx, project, 4, 0.0, "");
        let proj: Value = std::fs::read_to_string(out.join("project.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
        let refine: Value = std::fs::read_to_string(out.join("refine").join("summary.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
        let rp_bytes = std::fs::read(out.join("route_points.json")).unwrap_or_default();
        let sig = format!("{}|{}|{}", v.name, v.bytes, std::fs::metadata(video).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0));
        let id = format!("video2gpx-{:016x}", fnv64(&[sig.as_bytes(), &rp_bytes]));
        let sf = summary["start_frame"].as_u64().unwrap_or(1);
        let km = summary["length_m"].as_f64().unwrap_or(0.0) / 1000.0;
        let vfile = format!("{name}.{}", if plan.mode == "original" { video_ext(video) } else { "mp4".into() });
        let xml = control_xml(&name, &vfile, &id, &country, &title, v.fps, sf, &notes(&title, km, summary["ascent_m"].as_f64(), has_ele));
        let rs = &proj["steps"]["route_search"]["summary"];
        let meta = json!({
            "format": "video2gpx-incyclist-export", "version": 1,
            "app": {"name": "video2gpx", "version": env!("CARGO_PKG_VERSION")},
            "pipeline": {"version": summary["version"], "hash": summary["pipeline_hash"], "result_hash": proj["pipeline_hash"]},
            "created": chrono_now(),
            "id": id, "name": name, "title": title, "country": country,
            "input_video": {"name": v.name, "bytes": v.bytes, "codec": v.codec, "container": v.container, "fps": v.r_frame_rate, "duration_s": v.duration, "width": v.width, "height": v.height, "hdr": v.hdr, "audio": v.audio, "source": link},
            "export_options": o,
            "video": {"plan": plan, "check": check},
            "verdict": proj["verdict"], "verdict_basis": proj["verdict_basis"], "verdict_reasons": proj["verdict_detail"]["reasons"],
            "confidence_mean": summary["confidence_mean"], "confidence_below_0_5": summary["confidence_below_05"],
            "hints_used": proj["hints_used"],
            "vehicle": proj["effective"]["vehicle"], "driving_line": {"rule": proj["driving_line"]["rule"], "offset_m": proj["effective"]["offset_m"], "traffic_side": proj["effective"]["traffic_side"]},
            "f_eff": rs["f_eff"], "kappa": rs["kappa"],
            "local_pass": refine["local"], "alignment": refine["align"], "standstill": summary["standstill"], "speed_guard": summary["speed_guard"], "points_thinned": summary["points_thinned"],
            "elevation": summary["elevation"],
            "start_frame": sf, "framerate": v.fps, "trimmed_head_s": summary["trimmed_head_s"], "trimmed_tail_s": summary["trimmed_tail_s"], "length_m": summary["length_m"], "ascent_m": summary["ascent_m"], "descent_m": summary["descent_m"],
            "sources": [
                {"what": "map", "name": "OpenStreetMap", "license": "ODbL 1.0", "attribution": OSM_ATTRIB},
                {"what": "elevation", "name": "Copernicus DEM GLO-30", "license": "Copernicus DEM licence (free use with attribution)", "attribution": DEM_ATTRIB, "used": has_ele, "tiles": summary["elevation"]["tiles"]},
                {"what": "elevation (all sources used)", "sources": summary["elevation"]["sources"].clone()},
                {"what": "video", "name": v.name, "license": "the video's rights stay with its author", "source": link},
            ],
            "notes": dem_note,
        });
        let readme = liesmich(&title, &name, &vfile, &summary, &plan, has_ele, link.as_deref());
        let mut entries: Vec<(String, Src)> = vec![
            (format!("{name}.xml"), Src::Bytes(xml.into_bytes())),
            (vfile.clone(), Src::File(video_file.clone())),
            (format!("{name}.gpx"), Src::Bytes(std::fs::read(&gpx).map_err(|e| e.to_string())?)),
            ("video2gpx.json".into(), Src::Bytes(serde_json::to_vec_pretty(&meta).unwrap())),
            ("LIESMICH.txt".into(), Src::Bytes(readme.into_bytes())),
        ];
        if let Some(p) = preview_path(ctx, project) {
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("jpg").to_string();
            entries.insert(3, (format!("{name}_preview.{ext}"), Src::File(p)));
        }
        let c2 = ctx.clone();
        let cancel_f = move || cancelled(&c2);
        let mut prog = |d: u64, t: u64| emit_step(ctx, project, 4, if t > 0 { 100.0 * d as f64 / t as f64 } else { 0.0 }, &format!("{:.1} von {:.1} GB", d as f64 / 1e9, t as f64 / 1e9));
        let bytes = if o.folder {
            let moves: Vec<PathBuf> = temp_video.iter().cloned().collect();
            write_folder(dest, &entries, &moves, &cancel_f, &mut prog)?
        } else {
            write_zip(dest, &entries, &cancel_f, &mut prog)?
        };
        Ok(json!({"path": dest, "bytes": bytes, "folder": o.folder, "name": name, "id": id, "length_m": summary["length_m"], "ascent_m": summary["ascent_m"], "has_ele": has_ele,
                  "start_frame": sf, "video": check, "plan": plan, "note": dem_note, "seconds": t0.elapsed().as_secs_f64()}))
    })();
    let _ = std::fs::remove_dir_all(&work);
    res
}

fn chrono_now() -> String {
    let (y, m, d, h, mi, s) = now_parts();
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// ZIP timestamps are local time (DOS format)
fn local_zip_time() -> zip::DateTime {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as libc::time_t).unwrap_or(0);
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
        return zip::DateTime::default();
    }
    zip::DateTime::from_date_and_time((tm.tm_year + 1900) as u16, (tm.tm_mon + 1) as u8, tm.tm_mday as u8, tm.tm_hour as u8, tm.tm_min as u8, tm.tm_sec.min(59) as u8).unwrap_or_default()
}

/// UTC now as (year, month, day, hour, minute, second)
fn now_parts() -> (i64, i64, i64, u64, u64, u64) {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // civil from days (UTC), Howard Hinnant's algorithm
    let (days, rem) = ((secs / 86400) as i64, secs % 86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d, rem / 3600, rem % 3600 / 60, rem % 60)
}

/// `incyclist_export` command: one job at a time, in a thread; events `incyclist-progress` and `incyclist-done`.
pub fn export(ctx: &Ctx, project: &str, video: &str, o: ExportOptions, dest: &str) -> Result<(), String> {
    if dest.is_empty() {
        return Err("Kein Ziel gewählt".into());
    }
    effective_link(&o, video)?;
    if ctx.running.export_active.swap(true, Ordering::SeqCst) {
        return Err("Es läuft bereits ein Export".into());
    }
    ctx.running.export_cancel.store(false, Ordering::SeqCst);
    let (c, p, v, d) = (ctx.clone(), project.to_string(), video.to_string(), PathBuf::from(dest));
    std::thread::spawn(move || {
        let r = run_export(&c, &p, &v, &o, &d);
        c.running.export_active.store(false, Ordering::SeqCst);
        match r {
            Ok(v) => c.emit("incyclist-done", json!({"project": p, "ok": true, "result": v})),
            Err(e) if e == CANCELLED => c.emit("incyclist-done", json!({"project": p, "ok": false, "cancelled": true})),
            Err(e) => c.emit("incyclist-done", json!({"project": p, "ok": false, "error": e})),
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_ascii_safe() {
        assert_eq!(safe_name("FR Col de la Madone"), "FR_Col_de_la_Madone");
        assert_eq!(safe_name("Vallée de Roanne – Pontaix & Chamaloc"), "Vallee_de_Roanne_Pontaix_Chamaloc");
        assert_eq!(safe_name("Straße über Ölberg"), "Strasse_ueber_Oelberg");
        assert_eq!(safe_name("🇫🇷 !!"), "video2gpx_route");
        assert_eq!(safe_name("Rousset - 3 - Pontaix, Chamaloc"), "Rousset_3_Pontaix_Chamaloc");
        assert_eq!(safe_name("Rond-Point Saint-Roch"), "Rond-Point_Saint-Roch");
        assert!(safe_name(&"x".repeat(100)).len() == 60);
    }

    #[test]
    fn control_xml_is_escaped_and_parses() {
        let n = notes("Col & \"Grat\" <Süd>", 22.94, Some(980.4), true);
        let x = control_xml("FR_Col", "FR_Col.mp4", "video2gpx-0011223344556677", "FR", "Col & \"Grat\" <Süd>", 30000.0 / 1001.0, 1051, &n);
        assert!(x.contains("<title>Col &amp; \"Grat\" &lt;Süd&gt;</title>"));
        assert!(x.contains("de=\"Col &amp; &quot;Grat&quot; &lt;Süd&gt;\\nLänge: 22,9 km – Anstieg: 980 hm\""));
        assert!(x.contains("<framerate>29.97003</framerate>") && x.contains("<start-frame>1051</start-frame>"));
        assert!(x.contains("<video-file-path>FR_Col.mp4</video-file-path>") && x.contains("<gpx-file-path>FR_Col.gpx</gpx-file-path>"));
        assert_eq!(fmt_fps(50.0), "50.0");
        assert_eq!(fmt_fps(30.0), "30.0");
        // no raw '&' or '<' inside attribute values
        for line in x.lines().filter(|l| l.contains("<information ")) {
            let inner = &line[line.find("de=").unwrap()..line.rfind("/>").unwrap()];
            assert!(!inner.contains('<') && !inner.replace("&amp;", "").replace("&quot;", "").replace("&lt;", "").replace("&gt;", "").contains('&'));
        }
    }

    #[test]
    fn id_is_stable() {
        assert_eq!(fnv64(&[b"a", b"b"]), fnv64(&[b"a", b"b"]));
        assert_ne!(fnv64(&[b"ab", b""]), fnv64(&[b"a", b"b"]));
        assert_eq!(format!("{:016x}", fnv64(&[b""])).len(), 16);
    }

    #[test]
    fn tiles_and_links() {
        assert_eq!(tile_name(43, 7), "Copernicus_DSM_COG_10_N43_00_E007_00_DEM");
        assert_eq!(tile_name(-1, -2), "Copernicus_DSM_COG_10_S01_00_W002_00_DEM");
        assert!(valid_tile(&tile_name(43, 7)) && !valid_tile("../x"));
        assert_eq!(tiles_for([43.77, 7.40, 43.80, 7.52], 500.0), vec![tile_name(43, 7)]);
        assert_eq!(tiles_for([43.998, 6.9995, 44.2, 7.2], 500.0).len(), 4);
        assert_eq!(source_link("/v/Route du Col [aBcDeFgHiJk].webm").as_deref(), Some("https://www.youtube.com/watch?v=aBcDeFgHiJk"));
        assert_eq!(source_link("/v/video.mp4"), None);
        let with = |u: Option<&str>| ExportOptions { source_url: u.map(String::from), ..Default::default() };
        let yt = "/v/Route du Col [aBcDeFgHiJk].webm";
        assert_eq!(effective_link(&with(None), yt).unwrap().as_deref(), Some("https://www.youtube.com/watch?v=aBcDeFgHiJk"));
        assert_eq!(effective_link(&with(Some("  ")), yt).unwrap(), None);
        assert_eq!(effective_link(&with(Some(" https://vimeo.com/1 ")), yt).unwrap().as_deref(), Some("https://vimeo.com/1"));
        assert!(effective_link(&with(Some("javascript:alert(1)")), yt).is_err());
        assert!(effective_link(&with(Some("https://")), yt).is_err());
        assert!(effective_link(&with(Some("https://a b")), yt).is_err());
    }

    fn vi(container: &str, codec: &str, audio: Option<&str>, hdr: bool, h: u64) -> VideoInfo {
        VideoInfo { container: container.into(), codec: codec.into(), audio: audio.map(String::from), hdr, height: h, width: h * 16 / 9, duration: 100.0, bytes: 1_000_000_000, fps: 50.0, ..Default::default() }
    }

    #[test]
    fn profile_blocks_and_diag() {
        let plan = json!({"sources": {"nasadem": {"blocks": 2, "missing": 1}, "it_tinitaly": {"blocks": 12, "missing": 0}}});
        let rec = |v: Value| v.as_object().unwrap().clone();
        assert!(!blocks_differ(&plan, &rec(json!({"nasadem": 1, "it_tinitaly": 12}))));
        assert!(blocks_differ(&plan, &rec(json!({"nasadem": 2, "it_tinitaly": 12}))), "a block was removed");
        assert!(blocks_differ(&plan, &rec(json!({"nasadem": 1}))), "a source was added");
        assert!(!blocks_differ(&Value::Null, &rec(json!({"nasadem": 1}))), "no plan, no verdict");
        // the diagnostics: null without a file, the file's content with one
        let d = tmpdir("diag");
        let ctx = Ctx::new(d.clone(), std::sync::Arc::new(|_, _| {}));
        std::fs::create_dir_all(ctx.projects_dir().join("p").join("out")).unwrap();
        assert_eq!(profile_diag(&ctx, "p").unwrap(), Value::Null);
        assert_eq!(profile_status(&ctx, "p", None)["state"], "missing");
        std::fs::write(ctx.projects_dir().join("p").join("out").join("elevation_diag.json"), r#"{"version":2,"n":3}"#).unwrap();
        assert_eq!(profile_diag(&ctx, "p").unwrap()["n"], 3);
        std::fs::write(ctx.projects_dir().join("p").join("out").join("elevation_diag.json"), "{").unwrap();
        assert!(profile_diag(&ctx, "p").is_err());
        assert!(profile_diag(&ctx, "../x").is_err());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn video_ladder() {
        let o = ExportOptions::default();
        assert_eq!(plan_video(&vi("mov,mp4,m4a,3gp,3g2,mj2", "av1", None, false, 720), &o).mode, "copy");
        assert_eq!(plan_video(&vi("mov,mp4,m4a,3gp,3g2,mj2", "h264", Some("aac"), false, 720), &o).mode, "remux"); // audio dropped
        assert_eq!(plan_video(&vi("mov,mp4,m4a,3gp,3g2,mj2", "h264", Some("aac"), false, 720), &ExportOptions { drop_audio: false, ..o.clone() }).mode, "copy");
        assert_eq!(plan_video(&vi("matroska,webm", "av1", Some("opus"), true, 2160), &o).mode, "remux");
        assert_eq!(plan_video(&vi("matroska,webm", "vp9", None, false, 2160), &o).mode, "remux");
        assert_eq!(plan_video(&vi("mpegts", "mpeg2video", None, false, 1080), &o).mode, "encode");
        assert_eq!(plan_video(&vi("matroska,webm", "av1", None, true, 2160), &ExportOptions { sdr: true, ..o.clone() }).mode, "encode");
        let p = plan_video(&vi("matroska,webm", "av1", None, false, 2160), &ExportOptions { max_height: Some(1080), ..o.clone() });
        assert_eq!((p.mode.as_str(), p.out_height), ("encode", 1080));
        assert_eq!(plan_video(&vi("matroska,webm", "av1", None, false, 1080), &ExportOptions { max_height: Some(1080), ..o.clone() }).mode, "remux");
        // no conversion: the source as it is, even where the ladder would re-encode; the package keeps its extension
        let raw = ExportOptions { convert: false, sdr: true, max_height: Some(1080), ..o.clone() };
        let p = plan_video(&VideoInfo { path: "/v/Ride.MKV".into(), ..vi("matroska,webm", "mpeg2video", Some("opus"), true, 2160) }, &raw);
        assert_eq!((p.mode.as_str(), p.est_bytes, p.out_height), ("original", 1_000_000_000, 2160));
        assert_eq!((video_ext("/v/Ride.MKV"), video_ext("/v/noext"), video_ext("/v/a.b c")), ("mkv".to_string(), "mp4".to_string(), "mp4".to_string()));
        let x = control_xml("FR_Col", "FR_Col.mkv", "id", "", "T", 30.0, 1, &[]);
        assert!(x.contains("<video-file-path>FR_Col.mkv</video-file-path>"));
        let old: ExportOptions = serde_json::from_str(r#"{"title":"t","drop_audio":false}"#).unwrap();
        assert!(old.convert, "saved options from before the checkbox keep converting");
        let v = vi("matroska,webm", "av1", Some("opus"), true, 2160);
        let a = ffmpeg_args(&v, &o, &plan_video(&v, &o), Path::new("/t/x.mp4"), None).join(" ");
        assert!(a.contains("-c:v copy") && a.contains("-an") && a.contains("+faststart") && !a.contains("0:a:0"));
        let o2 = ExportOptions { sdr: true, max_height: Some(1440), ..o.clone() };
        let a2 = ffmpeg_args(&v, &o2, &plan_video(&v, &o2), Path::new("/t/x.mp4"), Some(Path::new("/t/l.cube"))).join(" ");
        assert!(a2.contains("hevc_videotoolbox") && a2.contains("-fps_mode passthrough") && a2.contains("lut3d=file='/t/l.cube'") && a2.contains("scale=-2:1440"));
    }

    #[test]
    fn hdr_lut_is_monotone_and_in_range() {
        let c = hdr_to_sdr_cube(false);
        let vals: Vec<f64> = c.lines().skip(2).map(|l| l.split(' ').next().unwrap().parse().unwrap()).collect();
        assert_eq!(vals.len(), 33 * 33 * 33);
        assert!(vals.iter().all(|v| (0.0..=1.0).contains(v)));
        let reds: Vec<f64> = (0..33).map(|i| vals[i]).collect(); // r varies fastest, g = b = 0
        assert!(reds.windows(2).all(|w| w[1] >= w[0]) && reds[0] == 0.0 && reds[32] > 0.9);
    }

    #[test]
    fn image_kinds() {
        assert_eq!(image_kind(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(image_kind(&[0xff, 0xd8, 0xff, 0xe0, 0, 0]), Some("jpg"));
        assert_eq!(image_kind(b"RIFF....WEBP"), None);
        assert_eq!(image_kind(b""), None);
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("v2g-inc-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn zip_part_rename_and_contents() {
        let d = tmpdir("zip");
        let v = d.join("v.bin");
        std::fs::write(&v, vec![7u8; 3_000_000]).unwrap();
        let dest = d.join("p.zip");
        let mut last = (0, 0);
        let n = write_zip(&dest, &[("a.xml".into(), Src::Bytes(b"<x/>".to_vec())), ("a.mp4".into(), Src::File(v.clone()))], &|| false, &mut |a, b| last = (a, b)).unwrap();
        assert!(n > 3_000_000 && dest.exists() && !part_of(&dest).exists() && last.0 == last.1);
        let mut z = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
        assert_eq!(z.by_name("a.mp4").unwrap().compression(), zip::CompressionMethod::Stored);
        assert_eq!(z.by_name("a.xml").unwrap().compression(), zip::CompressionMethod::Deflated);
        let mut s = String::new();
        z.by_name("a.xml").unwrap().read_to_string(&mut s).unwrap();
        assert_eq!(s, "<x/>");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn cancel_and_errors_leave_nothing() {
        let d = tmpdir("cancel");
        let v = d.join("v.bin");
        std::fs::write(&v, vec![1u8; 12_000_000]).unwrap();
        let dest = d.join("p.zip");
        let r = write_zip(&dest, &[("a.mp4".into(), Src::File(v.clone()))], &|| true, &mut |_, _| {});
        assert_eq!(r.unwrap_err(), CANCELLED);
        assert!(!dest.exists() && !part_of(&dest).exists());
        let r = write_zip(&dest, &[("a.mp4".into(), Src::File(d.join("missing.mp4")))], &|| false, &mut |_, _| {});
        assert!(r.is_err() && !dest.exists() && !part_of(&dest).exists());
        let fdest = d.join("folder");
        let r = write_folder(&fdest, &[("a.mp4".into(), Src::File(v.clone()))], &[], &|| true, &mut |_, _| {});
        assert!(r.is_err() && !fdest.exists() && !part_of(&fdest).exists());
        write_folder(&fdest, &[("a.mp4".into(), Src::File(v.clone())), ("b.txt".into(), Src::Bytes(b"x".to_vec()))], &[], &|| false, &mut |_, _| {}).unwrap();
        assert!(fdest.join("a.mp4").exists() && fdest.join("b.txt").exists() && v.exists());
        let _ = std::fs::remove_dir_all(d);
    }

    /// Writes about 4.3 GB (stored) from a sparse source: run explicitly with `cargo test --lib zip64 -- --ignored`.
    #[test]
    #[ignore]
    fn zip64_over_4_gb() {
        let d = tmpdir("zip64");
        let v = d.join("big.bin");
        let size: u64 = (1u64 << 32) + 12_345;
        let f = std::fs::File::create(&v).unwrap();
        f.set_len(size).unwrap(); // sparse
        let dest = d.join("big.zip");
        write_zip(&dest, &[("x.xml".into(), Src::Bytes(b"<x/>".to_vec())), ("big.mp4".into(), Src::File(v.clone())), ("y.txt".into(), Src::Bytes(b"after".to_vec()))], &|| false, &mut |_, _| {}).unwrap();
        let mut z = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
        assert_eq!(z.by_name("big.mp4").unwrap().size(), size);
        let mut s = String::new();
        z.by_name("y.txt").unwrap().read_to_string(&mut s).unwrap();
        assert_eq!(s, "after");
        let _ = std::fs::remove_dir_all(d);
    }
}

/// The blocks per source that a plan (`dem-plan`) finds in the cache now, against the record in the profile. An unreadable plan never differs.
fn blocks_differ(plan: &Value, recorded: &serde_json::Map<String, Value>) -> bool {
    let Some(srcs) = plan["sources"].as_object() else { return false };
    let now: std::collections::BTreeMap<&str, i64> = srcs.iter().map(|(k, v)| (k.as_str(), v["blocks"].as_i64().unwrap_or(0) - v["missing"].as_i64().unwrap_or(0))).collect();
    let then: std::collections::BTreeMap<&str, i64> = recorded.iter().map(|(k, v)| (k.as_str(), v.as_i64().unwrap_or(0))).collect();
    now != then
}

/// Is a stored profile still the one the app would make now? Reasons for "stale": `result` (the result was made again), `pipeline` (made by
/// other pipeline code), `blocks` (a source block of the route was added or removed since), `stamp` (legacy profile without a block record, extra
/// data downloaded after it). Returns None when it is current.
fn profile_stale(ctx: &Ctx, out: &Path, prof: &Path, p: &Value, plan: Option<&Value>) -> Option<&'static str> {
    let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    if mtime(prof) < mtime(&out.join("refine").join("result.npz")) {
        return Some("result");
    }
    let s = settings::load(ctx);
    if let (Some(now), Some(then)) = (pipeline::code_hash(ctx, &s), p["pipeline_hash"].as_str()) {
        if now != then {
            return Some("pipeline");
        }
    }
    match p["blocks"].as_object() {
        Some(rec) => {
            let own;
            let plan = match plan { Some(p) => p, None => { own = extras_plan(ctx, out); &own } };
            if blocks_differ(plan, rec) {
                return Some("blocks");
            }
        }
        None if mtime(prof) < mtime(&extras_stamp(ctx)) => return Some("stamp"),
        None => {}
    }
    None
}

/// Elevation profile of a finished result (`out/elevation_profile.json`, made by `rsm.pipeline profile`, next to it `elevation_diag.json`).
/// Computes it when it is missing (or `recompute`) and the DEM tiles are present; otherwise reports the missing tiles. A stored profile that is
/// no longer current (see `profile_stale`) is returned with `stale: true` and recomputed only with `recompute` (the Höhe stage asks for that;
/// the playback panel is happy with the old one).
pub fn profile_load(ctx: &Ctx, project: &str, recompute: bool) -> Result<Value, String> {
    let out = ctx.project_dir(project)?.join("out");
    let res = out.join("refine").join("result.npz");
    let prof = out.join("elevation_profile.json");
    if !res.exists() {
        return Ok(json!({"ready": false, "reason": "no_result"}));
    }
    if prof.exists() {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&prof).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let stale = profile_stale(ctx, &out, &prof, &v, None);
        // an outdated result is always made again; otherwise only on request
        if stale.is_none() || (stale != Some("result") && !recompute) {
            return Ok(json!({"ready": true, "profile": v, "stale": stale.is_some(), "stale_reason": stale}));
        }
    }
    let st = dem_status(ctx, project, false)?;
    if st["ready"] != true {
        return Ok(json!({"ready": false, "reason": "dem_missing", "dem": st}));
    }
    let s = crate::settings::load(ctx);
    let mut cmd = pipeline::pipeline_cmd(ctx, &s);
    cmd.arg("profile").arg("--out").arg(&out).arg("--dest").arg(&prof).arg("--dem-dir").arg(ctx.dem_dir());
    let o = cmd.output().map_err(|e| format!("Pipeline nicht startbar: {e}"))?;
    if !o.status.success() || !prof.exists() {
        let msg = String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .find(|ev| ev["type"] == "log" && ev["level"] == "error")
            .and_then(|ev| ev["message"].as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or("").to_string());
        return Ok(json!({"ready": false, "reason": "error", "error": msg}));
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&prof).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(json!({"ready": true, "profile": v, "stale": false, "stale_reason": null}))
}

/// The diagnostics of the profile (`out/elevation_diag.json`, version 2): null when there is none (a profile of an older pipeline). A separate
/// command rather than part of `profile_load`: the file is large (about 1 MB per 60 km) and only the Höhe stage needs it.
pub fn profile_diag(ctx: &Ctx, project: &str) -> Result<Value, String> {
    let f = ctx.project_dir(project)?.join("out").join("elevation_diag.json");
    match std::fs::read_to_string(&f) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("elevation_diag.json: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}

/// What the export dialog says about the profile: `state` current / stale / missing, and the sources it was made from. Never computes.
pub fn profile_status(ctx: &Ctx, project: &str, plan: Option<&Value>) -> Value {
    let Ok(pd) = ctx.project_dir(project) else { return json!({"state": "missing"}) };
    let out = pd.join("out");
    let prof = out.join("elevation_profile.json");
    let Some(v) = std::fs::read_to_string(&prof).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return json!({"state": "missing"}) };
    let stale = profile_stale(ctx, &out, &prof, &v, plan);
    json!({"state": if stale.is_some() { "stale" } else { "current" }, "reason": stale, "source": v["source"], "ascent_m": v["ascent_m"], "descent_m": v["descent_m"]})
}
