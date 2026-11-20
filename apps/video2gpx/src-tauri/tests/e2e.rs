//! End-to-end harness for the Rust command layer (the same functions the Tauri commands call), against the real
//! pipeline. Run explicitly (they need the research venv, ffmpeg, the 10 min Pontaix video and the rhone-alpes extract):
//! The paths come from the environment at build time: RSM_E2E_VIDEO (default: test-data/long/pontaix-10m/video.mp4, the long video of T3 cut by
//! `python -m rsm.bench.long cut`, docs/CONCEPT_test_strategy.md D), RSM_E2E_PBF (a Rhône-Alpes extract); defaults are in the git-ignored test-data/
//! (long/, osm/, runs/pontaix-10m: the finished run of that video, dem/).
//!   scripts/guard.sh cargo test --manifest-path src-tauri/Cargo.toml --test e2e -- --ignored --nocapture --test-threads=1
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use video2gpx_lib::ctx::{Ctx, Emit};
use video2gpx_lib::{geo, pbf, pipeline, projects, video};

const VIDEO: &str = match option_env!("RSM_E2E_VIDEO") { Some(v) => v, None => concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/long/pontaix-10m/video.mp4") };
const PBF: &str = match option_env!("RSM_E2E_PBF") { Some(v) => v, None => concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/osm/rhone-alpes.osm.pbf") };
const DONE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/runs/pontaix-10m");
const DEM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/dem");

type Log = Arc<Mutex<Vec<(String, Value)>>>;

fn harness(name: &str) -> (Ctx, Log, PathBuf) {
    let dir = std::env::temp_dir().join(format!("v2g-e2e-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    let log: Log = Arc::new(Mutex::new(vec![]));
    let l2 = log.clone();
    let emit: Emit = Arc::new(move |n, p| l2.lock().unwrap().push((n.to_string(), p)));
    let ctx = Ctx::new(dir.clone(), emit);
    // the research venv, not the bundled sidecar: developer mode
    let mut s = video2gpx_lib::settings::load(&ctx);
    s.dev_mode = true;
    video2gpx_lib::settings::save(&ctx, &s).unwrap();
    (ctx, log, dir)
}

fn wait_for(log: &Log, name: &str, timeout_s: u64, pred: impl Fn(&Value) -> bool) -> Option<Value> {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(timeout_s) {
        if let Some((_, v)) = log.lock().unwrap().iter().find(|(n, v)| n == name && pred(v)) {
            return Some(v.clone());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    None
}

fn done_bbox() -> [f64; 4] {
    let p: Value = serde_json::from_str(&std::fs::read_to_string(format!("{DONE}/project.json")).unwrap()).unwrap();
    let b = &p["params"]["bbox"];
    [b["south"].as_f64().unwrap(), b["west"].as_f64().unwrap(), b["north"].as_f64().unwrap(), b["east"].as_f64().unwrap()]
}

#[test]
#[ignore]
fn environment_pbf_video() {
    let (ctx, _log, _d) = harness("env");
    let env = pipeline::env_check(&ctx);
    println!("env_check: {}", serde_json::to_string_pretty(&env).unwrap());
    for k in ["python", "rsm", "ffmpeg", "ffprobe"] {
        assert_eq!(env[k]["ok"], json!(true), "{k}: {}", env[k]);
    }
    // a clear error when Python is missing
    let mut s = video2gpx_lib::settings::load(&ctx);
    s.python = "/nonexistent/python".into();
    video2gpx_lib::settings::save(&ctx, &s).unwrap();
    let bad = pipeline::env_check(&ctx);
    println!("missing python -> {}", bad["python"]["message"]);
    assert_eq!(bad["python"]["ok"], json!(false));
    s.python = video2gpx_lib::settings::Settings::default().python;
    s.ffmpeg = "/nonexistent/ffmpeg".into();
    video2gpx_lib::settings::save(&ctx, &s).unwrap();
    let bad = pipeline::env_check(&ctx);
    println!("missing ffmpeg -> {}", bad["ffmpeg"]["message"]);
    assert_eq!(bad["ffmpeg"]["ok"], json!(false));
    s.ffmpeg = String::new();
    video2gpx_lib::settings::save(&ctx, &s).unwrap();

    // pbf header bbox, link in place, coverage of the Pontaix bbox
    let hb = pbf::header_bbox(Path::new(PBF)).unwrap().expect("header bbox");
    println!("rhone-alpes header bbox S,W,N,E = {hb:?}");
    let rb = done_bbox();
    assert!(pbf::covers(&hb, &rb), "extract must cover {rb:?}");
    let info = pbf::link(&ctx, PBF).unwrap();
    println!("linked: {info}");
    let list = pbf::list(&ctx);
    assert_eq!(list.len(), 1);
    assert!(list[0]["linked"] == json!(true) && list[0]["bbox"].is_array());
    assert!(!ctx.osm_dir().join("rhone-alpes.osm.pbf").exists(), "linking must not copy");

    // video probe + poster
    let pr = video::probe(&ctx, VIDEO).unwrap();
    println!("probe: {pr}");
    assert_eq!(pr["title"], json!("pontaix 10m"));
    let p = projects::create(&ctx, "pontaix", Some(VIDEO.into())).unwrap();
    let id = p["id"].as_str().unwrap();
    let poster = video::poster(&ctx, id, VIDEO, 30.0, false).unwrap();
    println!("poster: {poster} ({} bytes)", std::fs::metadata(&poster).unwrap().len());
    assert!(std::fs::metadata(&poster).unwrap().len() > 1000);
}

#[test]
#[ignore]
fn import_template_rules() {
    use video2gpx_lib::import::{self, ImportRequest};
    use video2gpx_lib::settings::ImportTemplate;
    let (ctx, log, dir) = harness("import");
    let p = projects::create(&ctx, "imp", None).unwrap();
    let id = p["id"].as_str().unwrap().to_string();
    let idir = ctx.project_dir(&id).unwrap().join("import");
    // a small source video
    let src = dir.join("src ride.mp4");
    let ff = video2gpx_lib::settings::ffmpeg(&video2gpx_lib::settings::load(&ctx)).unwrap();
    assert!(std::process::Command::new(ff).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=3", "-pix_fmt", "yuv420p"]).arg(&src).status().unwrap().success());
    let src = std::fs::canonicalize(&src).unwrap();
    let mut s = video2gpx_lib::settings::load(&ctx);
    let t = |id: &str, template: &str| ImportTemplate { id: id.into(), name: id.into(), template: template.into(), ..Default::default() };
    s.import_templates = vec![
        t("none", "/usr/bin/true {input} {out}"),
        t("two", "/bin/sh -c 'echo hello; echo oops 1>&2; cp \"$1\" \"$2/a.mp4\"; cp \"$1\" \"$OUT/b.mkv\"' sh {input} {out}"),
        t("slow", "/bin/sh -c 'sleep 300 & sleep 300; echo never' sh {input}"),
    ];
    video2gpx_lib::settings::save(&ctx, &s).unwrap();
    let req = |t: &str| ImportRequest { template_id: t.into(), input: src.to_string_lossy().into() };

    // 1) the built-in cp template: exactly one new file is accepted; the preview is the exact argument list
    let r = import::resolve_request(&ctx, Some(&id), &req("cp")).unwrap();
    println!("exact command: {}", r.display);
    assert!(r.errors.is_empty() && r.argv.len() == 4);
    import::start(&ctx, &id, &req("cp")).unwrap();
    let done = wait_for(&log, "import-done", 30, |_| true).expect("import-done");
    println!("1) {done}");
    assert_eq!(done["ok"], json!(true));
    assert_eq!(done["file"], json!(idir.join("src ride.mp4")));
    assert!(video::probe(&ctx, done["file"].as_str().unwrap()).is_ok());
    assert!(wait_for(&log, "import-progress", 1, |_| true).is_some());

    // 2) no new file -> error
    log.lock().unwrap().clear();
    import::start(&ctx, &id, &req("none")).unwrap();
    let done = wait_for(&log, "import-done", 30, |_| true).unwrap();
    println!("2) {done}");
    assert_eq!(done["ok"], json!(false));

    // 3) two new files -> error; the live log has both streams; $OUT is the import folder
    log.lock().unwrap().clear();
    import::start(&ctx, &id, &req("two")).unwrap();
    let done = wait_for(&log, "import-done", 30, |_| true).unwrap();
    println!("3) {done}");
    assert_eq!(done["ok"], json!(false));
    assert!(done["error"].as_str().unwrap().contains("2 neue"));
    let logs: Vec<String> = log.lock().unwrap().iter().filter(|(n, _)| n == "import-log").map(|(_, v)| format!("{}:{}", v["stream"], v["line"])).collect();
    assert!(logs.iter().any(|l| l.contains("stdout") && l.contains("hello")) && logs.iter().any(|l| l.contains("stderr") && l.contains("oops")));

    // 4) cancel kills the whole process group (a shell with a child sleep)
    log.lock().unwrap().clear();
    import::start(&ctx, &id, &req("slow")).unwrap();
    std::thread::sleep(Duration::from_millis(800));
    let pg = ctx.running.import.lock().unwrap().clone().unwrap().0;
    assert!(import::cancel(&ctx));
    let done = wait_for(&log, "import-done", 20, |_| true).unwrap();
    println!("4) {done}");
    assert_eq!(done["cancelled"], json!(true));
    std::thread::sleep(Duration::from_millis(500));
    assert!(!video2gpx_lib::proc::group_alive(pg), "process group must be dead");
    println!("   process group {pg} is gone");
}

#[test]
#[ignore]
fn network_geofabrik_and_nominatim() {
    let (ctx, _log, _d) = harness("net");
    pbf::link(&ctx, PBF).unwrap();
    let rb = done_bbox();
    let c = pbf::geofabrik_candidates(&ctx, &rb).unwrap();
    println!("Geofabrik candidates for the Pontaix bbox (smallest first):");
    for x in &c {
        println!("  {} ({}) {} bytes {}", x["name"], x["parent"], x["bytes"], x["url"]);
    }
    assert!(!c.is_empty());
    let t0 = Instant::now();
    let s = geo::suggest(&ctx, "Rousset - 3 - Pontaix, Chamaloc").unwrap();
    println!("suggest({:?}) took {:.1}s: {}", "Rousset - 3 - Pontaix, Chamaloc", t0.elapsed().as_secs_f32(), s);
    assert_eq!(s["found"], json!(true));
}

#[test]
#[ignore]
fn pipeline_live_cancel_then_resume_result() {
    let (ctx, log, _d) = harness("pipe");
    pbf::link(&ctx, PBF).unwrap();
    let rb = done_bbox();
    let mk = |name: &str| {
        let p = projects::create(&ctx, name, Some(VIDEO.into())).unwrap();
        p["id"].as_str().unwrap().to_string()
    };
    let params = |id: &str, resume: bool| pipeline::RunParams {
        project: id.into(), video: VIDEO.into(), bbox: rb, pbf: PBF.into(), vehicle: Some("auto".into()), offset_m: None,
        start_time: Some("2026-05-01T08:30:00+02:00".into()), resume, decoys: None, ..Default::default()
    };

    // ---- A: a live run from scratch; progress parsing of step 1, then cancel (process group SIGTERM) ----
    let a = mk("pontaix-live");
    println!("command: [python -m rsm.pipeline | sidecar] {}", pipeline::build_args(&params(&a, false), &ctx.project_dir(&a).unwrap().join("out")).join(" "));
    pipeline::start(&ctx, params(&a, false)).unwrap();
    assert!(pipeline::start(&ctx, params(&a, false)).is_err(), "second start must be refused");
    let ev = wait_for(&log, "pipeline-event", 300, |v| v["event"]["type"] == "step" && v["event"]["id"] == "motion" && v["event"]["pct"].as_f64().unwrap_or(0.0) >= 1.0)
        .expect("motion progress >= 1 %");
    println!("A) live step event: {}", ev["event"]);
    std::thread::sleep(Duration::from_secs(5));
    let steps: Vec<String> = log.lock().unwrap().iter().filter(|(n, v)| n == "pipeline-event" && v["event"]["type"] == "step").map(|(_, v)| v["event"].to_string()).collect();
    println!("A) {} step events so far, last: {}", steps.len(), steps.last().unwrap());
    assert!(pipeline::cancel(&ctx));
    let ex = wait_for(&log, "pipeline-exit", 90, |_| true).expect("pipeline-exit after cancel");
    println!("A) exit: {ex}");
    assert_eq!(ex["cancelled"], json!(true));
    assert!(ctx.running.pipeline.lock().unwrap().is_none());
    let stored = std::fs::read_to_string(ctx.project_dir(&a).unwrap().join("events.jsonl")).unwrap();
    println!("A) events.jsonl lines: {}", stored.lines().count());
    // nothing of this run may survive (only processes of this test's folder: other pipeline runs on the machine are not ours)
    std::thread::sleep(Duration::from_secs(2));
    let left = String::from_utf8_lossy(&std::process::Command::new("pgrep").args(["-f", "rsm.pipeline.*v2g-e2e-pipe"]).output().unwrap().stdout).trim().to_string();
    println!("A) leftover rsm.pipeline processes: {:?}", left);
    assert!(left.is_empty());

    // ---- B: the finished Pontaix checkpoints in a project copy, `--resume`; refine and gpx run live ----
    log.lock().unwrap().clear();
    let b = mk("pontaix-resume");
    let out = ctx.project_dir(&b).unwrap().join("out");
    let _ = std::fs::remove_dir_all(&out);
    assert!(std::process::Command::new("cp").args(["-R", DONE]).arg(&out).status().unwrap().success());
    for f in ["steps/refine.done.json", "steps/gpx.done.json", "route.gpx", "route_points.json"] {
        let _ = std::fs::remove_file(out.join(f));
    }
    assert!(projects::result_load(&ctx, &b).is_err(), "no result before the run");
    pipeline::start(&ctx, params(&b, true)).unwrap();
    let ex = wait_for(&log, "pipeline-exit", 900, |_| true).expect("pipeline-exit");
    println!("B) exit: {ex}");
    let evs: Vec<Value> = log.lock().unwrap().iter().filter(|(n, _)| n == "pipeline-event").map(|(_, v)| v["event"].clone()).collect();
    for e in &evs {
        if e["type"] == "step" && e["state"] != "running" { println!("B) {e}"); }
    }
    let running: Vec<&Value> = evs.iter().filter(|e| e["type"] == "step" && e["state"] == "running").collect();
    println!("B) {} running-progress events, e.g. {}", running.len(), running.get(running.len() / 2).map(|v| v.to_string()).unwrap_or_default());
    for e in evs.iter().filter(|e| e["type"] == "status") { println!("B) status {} {} {}", e["signal"], e["level"], e["message"]); }
    assert_eq!(ex["code"], json!(0));
    let result = evs.iter().find(|e| e["type"] == "result").expect("result event");
    println!("B) result: verdict={} basis={}", result["verdict"], result["verdict_basis"]);

    // result screen data: route.gpx and route_points.json
    let r = projects::result_load(&ctx, &b).unwrap();
    let rp: Value = serde_json::from_str(r["route_points"].as_str().unwrap()).unwrap();
    let pts = rp["points"].as_array().unwrap();
    println!("B) result_load: {} route points, first {}, last {}, gpx {} bytes, project.json {} bytes", pts.len(), pts[0], pts[pts.len() - 1], r["gpx_bytes"], r["project"].as_str().unwrap().len());
    assert!(pts.len() >= 590, "one route point per second of the 10 min video");
    let gpx = std::fs::read_to_string(r["gpx"].as_str().unwrap()).unwrap();
    println!("B) gpx: {}", gpx.lines().filter(|l| l.contains("<time>")).take(2).collect::<Vec<_>>().join(" | "));
    assert!(gpx.contains("2026-05-01T06:30:00Z"), "the start time (08:30+02:00 = 06:30Z) is in the gpx");

    // retime without recompute, then export
    let t0 = Instant::now();
    let rt = pipeline::retime(&ctx, &b, "2026-06-01T10:00:00+02:00").unwrap();
    println!("B) retime in {:.1}s: {rt}", t0.elapsed().as_secs_f32());
    let gpx2 = std::fs::read_to_string(r["gpx"].as_str().unwrap()).unwrap();
    assert!(gpx2.contains("2026-06-01T08:00:00"));
    let dest = std::env::temp_dir().join("v2g-e2e-export.gpx");
    let r = projects::gpx_export(&ctx, &b, dest.to_str().unwrap(), false).unwrap();
    println!("B) exported {r} to {}", dest.display());
    assert_eq!(r["bytes"].as_u64().unwrap(), std::fs::metadata(&dest).unwrap().len());
    assert!(!std::fs::read_to_string(&dest).unwrap().contains("<ele>"));
}

// ---------------------------------------------------------------- Incyclist export (docs/FEATURE_incyclist_export.md)
// A copy of a finished run (refine/result.npz, project.json, route_points.json, map/graph_real.npz) in INC_OUT, the video in INC_VIDEO,
// the DEM tiles in INC_DEM (linked into the app data dir), the package written to INC_DEST:
//   INC_OUT=… INC_VIDEO=… INC_DEM=… INC_DEST=…zip scripts/guard.sh cargo test --manifest-path src-tauri/Cargo.toml --test e2e incyclist_package -- --ignored --nocapture
#[test]
#[ignore]
fn incyclist_package() {
    use video2gpx_lib::incyclist;
    // defaults: the Pontaix run and video and the DEM tiles in test-data/, the package in the test folder
    let (ctx, log, d) = harness("incyclist");
    let dest_default = d.join("Test.zip").to_string_lossy().into_owned();
    let env = |k: &str| std::env::var(k).unwrap_or_else(|_| match k {
        "INC_DEM" => DEM.into(), "INC_OUT" => DONE.into(), "INC_VIDEO" => VIDEO.into(), "INC_DEST" => dest_default.clone(),
        _ => panic!("{k} not set"),
    });
    let pdir = ctx.project_dir("inc").unwrap();
    std::fs::create_dir_all(pdir.join("out")).unwrap();
    std::os::unix::fs::symlink(env("INC_DEM"), ctx.dem_dir()).unwrap();
    for f in ["refine", "map"] {
        std::fs::create_dir_all(pdir.join("out").join(f)).unwrap();
    }
    for f in ["project.json", "route_points.json", "refine/result.npz", "refine/summary.json", "map/graph_real.npz"] {
        let src = Path::new(&env("INC_OUT")).join(f);
        if src.exists() {
            std::fs::copy(&src, pdir.join("out").join(f)).unwrap();
        }
    }
    let video = env("INC_VIDEO");
    let o = incyclist::ExportOptions {
        title: std::env::var("INC_TITLE").unwrap_or("Test".into()), name: std::env::var("INC_NAME").unwrap_or("Test".into()), country: std::env::var("INC_COUNTRY").unwrap_or("FR".into()),
        sdr: std::env::var("INC_SDR").is_ok(), max_height: std::env::var("INC_HEIGHT").ok().and_then(|h| h.parse().ok()), folder: std::env::var("INC_FOLDER").is_ok(),
        ..Default::default()
    };
    let info = incyclist::info(&ctx, "inc", &o, &video, false).unwrap();
    println!("info: plan {} est {} MB, dem ready {}", info["plan"], info["est_bytes"].as_u64().unwrap() / 1_000_000, info["dem"]["ready"]);
    let dest = PathBuf::from(env("INC_DEST"));
    let _ = std::fs::remove_file(&dest);
    let t0 = Instant::now();
    incyclist::export(&ctx, "inc", &video, o, dest.to_str().unwrap()).unwrap();
    let done = wait_for(&log, "incyclist-done", 3600, |_| true).expect("no incyclist-done");
    println!("done in {:.1} s: {}", t0.elapsed().as_secs_f64(), serde_json::to_string_pretty(&done).unwrap());
    let steps: Vec<String> = log.lock().unwrap().iter().filter(|(n, _)| n == "incyclist-progress").map(|(_, v)| format!("{}:{}", v["step"], v["pct"])).collect();
    println!("progress events: {} (first {:?}, last {:?})", steps.len(), steps.first(), steps.last());
    assert_eq!(done["ok"], json!(true), "{done}");
    assert!(dest.exists() && !Path::new(&format!("{}.part", dest.display())).exists());
    assert!(!pdir.join("export").exists(), "temporary files removed");
}

/// The DEM download in the app (network): one land tile (12 MB) and one open-sea tile (marker only), then cancel.
#[test]
#[ignore]
fn dem_download_land_and_sea() {
    use video2gpx_lib::incyclist;
    let (ctx, log, _d) = harness("dem");
    let tiles = vec![incyclist::tile_name(43, 7), incyclist::tile_name(40, 5)];
    incyclist::dem_download(&ctx, tiles.clone(), None).unwrap();
    let done = wait_for(&log, "dem-done", 600, |_| true).unwrap();
    println!("dem-done {done}; files {:?}", incyclist::dem_list(&ctx));
    assert_eq!(done["ok"], json!(true));
    assert!(ctx.dem_dir().join(format!("{}.tif", tiles[0])).exists() && ctx.dem_dir().join(format!("{}.none", tiles[1])).exists());
    assert!(log.lock().unwrap().iter().any(|(n, _)| n == "dem-progress"));
}
