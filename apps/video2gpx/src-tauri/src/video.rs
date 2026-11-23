use crate::ctx::Ctx;
use crate::settings;
use serde_json::{json, Value};
use std::path::Path;
use std::process::Command;

fn tools(ctx: &Ctx) -> (Option<std::path::PathBuf>, Option<std::path::PathBuf>) {
    let s = settings::load(ctx);
    (settings::ffmpeg(&s), settings::ffprobe(&s))
}

fn title_for(path: &Path, tag_title: Option<&str>) -> String {
    if let Some(t) = tag_title.filter(|t| !t.trim().is_empty()) {
        return t.trim().to_string();
    }
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let generic = ["video", "movie", "input", "source", "clip"];
    if generic.contains(&stem.to_lowercase().as_str()) {
        if let Some(parent) = path.parent().and_then(|p| p.file_name()) {
            return parent.to_string_lossy().replace(['-', '_'], " ");
        }
    }
    stem
}

/// ffprobe: duration, codec, size, HDR flag, creation time, title.
pub fn probe(ctx: &Ctx, path: &str) -> Result<Value, String> {
    let (_, fp) = tools(ctx);
    let fp = fp.ok_or("ffprobe nicht gefunden (Einstellungen: Pfad zu ffprobe, oder per Homebrew installieren: brew install ffmpeg)")?;
    let p = Path::new(path);
    if !p.is_file() {
        return Err(format!("Datei nicht gefunden: {path}"));
    }
    let out = Command::new(fp)
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries",
               "stream=codec_name,width,height,pix_fmt,color_transfer,r_frame_rate,duration:format=duration,format_name:format_tags=creation_time,title",
               "-of", "json", path])
        .output()
        .map_err(|e| format!("ffprobe konnte nicht gestartet werden: {e}"))?;
    if !out.status.success() {
        return Err(format!("ffprobe: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let st = v["streams"].get(0).cloned().unwrap_or(json!({}));
    let fmt = &v["format"];
    let num = |x: &Value| x.as_str().and_then(|s| s.parse::<f64>().ok());
    let duration = num(&fmt["duration"]).or_else(|| num(&st["duration"]));
    let ct = st["color_transfer"].as_str().unwrap_or("");
    let hdr = ct == "smpte2084" || ct == "arib-std-b67";
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    Ok(json!({
        "path": path,
        "title": title_for(p, fmt["tags"]["title"].as_str()),
        "duration": duration,
        "codec": st["codec_name"],
        "width": st["width"], "height": st["height"],
        "pix_fmt": st["pix_fmt"],
        "hdr": hdr,
        "container": fmt["format_name"],
        "creation_time": fmt["tags"]["creation_time"],
        "bytes": meta.len(),
        "ext": p.extension().map(|e| e.to_string_lossy().to_lowercase()),
    }))
}

fn hdr_filter() -> &'static str {
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
}

/// One preview frame as JPEG (width 960). HDR gets a tone-mapping attempt first, plain scaling as fallback.
pub fn poster(ctx: &Ctx, project: &str, path: &str, t: f64, hdr: bool) -> Result<String, String> {
    let (ff, _) = tools(ctx);
    let ff = ff.ok_or("ffmpeg nicht gefunden (Einstellungen: Pfad zu ffmpeg)")?;
    let dest = ctx.project_dir(project)?.join("poster.jpg");
    let attempts: Vec<String> = if hdr {
        vec![format!("{},scale=960:-2", hdr_filter()), "scale=960:-2".into()]
    } else {
        vec!["scale=960:-2".into()]
    };
    let mut last = String::new();
    for vf in attempts {
        let _ = std::fs::remove_file(&dest);
        let o = Command::new(&ff)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", &format!("{t:.2}"), "-i", path, "-frames:v", "1", "-vf", &vf, "-q:v", "3"])
            .arg(&dest)
            .output()
            .map_err(|e| e.to_string())?;
        if o.status.success() && dest.exists() {
            return Ok(dest.to_string_lossy().into());
        }
        last = String::from_utf8_lossy(&o.stderr).trim().to_string();
    }
    Err(format!("Vorschaubild konnte nicht erzeugt werden: {last}"))
}

/// Fallback for formats the web view cannot play: one JPEG every `step` seconds in one decoding pass (the first frame
/// at or after each multiple of step; the exact presentation times come from showinfo, as in rsm.bench.verify_map).
/// Gentle on the machine: hardware decoding first (software if that fails), at most 4 decoder threads, low priority.
/// Times are appended to frame_times.partial as frames come out, so an interrupted run resumes where it stopped.
pub fn frames(ctx: &Ctx, project: &str, path: &str, step: f64, hdr: bool) -> Result<Value, String> {
    let (ff, _) = tools(ctx);
    let ff = ff.ok_or("ffmpeg nicht gefunden")?;
    let dir = ctx.project_dir(project)?.join("frames");
    let tfile = dir.join("frame_times.json");
    let pfile = dir.join("frame_times.partial");
    if let Ok(s) = std::fs::read_to_string(&tfile) {
        if let Ok(times) = serde_json::from_str::<Vec<f64>>(&s) {
            if !times.is_empty() && count_frames(&dir) == times.len() {
                return Ok(json!({"dir": dir, "times": times}));
            }
        }
    }
    stop_stray(&dir.join("ffmpeg.pid"));
    let mut times = resume_point(&dir, &pfile);
    if times.is_empty() {
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let start = times.last().map(|t| t + step - 0.02);
    let k0 = times.len();
    // VideoToolbox exists on macOS only; elsewhere decode in software straight away
    let hw = cfg!(target_os = "macos");
    let mut err = run_frames(&ff, path, &dir, &pfile, step, hdr, start, k0, hw, &mut times);
    if hw && err.is_some() && times.len() == k0 && count_frames(&dir) == k0 {
        // nothing new came out: maybe the hardware decoder does not take this codec, try in software
        if let Some(e) = &err {
            eprintln!("video_frames: hardware decoding failed ({e}), retrying in software");
        }
        err = run_frames(&ff, path, &dir, &pfile, step, hdr, start, k0, false, &mut times);
    }
    let n = count_frames(&dir);
    if let Some(e) = err {
        return Err(if n == 0 { format!("Keine Bilder extrahiert: {e}") } else { format!("Einzelbilder unvollständig ({n} Bilder): {e}") });
    }
    if n == 0 {
        return Err("Keine Bilder extrahiert".into());
    }
    times.truncate(n);
    if times.len() != n {
        return Err(format!("{} Zeitstempel für {n} Bilder", times.len()));
    }
    std::fs::write(&tfile, serde_json::to_string(&times).unwrap()).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&pfile);
    Ok(json!({"dir": dir, "times": times}))
}

fn is_frame(name: &str) -> bool {
    name.len() == 10 && name.starts_with('f') && name.ends_with(".jpg") && name[1..6].bytes().all(|b| b.is_ascii_digit())
}

fn count_frames(dir: &Path) -> usize {
    std::fs::read_dir(dir).map(|r| r.filter_map(|e| e.ok()).filter(|e| is_frame(&e.file_name().to_string_lossy())).count()).unwrap_or(0)
}

fn read_partial(pfile: &Path) -> Vec<f64> {
    std::fs::read_to_string(pfile).map(|s| s.lines().filter_map(|l| l.trim().parse().ok()).collect()).unwrap_or_default()
}

/// Frames and times of an interrupted run that can be kept. The last frame is dropped (its JPEG may be cut off),
/// as are frames without a time; the files and the partial list are trimmed to match. Empty: start from scratch.
fn resume_point(dir: &Path, pfile: &Path) -> Vec<f64> {
    let mut times = read_partial(pfile);
    let k = times.len().min(count_frames(dir)).saturating_sub(1);
    if k == 0 {
        return vec![];
    }
    times.truncate(k);
    if let Ok(r) = std::fs::read_dir(dir) {
        for e in r.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().to_string();
            if is_frame(&name) && name[1..6].parse::<usize>().map(|i| i > k).unwrap_or(false) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let body: String = times.iter().map(|t| format!("{t}\n")).collect();
    if std::fs::write(pfile, body).is_err() || count_frames(dir) != k {
        return vec![];
    }
    times
}

fn frames_args(path: &str, dir: &Path, step: f64, hdr: bool, start: Option<f64>, first: usize, hw: bool) -> Vec<String> {
    let sel = format!("select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,{:.2})',showinfo", step - 0.02);
    let scale = if hdr { format!("{},scale=720:-2", hdr_filter()) } else { "scale=720:-2".to_string() };
    let mut a: Vec<String> = ["-hide_banner", "-nostats", "-loglevel", "info", "-y"].iter().map(|s| s.to_string()).collect();
    if hw {
        a.extend(["-hwaccel".into(), "videotoolbox".into()]);
    }
    a.extend(["-threads".into(), "4".into()]);
    if let Some(t) = start {
        // input seek is frame-accurate; -copyts keeps showinfo's pts_time on the video's own clock
        a.extend(["-ss".into(), format!("{t:.3}"), "-copyts".into()]);
    }
    a.extend(["-i".into(), path.into(), "-filter_threads".into(), "2".into(), "-vf".into(), format!("{sel},{scale}")]);
    a.extend(["-fps_mode".into(), "passthrough".into(), "-q:v".into(), "4".into(), "-start_number".into(), (first + 1).to_string()]);
    a.push(dir.join("f%05d.jpg").to_string_lossy().into());
    a
}

/// One ffmpeg pass; appends each frame's time to `times` and to the partial file. None on success, else the last
/// line ffmpeg wrote.
#[allow(clippy::too_many_arguments)]
fn run_frames(ff: &Path, path: &str, dir: &Path, pfile: &Path, step: f64, hdr: bool, start: Option<f64>, first: usize, hw: bool, times: &mut Vec<f64>) -> Option<String> {
    use std::io::{BufRead, Write};
    times.truncate(first);
    let pidfile = dir.join("ffmpeg.pid");
    let mut child = match spawn_gentle(ff, &frames_args(path, dir, step, hdr, start, first, hw), &pidfile) {
        Ok(c) => c,
        Err(e) => return Some(e),
    };
    let mut out = std::fs::OpenOptions::new().create(true).append(true).open(pfile).ok();
    let mut last = String::new();
    if let Some(se) = child.stderr.take() {
        for line in std::io::BufReader::new(se).lines().map_while(Result::ok) {
            if let Some(t) = pts_time(&line) {
                times.push(t);
                if let Some(f) = out.as_mut() {
                    let _ = writeln!(f, "{t}");
                }
            } else if !line.trim().is_empty() && !line.contains("Parsed_showinfo") {
                last = line;
            }
        }
    }
    let status = child.wait();
    let _ = std::fs::remove_file(&pidfile);
    match status {
        Ok(s) if s.success() => None,
        Ok(s) => Some(format!("ffmpeg endete mit {s}: {last}")),
        Err(e) => Some(e.to_string()),
    }
}

/// Starts ffmpeg at low priority (the machine stays responsive) and records its pid, so a run left over from an
/// app that was quit can be stopped by `stop_stray`. stderr is piped.
fn spawn_gentle(ff: &Path, args: &[String], pidfile: &Path) -> Result<std::process::Child, String> {
    let child = Command::new(ff)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, child.id(), 10);
    }
    let _ = std::fs::write(pidfile, child.id().to_string());
    Ok(child)
}

/// The file the video panel plays. WebKit's WebM player reads a WebM/MKV file from start to end into memory as soon
/// as playback or a seek starts (gigabytes for a long 4K video: the machine swaps, the app hangs), while its MP4
/// player reads only what it needs. So a WebM/MKV with a codec MP4 can hold is copied once, without re-encoding the
/// picture, into playback.mp4 in the project; times stay the same. Other files are played as they are.
pub fn playback(ctx: &Ctx, project: &str, path: &str, codec: &str) -> Result<String, String> {
    if !needs_playback_copy(path, codec) {
        return Ok(path.to_string());
    }
    let dir = ctx.project_dir(project)?;
    // one copy per project at a time: started at import, opening the project waits for it here
    let lock = playback_lock(project);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    let dest = dir.join("playback.mp4");
    let srcfile = dir.join("playback.src");
    let src_time = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    let dest_time = std::fs::metadata(&dest).and_then(|m| m.modified()).ok();
    let same_src = std::fs::read_to_string(&srcfile).map(|s| s == path).unwrap_or(false);
    if same_src && dest_time.is_some() && dest_time >= src_time {
        return Ok(dest.to_string_lossy().into());
    }
    let _ = std::fs::remove_file(&dest);
    let _ = std::fs::remove_file(&srcfile);
    let (ff, _) = tools(ctx);
    let ff = ff.ok_or("ffmpeg nicht gefunden")?;
    let pidfile = dir.join("playback.pid");
    stop_stray(&pidfile);
    let tmp = dir.join("playback.part.mp4");
    let args: Vec<String> = ["-hide_banner", "-nostats", "-loglevel", "error", "-y", "-i", path, "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"]
        .iter().map(|s| s.to_string()).chain([tmp.to_string_lossy().to_string()]).collect();
    let out = spawn_gentle(&ff, &args, &pidfile)?.wait_with_output().map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&pidfile);
    let out = out?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Wiedergabekopie fehlgeschlagen: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")));
    }
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    std::fs::write(&srcfile, path).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into())
}

fn playback_lock(project: &str) -> std::sync::Arc<std::sync::Mutex<()>> {
    static LOCKS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<()>>>>> = std::sync::OnceLock::new();
    let mut m = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    m.entry(project.to_string()).or_default().clone()
}

/// WebM/MKV, and MP4s whose frame index is spread over fragments (DASH, as downloaded from streaming sites): WebKit
/// reads WebM whole into memory, and walks every fragment of a fragmented MP4 before it knows the duration (minutes for
/// a long video). A copy without re-encoding into a plain MP4 with the index in front plays at once.
fn needs_playback_copy(path: &str, codec: &str) -> bool {
    if !matches!(codec, "av1" | "h264" | "hevc") {
        return false;
    }
    let ext = Path::new(path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "webm" | "mkv" => true,
        "mp4" | "m4v" | "mov" => std::fs::File::open(path).map(is_fragmented_mp4).unwrap_or(false),
        _ => false,
    }
}

/// A fragmented MP4: a `moof` box comes before the first `mdat` among the top-level boxes.
fn is_fragmented_mp4(mut f: impl std::io::Read + std::io::Seek) -> bool {
    use std::io::SeekFrom;
    let mut pos = 0u64;
    for _ in 0..64 {
        let mut h = [0u8; 8];
        if f.seek(SeekFrom::Start(pos)).is_err() || f.read_exact(&mut h).is_err() {
            return false;
        }
        let mut size = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64;
        match &h[4..8] {
            b"moof" => return true,
            b"mdat" => return false,
            _ => {}
        }
        if size == 1 {
            let mut l = [0u8; 8];
            if f.read_exact(&mut l).is_err() {
                return false;
            }
            size = u64::from_be_bytes(l);
        }
        if size < 8 {
            return false;
        }
        pos += size;
    }
    false
}

/// An ffmpeg left over from an app that was quit mid-run keeps decoding at full speed into the same folder; stop it.
fn stop_stray(pidfile: &Path) {
    let Some(pid) = std::fs::read_to_string(pidfile).ok().and_then(|s| s.trim().parse::<i32>().ok()) else { return };
    let _ = std::fs::remove_file(pidfile);
    let comm = Command::new("ps").args(["-p", &pid.to_string(), "-o", "comm="]).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    if comm.trim().ends_with("ffmpeg") {
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        for _ in 0..20 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}

fn pts_time(line: &str) -> Option<f64> {
    let i = line.find("pts_time:")?;
    let num: String = line[i + 9..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    num.parse().ok()
}

#[cfg(test)]
mod frames_tests {
    use super::*;

    fn mp4_box(kind: &[u8; 4], body: usize) -> Vec<u8> {
        let mut b = ((8 + body) as u32).to_be_bytes().to_vec();
        b.extend_from_slice(kind);
        b.resize(8 + body, 0);
        b
    }

    #[test]
    fn fragmented_mp4_has_moof_before_mdat() {
        let file = |kinds: &[&[u8; 4]]| std::io::Cursor::new(kinds.iter().flat_map(|k| mp4_box(k, 20)).collect::<Vec<u8>>());
        assert!(is_fragmented_mp4(file(&[b"ftyp", b"moov", b"sidx", b"moof", b"mdat"])));
        assert!(!is_fragmented_mp4(file(&[b"ftyp", b"moov", b"mdat"])));
        assert!(!is_fragmented_mp4(file(&[b"ftyp", b"mdat", b"moov"])));
        assert!(!is_fragmented_mp4(file(&[])));
        // a 64-bit box size (size field 1) before the fragments
        let mut big = mp4_box(b"ftyp", 12);
        big.extend_from_slice(&1u32.to_be_bytes());
        big.extend_from_slice(b"free");
        big.extend_from_slice(&24u64.to_be_bytes());
        big.resize(big.len() + 8, 0);
        big.extend(mp4_box(b"moof", 4));
        assert!(is_fragmented_mp4(std::io::Cursor::new(big)));
        // a broken size stops the walk instead of looping
        let mut bad = 4u32.to_be_bytes().to_vec();
        bad.extend_from_slice(b"ftyp");
        assert!(!is_fragmented_mp4(std::io::Cursor::new(bad)));
    }

    /// Real ffmpeg (skipped without it): a fragmented MP4 (DASH, as from streaming sites) gets the playback copy, a
    /// normal one is played as it is.
    #[test]
    fn playback_copy_for_fragmented_mp4() {
        let d = std::env::temp_dir().join(format!("v2g-frag-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let ctx = Ctx::new(d.clone(), std::sync::Arc::new(|_, _| {}));
        let Some(ff) = tools(&ctx).0 else { return };
        let mk = |name: &str, flags: &str| {
            let f = d.join(name);
            let ok = Command::new(&ff).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", "3", "-c:v", "libx264", "-g", "25", "-movflags", flags])
                .arg(&f).status().map(|s| s.success()).unwrap_or(false);
            ok.then(|| f.to_string_lossy().to_string())
        };
        let (Some(frag), Some(plain)) = (mk("frag.mp4", "frag_keyframe+empty_moov+default_base_moof"), mk("plain.mp4", "+faststart")) else { return };
        assert!(needs_playback_copy(&frag, "h264"));
        assert!(!needs_playback_copy(&plain, "h264"));
        assert!(!needs_playback_copy(&frag, "vp9"));
        std::fs::create_dir_all(ctx.project_dir("p").unwrap()).unwrap();
        let copy = playback(&ctx, "p", &frag, "h264").unwrap();
        assert!(copy.ends_with("playback.mp4"));
        assert!(!is_fragmented_mp4(std::fs::File::open(&copy).unwrap()));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn playback_copy_only_for_webm_mkv_with_mp4_codecs() {
        assert!(needs_playback_copy("/v/a.webm", "av1"));
        assert!(needs_playback_copy("/v/a.MKV", "hevc"));
        assert!(!needs_playback_copy("/v/a.webm", "vp9"));
        assert!(!needs_playback_copy("/v/a.mp4", "av1"));
    }

    /// Real ffmpeg (skipped without it): the copy started at import and the one asked for on opening run as one; the
    /// copy is reused; a different source file gets a new copy.
    #[test]
    fn playback_copy_once_per_source() {
        let d = std::env::temp_dir().join(format!("v2g-playback-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let ctx = Ctx::new(d.clone(), std::sync::Arc::new(|_, _| {}));
        let Some(ff) = tools(&ctx).0 else { return };
        std::fs::create_dir_all(ctx.project_dir("p").unwrap()).unwrap();
        let mk = |name: &str, secs: &str| {
            let f = d.join(name);
            let ok = Command::new(&ff).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", secs, "-c:v", "libx264"])
                .arg(&f).status().map(|s| s.success()).unwrap_or(false);
            ok.then(|| f.to_string_lossy().to_string())
        };
        let (Some(a), Some(b)) = (mk("a.mkv", "3"), mk("b.mkv", "5")) else { return };
        let (c1, c2, a1, a2) = (ctx.clone(), ctx.clone(), a.clone(), a.clone());
        let t1 = std::thread::spawn(move || playback(&c1, "p", &a1, "h264"));
        let t2 = std::thread::spawn(move || playback(&c2, "p", &a2, "h264"));
        let (r1, r2) = (t1.join().unwrap().unwrap(), t2.join().unwrap().unwrap());
        assert_eq!(r1, r2);
        assert!(r1.ends_with("playback.mp4"));
        let first = std::fs::metadata(&r1).unwrap().modified().unwrap();
        assert_eq!(playback(&ctx, "p", &a, "h264").unwrap(), r1);
        assert_eq!(std::fs::metadata(&r1).unwrap().modified().unwrap(), first, "reused, not copied again");
        let dur = |f: &str| {
            let o = Command::new(tools(&ctx).1.unwrap()).args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).output().unwrap();
            String::from_utf8_lossy(&o.stdout).trim().parse::<f64>().unwrap()
        };
        assert!((dur(&r1) - 3.0).abs() < 0.2);
        assert_eq!(playback(&ctx, "p", &b, "h264").unwrap(), r1);
        assert!((dur(&r1) - 5.0).abs() < 0.2, "new source, new copy");
        assert!(!ctx.project_dir("p").unwrap().join("playback.part.mp4").exists());
        assert_eq!(playback(&ctx, "p", "/x/c.mp4", "h264").unwrap(), "/x/c.mp4");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn frame_names() {
        assert!(is_frame("f00001.jpg"));
        assert!(!is_frame("frame_times.json"));
        assert!(!is_frame("frame_times.partial"));
        assert!(!is_frame("f0001.jpg"));
    }

    #[test]
    fn resume_drops_last_frame_and_extras() {
        let d = std::env::temp_dir().join(format!("v2g-frames-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        for i in 1..=4 {
            std::fs::write(d.join(format!("f{i:05}.jpg")), b"x").unwrap();
        }
        let p = d.join("frame_times.partial");
        std::fs::write(&p, "0\n5.005\n10.01\n15.015\n20.02\n").unwrap();
        assert_eq!(resume_point(&d, &p), vec![0.0, 5.005, 10.01]);
        assert_eq!(count_frames(&d), 3);
        assert_eq!(read_partial(&p).len(), 3);
        std::fs::write(&p, "").unwrap();
        assert!(resume_point(&d, &p).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn args_resume_and_hw() {
        let a = frames_args("/v.webm", Path::new("/f"), 5.0, false, Some(12.5), 3, true).join(" ");
        assert!(a.contains("-hwaccel videotoolbox -threads 4 -ss 12.500 -copyts -i /v.webm"));
        assert!(a.ends_with("-start_number 4 /f/f%05d.jpg"));
        let b = frames_args("/v.webm", Path::new("/f"), 5.0, false, None, 0, false).join(" ");
        assert!(!b.contains("hwaccel") && !b.contains("-ss") && b.contains("-start_number 1"));
        assert_eq!(pts_time("[Parsed_showinfo_1 @ 0x1] n:   0 pts:   1001 pts_time:1.001 duration:"), Some(1.001));
    }
}
