//! Local OSM extracts: header bbox, list, link, Geofabrik index and download.
use crate::ctx::Ctx;
use crate::settings;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

const UA: &str = "video2gpx/0.1 (desktop beta; open-source tool)";
pub const GEOFABRIK_INDEX: &str = "https://download.geofabrik.de/index-v1.json";

// ---------- minimal protobuf reader for the .osm.pbf header block ----------

fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    let mut shift = 0;
    loop {
        let byte = *b.get(*i)?;
        *i += 1;
        v |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(v);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

enum Field<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

fn fields(b: &[u8]) -> Vec<(u32, Field<'_>)> {
    let mut i = 0;
    let mut out = vec![];
    while i < b.len() {
        let Some(key) = varint(b, &mut i) else { break };
        let (num, wt) = ((key >> 3) as u32, key & 7);
        match wt {
            0 => {
                let Some(v) = varint(b, &mut i) else { break };
                out.push((num, Field::Varint(v)));
            }
            1 => i += 8,
            5 => i += 4,
            2 => {
                let Some(l) = varint(b, &mut i) else { break };
                let l = l as usize;
                if i + l > b.len() {
                    break;
                }
                out.push((num, Field::Bytes(&b[i..i + l])));
                i += l;
            }
            _ => break,
        }
    }
    out
}

fn zigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

/// Header bbox of an .osm.pbf as [south, west, north, east] in degrees, or None if the file has none.
pub fn header_bbox(path: &Path) -> Result<Option<[f64; 4]>, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut len = [0u8; 4];
    f.read_exact(&mut len).map_err(|e| e.to_string())?;
    let hl = u32::from_be_bytes(len) as usize;
    if hl == 0 || hl > 64 * 1024 {
        return Err("keine .osm.pbf-Datei (BlobHeader)".into());
    }
    let mut bh = vec![0u8; hl];
    f.read_exact(&mut bh).map_err(|e| e.to_string())?;
    let mut typ = String::new();
    let mut datasize = 0usize;
    for (n, v) in fields(&bh) {
        match (n, v) {
            (1, Field::Bytes(b)) => typ = String::from_utf8_lossy(b).to_string(),
            (3, Field::Varint(x)) => datasize = x as usize,
            _ => {}
        }
    }
    if typ != "OSMHeader" || datasize == 0 || datasize > 32 * 1024 * 1024 {
        return Err("keine .osm.pbf-Datei (kein OSMHeader)".into());
    }
    let mut blob = vec![0u8; datasize];
    f.read_exact(&mut blob).map_err(|e| e.to_string())?;
    let mut raw: Option<Vec<u8>> = None;
    for (n, v) in fields(&blob) {
        match (n, v) {
            (1, Field::Bytes(b)) => raw = Some(b.to_vec()),
            (3, Field::Bytes(b)) => {
                let mut out = vec![];
                flate2::read::ZlibDecoder::new(b).read_to_end(&mut out).map_err(|e| e.to_string())?;
                raw = Some(out);
            }
            _ => {}
        }
    }
    let raw = raw.ok_or("Header-Blob ohne Daten")?;
    for (n, v) in fields(&raw) {
        if let (1, Field::Bytes(bb)) = (n, v) {
            let (mut l, mut r, mut t, mut b) = (0i64, 0i64, 0i64, 0i64);
            for (n2, v2) in fields(bb) {
                if let Field::Varint(x) = v2 {
                    match n2 {
                        1 => l = zigzag(x),
                        2 => r = zigzag(x),
                        3 => t = zigzag(x),
                        4 => b = zigzag(x),
                        _ => {}
                    }
                }
            }
            let d = 1e9;
            return Ok(Some([b as f64 / d, l as f64 / d, t as f64 / d, r as f64 / d]));
        }
    }
    Ok(None)
}

pub fn covers(extract: &[f64; 4], bbox: &[f64; 4]) -> bool {
    // [S, W, N, E]
    extract[0] <= bbox[0] && extract[1] <= bbox[1] && extract[2] >= bbox[2] && extract[3] >= bbox[3]
}

// ---------- list / link ----------

fn info(path: &Path, linked: bool) -> Value {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let meta = std::fs::metadata(path);
    match (meta, header_bbox(path)) {
        (Ok(m), Ok(bb)) => json!({"path": path, "name": name, "bytes": m.len(), "bbox": bb, "linked": linked, "missing": false}),
        (Ok(m), Err(e)) => json!({"path": path, "name": name, "bytes": m.len(), "bbox": null, "linked": linked, "missing": false, "error": e}),
        _ => json!({"path": path, "name": name, "bytes": 0, "bbox": null, "linked": linked, "missing": true}),
    }
}

pub fn list(ctx: &Ctx) -> Vec<Value> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(ctx.osm_dir()) {
        let mut files: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.to_string_lossy().ends_with(".osm.pbf")).collect();
        files.sort();
        for p in files {
            out.push(info(&p, false));
        }
    }
    for p in settings::load(ctx).linked_pbfs {
        out.push(info(Path::new(&p), true));
    }
    out
}

pub fn link(ctx: &Ctx, path: &str) -> Result<Value, String> {
    let p = Path::new(path);
    if !p.to_string_lossy().ends_with(".pbf") {
        return Err("Bitte eine .osm.pbf-Datei wählen".into());
    }
    header_bbox(p)?; // validates the file
    let mut s = settings::load(ctx);
    if !s.linked_pbfs.iter().any(|x| x == path) {
        s.linked_pbfs.push(path.to_string());
        settings::save(ctx, &s)?;
    }
    Ok(info(p, true))
}

/// Linked files are only unlinked (the file stays); downloaded files are deleted.
pub fn remove(ctx: &Ctx, path: &str) -> Result<(), String> {
    let mut s = settings::load(ctx);
    if s.linked_pbfs.iter().any(|x| x == path) {
        s.linked_pbfs.retain(|x| x != path);
        return settings::save(ctx, &s);
    }
    let p = Path::new(path);
    if p.parent() == Some(ctx.osm_dir().as_path()) && path.ends_with(".osm.pbf") {
        return std::fs::remove_file(p).map_err(|e| e.to_string());
    }
    Err("Nur Dateien im App-Ordner oder verknüpfte Dateien können entfernt werden".into())
}

// ---------- Geofabrik ----------

fn http_get(url: &str) -> Result<ureq::Response, String> {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))
        .user_agent(UA)
        .build()
        .get(url)
        .call()
        .map_err(|e| format!("Netzwerkfehler ({url}): {e}"))
}

fn index_cache(ctx: &Ctx) -> PathBuf {
    ctx.cache_dir().join("geofabrik-index-v1.json")
}

/// The Geofabrik index (regions with polygon and pbf URL). Cached for a week. Fetched only on the user's action.
pub fn geofabrik_index(ctx: &Ctx, fetch: bool) -> Result<Value, String> {
    let cache = index_cache(ctx);
    let fresh = std::fs::metadata(&cache).and_then(|m| m.modified()).map(|t| t.elapsed().map(|e| e < Duration::from_secs(7 * 86400)).unwrap_or(false)).unwrap_or(false);
    if fresh || (!fetch && cache.exists()) {
        if let Ok(s) = std::fs::read_to_string(&cache) {
            if let Ok(v) = serde_json::from_str(&s) {
                return Ok(v);
            }
        }
    }
    if !fetch {
        return Err("Geofabrik-Index noch nicht geladen".into());
    }
    let mut body = String::new();
    http_get(GEOFABRIK_INDEX)?.into_reader().take(64 * 1024 * 1024).read_to_string(&mut body).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&body).map_err(|e| format!("Index nicht lesbar: {e}"))?;
    let _ = std::fs::write(&cache, body);
    Ok(v)
}

fn ring_contains(ring: &[Value], lon: f64, lat: f64) -> bool {
    let mut inside = false;
    let n = ring.len();
    let pt = |i: usize| (ring[i][0].as_f64().unwrap_or(0.0), ring[i][1].as_f64().unwrap_or(0.0));
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (xi, yi) = pt(i);
        let (xj, yj) = pt(j);
        if (yi > lat) != (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Point in a Polygon / MultiPolygon geometry (outer rings with even-odd holes).
pub fn geom_contains(g: &Value, lon: f64, lat: f64) -> bool {
    let poly_has = |rings: &Value| -> bool {
        let Some(rs) = rings.as_array() else { return false };
        let mut c = 0;
        for r in rs {
            if let Some(a) = r.as_array() {
                if ring_contains(a, lon, lat) {
                    c += 1;
                }
            }
        }
        c % 2 == 1
    };
    match g["type"].as_str() {
        Some("Polygon") => poly_has(&g["coordinates"]),
        Some("MultiPolygon") => g["coordinates"].as_array().map(|ps| ps.iter().any(|p| poly_has(p))).unwrap_or(false),
        _ => false,
    }
}

fn geom_bbox_area(g: &Value) -> f64 {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    fn walk(v: &Value, f: &mut dyn FnMut(f64, f64)) {
        if let Some(a) = v.as_array() {
            if a.len() >= 2 && a[0].is_f64() && a[1].is_f64() {
                f(a[0].as_f64().unwrap(), a[1].as_f64().unwrap());
            } else {
                for x in a {
                    walk(x, f);
                }
            }
        }
    }
    walk(&g["coordinates"], &mut |x, y| {
        x0 = x0.min(x);
        x1 = x1.max(x);
        y0 = y0.min(y);
        y1 = y1.max(y);
    });
    (x1 - x0) * (y1 - y0)
}

fn bbox_samples(b: &[f64; 4]) -> Vec<(f64, f64)> {
    // (lon, lat) for corners, edge middles and centre
    let (s, w, n, e) = (b[0], b[1], b[2], b[3]);
    let (cx, cy) = ((w + e) / 2.0, (s + n) / 2.0);
    vec![(w, s), (e, s), (w, n), (e, n), (cx, s), (cx, n), (w, cy), (e, cy), (cx, cy)]
}

/// Regions whose polygon contains the bbox (all sample points), the smallest first; sizes by HEAD for the smallest few.
pub fn geofabrik_candidates(ctx: &Ctx, bbox: &[f64; 4]) -> Result<Vec<Value>, String> {
    let idx = geofabrik_index(ctx, true)?;
    let feats = idx["features"].as_array().ok_or("Index ohne features")?;
    let samples = bbox_samples(bbox);
    let mut cands: Vec<(f64, &Value)> = feats
        .iter()
        .filter(|f| f["properties"]["urls"]["pbf"].is_string())
        .filter(|f| samples.iter().all(|(lon, lat)| geom_contains(&f["geometry"], *lon, *lat)))
        .map(|f| (geom_bbox_area(&f["geometry"]), f))
        .collect();
    cands.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut out = vec![];
    for (_, f) in cands.into_iter().take(4) {
        let p = &f["properties"];
        let url = p["urls"]["pbf"].as_str().unwrap().to_string();
        let size = ureq::AgentBuilder::new().user_agent(UA).timeout(Duration::from_secs(20)).build().head(&url).call().ok().and_then(|r| r.header("Content-Length").and_then(|s| s.parse::<u64>().ok()));
        let id = p["id"].as_str().unwrap_or("");
        let parent = p["parent"].as_str().unwrap_or("");
        out.push(json!({"id": id, "name": p["name"], "parent": parent, "url": url, "bytes": size,
                        "file": format!("{}.osm.pbf", url.rsplit('/').next().unwrap_or(id).trim_end_matches("-latest.osm.pbf"))}));
    }
    out.sort_by_key(|v| v["bytes"].as_u64().unwrap_or(u64::MAX));
    Ok(out)
}

/// Used by the title search: does a local extract plausibly contain this point? A Geofabrik polygon (matched by the file's
/// id, e.g. rhone-alpes.osm.pbf) is used if the index is cached, otherwise the header bbox.
pub fn local_covers_point(ctx: &Ctx, lat: f64, lon: f64) -> Option<String> {
    let idx = geofabrik_index(ctx, false).ok();
    for p in list(ctx) {
        let Some(bb) = p["bbox"].as_array().and_then(|a| if a.len() == 4 { Some([a[0].as_f64()?, a[1].as_f64()?, a[2].as_f64()?, a[3].as_f64()?]) } else { None }) else { continue };
        if !(bb[0] <= lat && lat <= bb[2] && bb[1] <= lon && lon <= bb[3]) {
            continue;
        }
        let name = p["name"].as_str().unwrap_or("").trim_end_matches(".osm.pbf").trim_end_matches("-latest").to_string();
        if let Some(ix) = &idx {
            if let Some(f) = ix["features"].as_array().and_then(|fs| fs.iter().find(|f| f["properties"]["id"].as_str() == Some(name.as_str()))) {
                if !geom_contains(&f["geometry"], lon, lat) {
                    continue;
                }
            }
        }
        return p["path"].as_str().map(|s| s.to_string());
    }
    None
}

/// Download with progress events and cancel. Only called from the user's click.
pub fn download(ctx: &Ctx, id: &str, url: &str, file: &str) -> Result<(), String> {
    if !url.starts_with("https://download.geofabrik.de/") || !url.ends_with(".osm.pbf") {
        return Err("Nur Geofabrik-URLs (https://download.geofabrik.de/….osm.pbf) sind erlaubt".into());
    }
    if file.contains('/') || file.contains("..") || !file.ends_with(".osm.pbf") {
        return Err("Ungültiger Dateiname".into());
    }
    if ctx.running.download_active.swap(true, Ordering::SeqCst) {
        return Err("Es läuft bereits ein Download".into());
    }
    ctx.running.download_cancel.store(false, Ordering::SeqCst);
    let ctx2 = ctx.clone();
    let (id, url, file) = (id.to_string(), url.to_string(), file.to_string());
    std::thread::spawn(move || {
        let dest = ctx2.osm_dir().join(&file);
        let part = ctx2.osm_dir().join(format!("{file}.part"));
        let res = (|| -> Result<bool, String> {
            let resp = http_get(&url)?;
            let total: u64 = resp.header("Content-Length").and_then(|s| s.parse().ok()).unwrap_or(0);
            let mut rd = resp.into_reader();
            let mut f = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            let (mut done, mut last, t0) = (0u64, Instant::now(), Instant::now());
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                if ctx2.running.download_cancel.load(Ordering::SeqCst) {
                    return Ok(false);
                }
                let n = rd.read(&mut buf).map_err(|e| format!("Download abgebrochen: {e}"))?;
                if n == 0 {
                    break;
                }
                f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                done += n as u64;
                if last.elapsed() > Duration::from_millis(300) {
                    last = Instant::now();
                    let rate = done as f64 / t0.elapsed().as_secs_f64().max(0.001);
                    ctx2.emit("download-progress", json!({"id": id, "bytes": done, "total": total, "rate": rate}));
                }
            }
            f.flush().map_err(|e| e.to_string())?;
            if total > 0 && done != total {
                return Err(format!("Unvollständig: {done} von {total} Bytes"));
            }
            header_bbox(&part).map_err(|e| format!("Heruntergeladene Datei ungültig: {e}"))?;
            std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
            Ok(true)
        })();
        let _ = res.as_ref().map(|ok| if !*ok { let _ = std::fs::remove_file(&part); });
        if res.is_err() {
            let _ = std::fs::remove_file(&part);
        }
        ctx2.running.download_active.store(false, Ordering::SeqCst);
        match res {
            Ok(true) => ctx2.emit("download-done", json!({"id": id, "ok": true, "path": dest})),
            Ok(false) => ctx2.emit("download-done", json!({"id": id, "ok": false, "cancelled": true})),
            Err(e) => ctx2.emit("download-done", json!({"id": id, "ok": false, "error": e})),
        }
    });
    Ok(())
}

pub fn download_cancel(ctx: &Ctx) {
    ctx.running.download_cancel.store(true, Ordering::SeqCst);
}
