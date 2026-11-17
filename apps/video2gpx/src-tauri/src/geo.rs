//! Place search (Nominatim, online, only on the user's action, at most one request per second) and the title-based
//! suggestion for the initial map section.
use crate::ctx::Ctx;
use crate::pbf;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const UA: &str = "video2gpx/0.1 (desktop beta; open-source tool)";

fn throttle(ctx: &Ctx) {
    let mut last = ctx.running.nominatim_last.lock().unwrap();
    if let Some(t) = *last {
        let el = t.elapsed();
        if el < Duration::from_millis(1100) {
            std::thread::sleep(Duration::from_millis(1100) - el);
        }
    }
    *last = Some(Instant::now());
}

/// One Nominatim request (rate limited). Returns [{name, lat, lon, bbox:[S,W,N,E], category, type}].
pub fn search(ctx: &Ctx, q: &str, limit: u32) -> Result<Vec<Value>, String> {
    let q = q.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    throttle(ctx);
    let resp = ureq::AgentBuilder::new()
        .user_agent(UA)
        .timeout(Duration::from_secs(15))
        .build()
        .get("https://nominatim.openstreetmap.org/search")
        .query("q", q)
        .query("format", "jsonv2")
        .query("limit", &limit.to_string())
        .call()
        .map_err(|e| format!("Ortssuche fehlgeschlagen: {e}"))?;
    let v: Value = resp.into_json().map_err(|e| e.to_string())?;
    let f = |x: &Value| x.as_str().and_then(|s| s.parse::<f64>().ok());
    Ok(v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|h| {
                    let (lat, lon) = (f(&h["lat"])?, f(&h["lon"])?);
                    let bb = h["boundingbox"].as_array().and_then(|b| Some([f(&b[0])?, f(&b[2])?, f(&b[1])?, f(&b[3])?]));
                    Some(json!({"name": h["display_name"], "lat": lat, "lon": lon, "bbox": bb, "category": h["category"], "type": h["type"]}))
                })
                .collect()
        })
        .unwrap_or_default())
}

/// ISO 3166 alpha-2 country code of a point (Nominatim reverse, rate limited; only on the user's action: opening the Incyclist dialog).
pub fn country(ctx: &Ctx, lat: f64, lon: f64) -> Result<Option<String>, String> {
    throttle(ctx);
    let resp = ureq::AgentBuilder::new()
        .user_agent(UA)
        .timeout(Duration::from_secs(15))
        .build()
        .get("https://nominatim.openstreetmap.org/reverse")
        .query("lat", &format!("{lat:.5}"))
        .query("lon", &format!("{lon:.5}"))
        .query("zoom", "3")
        .query("format", "jsonv2")
        .call()
        .map_err(|e| format!("Land konnte nicht bestimmt werden: {e}"))?;
    let v: Value = resp.into_json().map_err(|e| e.to_string())?;
    Ok(v["address"]["country_code"].as_str().filter(|c| c.len() == 2).map(|c| c.to_uppercase()))
}

// ---------- candidate place names from a video title ----------

/// Technical tags that never name a place (compared lower-case, also as prefixes like "1440p60").
const TECH: &[&str] = &["4k", "5k", "6k", "8k", "hdr", "hdr10", "uhd", "fhd", "hd", "sdr", "fps", "pov", "360", "vr", "asmr", "dolby", "vision"];
/// Descriptive words trimmed from the edges of a name (multilingual, lower-case).
const STOP: &[&str] = &[
    "route", "road", "roads", "strasse", "straße", "strada", "carretera", "drive", "driving", "drives", "ride", "riding", "rides", "cycling",
    "cycle", "bike", "biking", "bicycle", "motorcycle", "motorbike", "moto", "tour", "trip", "journey", "scenic", "dramatic", "beautiful",
    "amazing", "epic", "best", "most", "stunning", "incredible", "famous", "spectacular", "balcony", "panoramic", "panorama", "relaxing",
    "relax", "virtual", "indoor", "training", "workout", "video", "part", "teil", "episode", "ep", "full", "complete", "the", "a", "an",
    "fahrt", "auffahrt", "abfahrt", "descent", "climb", "ascent", "montée", "descente", "salita", "discesa", "subida", "bajada", "in", "on",
    "to", "from", "via", "and", "et", "und", "e", "y", "with", "mit", "avec", "con", "time", "lapse", "timelapse", "real", "realtime",
    "sunrise", "sunset", "summer", "winter", "autumn", "spring", "day", "night", "new",
];
/// Small words allowed inside a name ("Col de la Madone", "Lago di Garda").
const JOIN: &[&str] = &[
    "de", "la", "le", "les", "du", "des", "del", "della", "dello", "delle", "dei", "degli", "dal", "dalla", "sul", "sulla", "alla", "allo", "di", "der", "den", "dem", "bei", "los", "las", "da", "do", "dos", "das", "of", "the", "von", "vom",
    "am", "an", "im", "zum", "zur", "sur", "sous", "en", "d'", "l'", "d’", "l’", "y", "i", "al", "el", "lo", "san", "st", "st.", "saint",
    "sainte", "santa", "santo", "sankt",
];
/// Words that mark a geographic name; names containing one are tried first.
const PLACE: &[&str] = &[
    "col", "colle", "collado", "coll", "pass", "passo", "paso", "puerto", "port", "pas", "passhöhe", "pass-strasse", "sattel", "joch", "jaufen",
    "mont", "monte", "mount", "mt", "berg", "piz", "pic", "pico", "cima", "pointe", "punta", "lago", "lac", "lake", "see", "loch", "valle",
    "vallée", "valley", "val", "tal", "gorges", "gorge", "gola", "schlucht", "cañon", "canyon", "cap", "capo", "cape", "coast", "costa",
    "côte", "fjord", "alpe", "alp", "alpine", "hochalpenstrasse", "island", "isola", "île", "ile", "isla",
];

fn is_tech(w: &str) -> bool {
    let l = w.to_lowercase();
    if TECH.contains(&l.as_str()) {
        return true;
    }
    // 1080p, 1440p60, 60fps, 4k60, 2160p, 120hz, 8bit
    let digits = l.chars().take_while(|c| c.is_ascii_digit()).count();
    digits > 0 && {
        let rest = &l[digits..];
        rest.is_empty() || rest.starts_with('p') || rest.starts_with("fps") || rest.starts_with('k') || rest.starts_with("hz") || rest.starts_with("bit")
    }
}

fn is_cap(w: &str) -> bool {
    w.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)
}

fn lc(w: &str) -> String {
    w.to_lowercase()
}

/// Remove bracketed parts, emojis and symbols; return segments split at separators, each as words.
fn segments(title: &str) -> Vec<Vec<String>> {
    // drop [...] and (...) and {...}
    let mut s = String::new();
    let mut depth = 0i32;
    for c in title.chars() {
        match c {
            '[' | '(' | '{' => depth += 1,
            ']' | ')' | '}' => depth = (depth - 1).max(0),
            _ if depth == 0 => s.push(c),
            _ => {}
        }
    }
    // separators become '|', everything that is not part of a word becomes a space
    let mut t = String::new();
    let chars: Vec<char> = s.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        let prev_ws = i == 0 || chars[i - 1].is_whitespace();
        let next_ws = i + 1 >= chars.len() || chars[i + 1].is_whitespace();
        if matches!(c, '|' | ',' | ';' | ':' | '/' | '•' | '·' | '–' | '—' | '!' | '?' | '#' | '"' | '“' | '”' | '«' | '»') || (c == '-' && prev_ws && next_ws) {
            t.push('|');
        } else if c.is_alphanumeric() || c == '\'' || c == '’' || c == '-' || c == '.' {
            t.push(c);
        } else {
            t.push(' ');
        }
    }
    t.split('|')
        .map(|seg| {
            seg.split_whitespace()
                .map(|w| w.trim_matches(|c: char| c == '.' || c == '-' || c == '\'' || c == '’').to_string())
                .filter(|w| !w.is_empty() && !is_tech(w))
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty())
        .collect()
}

/// Trim descriptive words, joiners and numbers from both ends.
fn trim_edges(words: &[String]) -> Vec<String> {
    let bad = |w: &String| {
        let l = lc(w);
        STOP.contains(&l.as_str()) || JOIN.contains(&l.as_str()) || w.chars().all(|c| c.is_ascii_digit())
    };
    let mut a = 0;
    let mut b = words.len();
    while a < b && bad(&words[a]) {
        a += 1;
    }
    while b > a && bad(&words[b - 1]) {
        b -= 1;
    }
    words[a..b].to_vec()
}

/// Maximal runs of capitalised words (or place keywords), with joiners allowed inside.
fn name_runs(words: &[String]) -> Vec<Vec<String>> {
    let mut runs = vec![];
    let mut cur: Vec<String> = vec![];
    for w in words {
        let l = lc(w);
        let stop = STOP.contains(&l.as_str()) && !PLACE.contains(&l.as_str());
        let word_ok = (is_cap(w) || PLACE.contains(&l.as_str())) && !w.chars().all(|c| c.is_ascii_digit());
        if word_ok && !stop {
            cur.push(w.clone());
        } else if !cur.is_empty() && (JOIN.contains(&l.as_str()) || (stop && is_cap(w))) {
            cur.push(w.clone()); // trimmed later if it ends the run
        } else if !cur.is_empty() {
            runs.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        runs.push(cur);
    }
    // a run may contain inner descriptive words ("Riviera Balcony Road"): split there, keep the parts
    let mut out = vec![];
    for r in runs {
        let mut part: Vec<String> = vec![];
        for w in r {
            let l = lc(&w);
            if STOP.contains(&l.as_str()) && !JOIN.contains(&l.as_str()) && !PLACE.contains(&l.as_str()) {
                let t = trim_edges(&part);
                if !t.is_empty() {
                    out.push(t);
                }
                part.clear();
            } else {
                part.push(w);
            }
        }
        let t = trim_edges(&part);
        if !t.is_empty() {
            out.push(t);
        }
    }
    out
}

/// Candidate queries from a video title, best first:
/// 1. names that contain a place keyword ("Col de la Madone", "Gotthard Pass", "Gorges des Gâts");
/// 2. other capitalised names ("Pontaix", "Chamaloc", "Riviera");
/// 3. whole segments between separators, trimmed;
/// 4. the whole cleaned title.
/// Duplicates are removed (case-insensitive); at most 8 are returned.
pub fn candidates(title: &str) -> Vec<String> {
    let segs = segments(title);
    let mut keyword = vec![];
    let mut other = vec![];
    for seg in &segs {
        for run in name_runs(seg) {
            let has_kw = run.iter().any(|w| PLACE.contains(&lc(w).as_str()));
            let is_only_kw = run.len() == 1 && has_kw;
            let s = run.join(" ");
            if is_only_kw {
                continue; // "Pass" alone says nothing
            }
            if has_kw { keyword.push(s) } else { other.push(s) }
        }
    }
    keyword.sort_by_key(|s| std::cmp::Reverse(s.split(' ').count()));
    let mut out: Vec<String> = vec![];
    let push = |s: String, out: &mut Vec<String>| {
        if !s.is_empty() && !s.chars().all(|c| c.is_ascii_digit()) && !out.iter().any(|o: &String| o.to_lowercase() == s.to_lowercase()) {
            out.push(s);
        }
    };
    for s in keyword {
        push(s, &mut out);
    }
    for s in other {
        push(s, &mut out);
    }
    for seg in &segs {
        push(trim_edges(seg).join(" "), &mut out);
    }
    push(segs.iter().map(|s| s.join(" ")).collect::<Vec<_>>().join(" "), &mut out);
    out.truncate(8);
    out
}

#[cfg(test)]
mod tests {
    use super::candidates;

    #[test]
    fn youtube_titles() {
        let c = candidates("Route du Col de la Madone 4K HDR 🇫🇷 Dramatic Riviera Balcony Road [aBcDeFgHiJk]");
        assert_eq!(c[0], "Col de la Madone", "{c:?}");
        assert!(c.contains(&"Riviera".to_string()), "{c:?}");
        assert!(!c.iter().any(|x| x.contains("aBcDeFgHiJk") || x.contains("4K") || x.contains("HDR")), "{c:?}");

        let c = candidates("Driving the Amalfi Coast 1440p60 HDR");
        assert_eq!(c[0], "Amalfi Coast", "{c:?}");

        let c = candidates("Gotthard Pass 4K");
        assert_eq!(c[0], "Gotthard Pass", "{c:?}");

        let c = candidates("Rousset - 3 - Pontaix, Chamaloc");
        for want in ["Rousset", "Pontaix", "Chamaloc"] {
            assert!(c.contains(&want.to_string()), "{want} missing in {c:?}");
        }

        let c = candidates("Grimone - 1 - Gorges des Gâts");
        assert_eq!(c[0], "Gorges des Gâts", "{c:?}");
        assert!(c.contains(&"Grimone".to_string()), "{c:?}");

        let c = candidates("Passo dello Stelvio from Bormio | 4K60 scenic drive");
        assert!(c[0].starts_with("Passo dello Stelvio"), "{c:?}");
        assert!(c.contains(&"Bormio".to_string()), "{c:?}");

        let c = candidates("Lago di Garda Gardesana Occidentale ride (2023) #moto");
        assert!(c[0].starts_with("Lago di Garda"), "{c:?}");

        let c = candidates("video");
        assert!(c.len() <= 1, "{c:?}");
    }
}

/// Try the candidates; accept the first hit with local map data, else fall back to the first hit of all.
pub fn suggest(ctx: &Ctx, title: &str) -> Result<Value, String> {
    let mut tried = vec![];
    let mut first_any: Option<(String, Value)> = None;
    for q in candidates(title) {
        let hits = search(ctx, &q, 3)?;
        tried.push(json!({"query": q, "hits": hits.len()}));
        for h in &hits {
            let (lat, lon) = (h["lat"].as_f64().unwrap(), h["lon"].as_f64().unwrap());
            if let Some(pbf) = pbf::local_covers_point(ctx, lat, lon) {
                return Ok(json!({"found": true, "query": q, "hit": h, "local_pbf": pbf, "tried": tried}));
            }
        }
        if first_any.is_none() {
            if let Some(h) = hits.first() {
                first_any = Some((q.clone(), h.clone()));
            }
        }
    }
    match first_any {
        Some((q, h)) => Ok(json!({"found": true, "query": q, "hit": h, "local_pbf": null, "tried": tried})),
        None => Ok(json!({"found": false, "tried": tried})),
    }
}

#[cfg(test)]
mod show {
    #[test]
    #[ignore]
    fn print_candidates() {
        for t in ["Route du Col de la Madone 4K HDR 🇫🇷 Dramatic Riviera Balcony Road [aBcDeFgHiJk]", "Driving the Amalfi Coast 1440p60 HDR",
                  "Rousset - 3 - Pontaix, Chamaloc", "Grimone - 1 - Gorges des Gâts", "Passo dello Stelvio from Bormio | 4K60 scenic drive", "Cayolle Pass"] {
            println!("{t}\n  -> {:?}", super::candidates(t));
        }
    }
}
