use crate::ctx::Ctx;
use serde_json::{json, Value};
use std::path::PathBuf;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let t = out.trim_matches('-');
    let t: String = t.chars().take(32).collect();
    if t.is_empty() { "projekt".into() } else { t }
}

pub fn app_json(ctx: &Ctx, id: &str) -> Result<PathBuf, String> {
    Ok(ctx.project_dir(id)?.join("app.json"))
}

/// A project is a folder in the app data dir: app.json (the app's own state), import/ (the import command's
/// folder), out/ (`--out` of the pipeline), events.jsonl (the last run's progress events).
pub fn create(ctx: &Ctx, name: &str, video: Option<String>) -> Result<Value, String> {
    let id = format!("{}-{}", slug(name), now_ms());
    let dir = ctx.project_dir(&id)?;
    std::fs::create_dir_all(dir.join("import")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir.join("out")).map_err(|e| e.to_string())?;
    let v = json!({"id": id, "name": name, "video": video, "created": now_ms(), "updated": now_ms()});
    save(ctx, &id, v.clone())?;
    Ok(v)
}

pub fn save(ctx: &Ctx, id: &str, mut v: Value) -> Result<(), String> {
    if let Some(o) = v.as_object_mut() {
        o.insert("id".into(), json!(id));
        o.insert("updated".into(), json!(now_ms()));
    }
    let p = app_json(ctx, id)?;
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&v).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, p).map_err(|e| e.to_string())
}

pub fn load(ctx: &Ctx, id: &str) -> Result<Value, String> {
    let s = std::fs::read_to_string(app_json(ctx, id)?).map_err(|e| format!("Projekt nicht lesbar: {e}"))?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

pub fn list(ctx: &Ctx) -> Vec<Value> {
    let mut v: Vec<Value> = std::fs::read_dir(ctx.projects_dir())
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| std::fs::read_to_string(e.path().join("app.json")).ok())
                .filter_map(|s| serde_json::from_str::<Value>(&s).ok())
                .collect()
        })
        .unwrap_or_default();
    v.sort_by_key(|p| std::cmp::Reverse(p.get("updated").and_then(|x| x.as_u64()).unwrap_or(0)));
    for p in v.iter_mut() {
        let id = p.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if let Ok(d) = ctx.project_dir(&id) {
            let has = d.join("out").join("route.gpx").exists();
            p["has_result"] = json!(has);
        }
    }
    v
}

pub fn delete(ctx: &Ctx, id: &str) -> Result<(), String> {
    let d = ctx.project_dir(id)?;
    if !d.join("app.json").exists() {
        return Err("Kein Projektordner".into());
    }
    std::fs::remove_dir_all(d).map_err(|e| e.to_string())
}

/// Project state for opening: app.json plus whether a result and a stored event log exist.
pub fn open(ctx: &Ctx, id: &str) -> Result<Value, String> {
    let app = load(ctx, id)?;
    let d = ctx.project_dir(id)?;
    let events: Vec<Value> = std::fs::read_to_string(d.join("events.jsonl"))
        .map(|s| s.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
        .unwrap_or_default();
    Ok(json!({
        "app": app,
        "dir": d,
        "import_dir": d.join("import"),
        "out_dir": d.join("out"),
        "has_result": d.join("out").join("route_points.json").exists() && d.join("out").join("route.gpx").exists(),
        "events": events,
    }))
}

pub fn result_load(ctx: &Ctx, id: &str) -> Result<Value, String> {
    let out = ctx.project_dir(id)?.join("out");
    let rp = std::fs::read_to_string(out.join("route_points.json")).map_err(|e| format!("route_points.json fehlt: {e}"))?;
    let pj = std::fs::read_to_string(out.join("project.json")).map_err(|e| format!("project.json fehlt: {e}"))?;
    let gpx = out.join("route.gpx");
    if !gpx.exists() {
        return Err("route.gpx fehlt".into());
    }
    let gpx_size = std::fs::metadata(&gpx).map(|m| m.len()).unwrap_or(0);
    Ok(json!({"route_points": rp, "project": pj, "gpx": gpx, "gpx_bytes": gpx_size}))
}

/// Saves `out/route.gpx` to `dest`. With `ele` (the default in the app) every track point gets an `<ele>` from the elevation profile
/// (`out/elevation_profile.json`, made when missing and the DEM tiles are there, see `incyclist::profile_load`), looked up by the point's
/// arc length in `route_points.json`; the profile's attribution goes into the metadata `<desc>`. Without a profile the file is saved
/// without heights and `note` says why. Returns `{bytes, ele, note}`.
pub fn gpx_export(ctx: &Ctx, id: &str, dest: &str, ele: bool) -> Result<Value, String> {
    let out = ctx.project_dir(id)?.join("out");
    let src = out.join("route.gpx");
    let mut note: Option<String> = None;
    if ele {
        let p = crate::incyclist::profile_load(ctx, id, false)?;
        if p["ready"] == true {
            let gpx = std::fs::read_to_string(&src).map_err(|e| format!("route.gpx fehlt: {e}"))?;
            let rp: Value = serde_json::from_str(&std::fs::read_to_string(out.join("route_points.json")).map_err(|e| format!("route_points.json fehlt: {e}"))?)
                .map_err(|e| e.to_string())?;
            match add_elevation(&gpx, &rp, &p["profile"]) {
                Some(g) => {
                    std::fs::write(dest, &g).map_err(|e| format!("GPX konnte nicht gespeichert werden: {e}"))?;
                    return Ok(json!({"bytes": g.len(), "ele": true, "note": null}));
                }
                None => note = Some("Höhen ließen sich den Punkten nicht zuordnen; ohne Höhen gespeichert.".into()),
            }
        } else {
            note = Some(match p["reason"].as_str() {
                Some("dem_missing") => "Höhendaten fehlen (Stufe Höhe); ohne Höhen gespeichert.".into(),
                _ => format!("Kein Höhenprofil ({}); ohne Höhen gespeichert.", p["error"].as_str().or(p["reason"].as_str()).unwrap_or("unbekannt")),
            });
        }
    }
    let n = std::fs::copy(&src, dest).map_err(|e| format!("GPX konnte nicht kopiert werden: {e}"))?;
    Ok(json!({"bytes": n, "ele": false, "note": note}))
}

fn xml_esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// route.gpx with `<ele>` in every `<trkpt>` (before `<time>`, as GPX 1.1 orders them). A point is matched to `route_points.json` by its
/// lat/lon (route.gpx writes them with 7 decimals; the extra edge points at standstills repeat a route point), its height is the profile
/// (`s0`, `ds`, `z`) at the point's `arc_m`, linear between samples and held at the ends. None when a point cannot be matched.
pub fn add_elevation(gpx: &str, rp: &Value, prof: &Value) -> Option<String> {
    let key = |lat: f64, lon: f64| ((lat * 1e7).round() as i64, (lon * 1e7).round() as i64);
    let mut arc = std::collections::HashMap::new();
    for p in rp["points"].as_array()? {
        arc.insert(key(p["lat"].as_f64()?, p["lon"].as_f64()?), p["arc_m"].as_f64()?);
    }
    let (s0, ds) = (prof["s0"].as_f64().unwrap_or(0.0), prof["ds"].as_f64()?);
    let z: Vec<f64> = prof["z"].as_array()?.iter().filter_map(|v| v.as_f64()).collect();
    if z.is_empty() || ds <= 0.0 {
        return None;
    }
    let z_at = |s: f64| {
        let x = ((s - s0) / ds).clamp(0.0, (z.len() - 1) as f64);
        let i = (x.floor() as usize).min(z.len() - 1);
        let j = (i + 1).min(z.len() - 1);
        z[i] + (z[j] - z[i]) * (x - i as f64)
    };
    if gpx.contains("<ele>") {
        return Some(gpx.to_string());
    }
    let get = |t: &str, k: &str| -> Option<f64> {
        let a = t.find(&format!("{k}=\""))? + k.len() + 2;
        t[a..a + t[a..].find('"')?].parse().ok()
    };
    let mut res = String::with_capacity(gpx.len() + gpx.len() / 8);
    let mut rest = gpx;
    while let Some(i) = rest.find("<trkpt ") {
        let close = i + rest[i..].find('>')? + 1;
        let tag = &rest[i..close];
        let s = *arc.get(&key(get(tag, "lat")?, get(tag, "lon")?))?;
        res.push_str(&rest[..close]);
        res.push_str(&format!("<ele>{:.1}</ele>", z_at(s)));
        rest = &rest[close..];
    }
    res.push_str(rest);
    if let (Some(src), Some(i)) = (prof["attribution"].as_str().or(prof["source"].as_str()), res.find("</desc>")) {
        res.insert_str(i, &format!(" Elevation: {}.", xml_esc(src.trim_end_matches('.'))));
    }
    Some(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elevation_into_gpx() {
        let gpx = r#"<gpx><metadata><desc>Map (c) OSM.</desc></metadata><trk><trkseg><trkpt lat="40.0000000" lon="14.0000000"><time>T0</time></trkpt><trkpt lat="40.0001000" lon="14.0000000"><time>T1</time></trkpt><trkpt lat="40.0001000" lon="14.0000000"><time>T2</time></trkpt></trkseg></trk></gpx>"#;
        let rp = json!({"points": [{"lat": 40.0, "lon": 14.0, "arc_m": 2.5}, {"lat": 40.0001, "lon": 14.0, "arc_m": 50.0}]});
        let prof = json!({"s0": 0.0, "ds": 5.0, "z": [100.0, 110.0, 120.0], "attribution": "DEM <x> & y."});
        let g = add_elevation(gpx, &rp, &prof).unwrap();
        assert!(g.contains(r#"lon="14.0000000"><ele>105.0</ele><time>T0</time>"#), "{g}");
        assert_eq!(g.matches("<ele>120.0</ele>").count(), 2, "held at the end; the repeated edge point too");
        assert!(g.contains("Map (c) OSM. Elevation: DEM &lt;x&gt; &amp; y.</desc>"), "{g}");
        // a point that is not in route_points.json: no partial file
        assert!(add_elevation(gpx, &json!({"points": [{"lat": 40.0, "lon": 14.0, "arc_m": 0.0}]}), &prof).is_none());
    }
}
