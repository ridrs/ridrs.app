//! The Analyse stage (docs/FEATURE_analysis_insight.md, Part A): two read-only pipeline commands, `inspect-series` (per-second series of a finished run and
//! its weak stretches with causes, cached) and `inspect-frame` (the points tracked for the frame pair and the far-feature window at one video time).
//! Neither changes a result; the only file written is `out/inspect/series.json`.
use crate::ctx::Ctx;
use crate::pipeline;
use crate::proc;
use crate::settings;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, UNIX_EPOCH};

/// The version of the series file this app reads (`version` in the file).
const SERIES_VERSION: u64 = 1;

fn mtime_secs(p: &Path) -> Option<u64> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs())
}

/// Is a cached series the one the pipeline would make now? Not when the result is another one (`result_mtime`, whole seconds) or the pipeline code
/// changed (`pipeline_hash`; checked only where the hash is known).
pub fn series_current(cached: &Value, result_mtime: Option<u64>, code_hash: Option<&str>) -> bool {
    if cached["version"].as_u64() != Some(SERIES_VERSION) {
        return false;
    }
    if result_mtime.is_none() || cached["result_mtime"].as_u64() != result_mtime {
        return false;
    }
    match (code_hash, cached["pipeline_hash"].as_str()) {
        (Some(now), Some(then)) => now == then,
        (Some(_), None) => false,
        (None, _) => true,
    }
}

fn error_of(stdout: &[u8], stderr: &[u8]) -> String {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|ev| ev["type"] == "log" && ev["level"] == "error")
        .and_then(|ev| ev["message"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| String::from_utf8_lossy(stderr).lines().last().unwrap_or("").to_string())
}

/// The series of a result: read from `out/inspect/series.json` when it belongs to this result and this pipeline, else made by `inspect-series` and stored.
/// A series is made in a second or two even for a two-hour video; it is cached so reopening the stage is instant.
pub fn inspect_series(ctx: &Ctx, project: &str) -> Result<Value, String> {
    let out = ctx.project_dir(project)?.join("out");
    let res = out.join("refine").join("result.npz");
    if !res.exists() {
        return Ok(json!({"ready": false, "reason": "no_result"}));
    }
    let s = settings::load(ctx);
    let cache = out.join("inspect").join("series.json");
    let hash = pipeline::code_hash(ctx, &s);
    if let Some(v) = std::fs::read_to_string(&cache).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        if series_current(&v, mtime_secs(&res), hash.as_deref()) {
            return Ok(json!({"ready": true, "series": v, "cached": true}));
        }
    }
    let mut cmd = pipeline::pipeline_cmd(ctx, &s);
    cmd.arg("inspect-series").arg("--out").arg(&out).arg("--dest").arg(&cache);
    let o = cmd.output().map_err(|e| format!("Pipeline nicht startbar: {e}"))?;
    if !o.status.success() || !cache.exists() {
        return Ok(json!({"ready": false, "reason": "error", "error": error_of(&o.stdout, &o.stderr)}));
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&cache).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(json!({"ready": true, "series": v, "cached": false}))
}

/// Counts the requests; the newest one wins.
static FRAME_SEQ: AtomicU64 = AtomicU64::new(0);

/// The overlay data of one video time (`inspect-frame`). One call runs at a time: a new request ends the running one (its process group is killed, its
/// answer is `{"superseded": true}`), so scrubbing never queues work. `video`: the video file the app plays (default: the one of the run).
pub fn inspect_frame(ctx: &Ctx, project: &str, t: f64, video: Option<String>, what: Option<String>) -> Result<Value, String> {
    if !t.is_finite() || t < 0.0 {
        return Err("Ungültige Zeit".into());
    }
    let out = ctx.project_dir(project)?.join("out");
    let my = FRAME_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let s = settings::load(ctx);
    let mut cmd = pipeline::pipeline_cmd(ctx, &s);
    cmd.arg("inspect-frame").arg("--out").arg(&out).arg("--t").arg(format!("{t:.3}"));
    if let Some(v) = video.filter(|v| !v.is_empty()) {
        cmd.arg("--video").arg(v);
    }
    if let Some(w) = what.filter(|w| !w.is_empty()) {
        cmd.arg("--what").arg(w);
    }
    // an older request that started before this one is still running: the check below ends it; spawn only if nobody newer is waiting already
    if FRAME_SEQ.load(Ordering::SeqCst) != my {
        return Ok(json!({"superseded": true}));
    }
    let mut child = proc::spawn_group(&mut cmd).map_err(|e| format!("Pipeline nicht startbar: {e}"))?;
    let pgid = child.id() as i32;
    let so = child.stdout.take().unwrap();
    let se = child.stderr.take().unwrap();
    let outt = std::thread::spawn(move || {
        let mut lines = Vec::new();
        proc::read_lines(so, |l| lines.push(l));
        lines
    });
    let errt = std::thread::spawn(move || {
        let mut last = String::new();
        proc::read_lines(se, |l| last = l);
        last
    });
    let mut superseded = false;
    let ok = loop {
        if FRAME_SEQ.load(Ordering::SeqCst) != my {
            superseded = true;
            proc::kill_group(pgid, libc::SIGKILL);
        }
        match child.try_wait() {
            Ok(Some(st)) => break st.success(),
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(_) => break false,
        }
    };
    let lines = outt.join().unwrap_or_default();
    let err = errt.join().unwrap_or_default();
    if superseded {
        return Ok(json!({"superseded": true}));
    }
    let evs: Vec<Value> = lines.iter().filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect();
    if let Some(mut r) = evs.iter().find(|v| v["type"] == "result").cloned() {
        if ok {
            r["ready"] = json!(true);
            return Ok(r);
        }
    }
    let msg = evs.iter().find(|ev| ev["type"] == "log" && ev["level"] == "error").and_then(|ev| ev["message"].as_str().map(|s| s.to_string())).unwrap_or(err);
    Ok(json!({"ready": false, "error": msg}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn series_cache_is_current_only_for_the_same_result_and_code() {
        let c = json!({"version": 1, "result_mtime": 1000, "pipeline_hash": "abc"});
        assert!(series_current(&c, Some(1000), Some("abc")));
        assert!(!series_current(&c, Some(1001), Some("abc")), "a newer result invalidates it");
        assert!(!series_current(&c, Some(1000), Some("abd")), "other pipeline code invalidates it");
        assert!(series_current(&c, Some(1000), None), "unknown hash (developer mode without frozen.json): the result decides");
        assert!(!series_current(&c, None, Some("abc")));
        assert!(!series_current(&json!({"version": 2, "result_mtime": 1000, "pipeline_hash": "abc"}), Some(1000), Some("abc")));
        assert!(!series_current(&json!({"version": 1, "result_mtime": 1000}), Some(1000), Some("abc")));
    }

    #[test]
    fn missing_result_is_reported_not_run() {
        let d = std::env::temp_dir().join(format!("v2g-insp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let ctx = Ctx::new(d.clone(), std::sync::Arc::new(|_, _| {}));
        std::fs::create_dir_all(ctx.projects_dir().join("p").join("out")).unwrap();
        assert_eq!(inspect_series(&ctx, "p").unwrap()["reason"], "no_result");
        assert!(inspect_series(&ctx, "../x").is_err());
        assert!(inspect_frame(&ctx, "../x", 1.0, None, None).is_err());
        assert!(inspect_frame(&ctx, "p", f64::NAN, None, None).is_err());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_newer_frame_request_supersedes_the_older_one() {
        use std::os::unix::fs::PermissionsExt;
        let d = std::env::temp_dir().join(format!("v2g-insp2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let ctx = Ctx::new(d.clone(), std::sync::Arc::new(|_, _| {}));
        std::fs::create_dir_all(ctx.projects_dir().join("p").join("out")).unwrap();
        // a stand-in sidecar that needs two seconds and answers with a result line
        let sc = d.join("fake-sidecar");
        std::fs::write(&sc, "#!/bin/sh\nsleep 2\necho '{\"type\":\"result\",\"t\":1.0}'\n").unwrap();
        std::fs::set_permissions(&sc, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut st = settings::load(&ctx);
        st.dev_mode = true;
        st.sidecar = sc.to_string_lossy().to_string();
        settings::save(&ctx, &st).unwrap();
        let c2 = ctx.clone();
        let first = std::thread::spawn(move || {
            let t0 = std::time::Instant::now();
            let r = inspect_frame(&c2, "p", 1.0, None, None).unwrap();
            (r, t0.elapsed())
        });
        std::thread::sleep(Duration::from_millis(500));
        let second = inspect_frame(&ctx, "p", 2.0, Some("/v.mp4".into()), Some("motion".into())).unwrap();
        let (r1, took) = first.join().unwrap();
        assert_eq!(r1["superseded"], true, "the older request is ended, not queued: {r1}");
        assert!(took < Duration::from_millis(1800), "and it does not wait for its process: {took:?}");
        assert_eq!(second["ready"], true);
        assert_eq!(second["type"], "result");
        let _ = std::fs::remove_dir_all(d);
    }
}
