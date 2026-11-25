// SPDX-License-Identifier: AGPL-3.0-or-later

//! `video.interpolate` (ADR 0110): one refined stretch of a route's video, computed by the app's own
//! program `ridrs-refine` (helpers/ridrs-refine.swift, beside the app's executable) with Apple's
//! frame rate conversion. The media paths are resolved in the media root; the program runs
//! without a shell, its progress goes to a channel and `video_interpolate_cancel` ends it.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use ridrs_media::commands as media;
use ridrs_media::paths::resolve;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

/// The program, beside the app's executable (Tauri's external binary).
const PROGRAM: &str = "ridrs-refine";

/// The running programs, by the caller's id, to end them.
#[derive(Default)]
pub struct Interpolations(Mutex<HashMap<String, Arc<Mutex<std::process::Child>>>>);

/// The stretch as computed: the time of its first frame and of the frame after its last.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Interpolated {
    pub from: f64,
    pub to: f64,
}

/// A line the program printed: its progress or, last, the stretch it made.
#[derive(Deserialize, Debug, PartialEq)]
#[serde(untagged)]
enum Report {
    Progress { progress: f64 },
    Done { from: f64, to: f64 },
}

fn program() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe.parent().map(|dir| dir.join(PROGRAM)).ok_or("The app has no folder")?;
    if path.is_file() {
        Ok(path)
    } else {
        Err("This device cannot compute in-between frames: the app lacks ridrs-refine".into())
    }
}

/// The last line of what the program wrote on its error output: why it failed.
fn reason(stderr: &str, code: Option<i32>) -> String {
    stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
        .unwrap_or_else(|| format!("ridrs-refine ended with {}", code.map_or("a signal".into(), |c| c.to_string())))
}

/// Computes one stretch; resolves with its times once the program ended well.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn video_interpolate(
    app: AppHandle,
    state: State<'_, Interpolations>,
    id: String,
    video: String,
    from: f64,
    to: f64,
    factor: u32,
    target: String,
    on_progress: Channel<f64>,
) -> Result<Interpolated, String> {
    let root = media::root(&app)?;
    let video = resolve(&root, &video)?;
    let target = resolve(&root, &target)?;
    if let Some(folder) = target.parent() {
        std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    }
    let mut child = Command::new(program()?)
        .args(["--video".as_ref(), video.as_os_str()])
        .args(["--from", &from.to_string(), "--to", &to.to_string(), "--factor", &factor.to_string()])
        .args(["--out".as_ref(), target.as_os_str()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ridrs-refine could not start: {e}"))?;
    let stdout = child.stdout.take().ok_or("No output of ridrs-refine")?;
    let mut stderr = child.stderr.take().ok_or("No error output of ridrs-refine")?;
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let child = Arc::new(Mutex::new(child));
    state.0.lock().map_err(|e| e.to_string())?.insert(id.clone(), child.clone());
    let mut done = None;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        match serde_json::from_str::<Report>(&line) {
            Ok(Report::Progress { progress }) => {
                let _ = on_progress.send(progress);
            }
            Ok(Report::Done { from, to }) => done = Some(Interpolated { from, to }),
            Err(_) => {}
        }
    }
    let status = child.lock().map_err(|e| e.to_string())?.wait().map_err(|e| e.to_string());
    state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    let stderr = errors.join().unwrap_or_default();
    match (status?, done) {
        (status, Some(done)) if status.success() => Ok(done),
        (status, _) => Err(reason(&stderr, status.code())),
    }
}

/// Ends the program of the caller's id, if it runs.
#[tauri::command]
pub fn video_interpolate_cancel(state: State<'_, Interpolations>, id: String) -> Result<(), String> {
    if let Some(child) = state.0.lock().map_err(|e| e.to_string())?.get(&id) {
        let _ = child.lock().map_err(|e| e.to_string())?.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_progress_and_the_stretch_from_the_program_lines() {
        assert_eq!(serde_json::from_str::<Report>(r#"{"progress":0.42}"#).unwrap(), Report::Progress { progress: 0.42 });
        assert_eq!(
            serde_json::from_str::<Report>(r#"{"from":600.0,"to":610.0,"frames":1200}"#).unwrap(),
            Report::Done { from: 600.0, to: 610.0 }
        );
    }

    #[test]
    fn the_reason_is_the_last_line_of_the_error_output() {
        assert_eq!(reason("warning\nThe video has no video track\n\n", Some(1)), "The video has no video track");
        assert_eq!(reason("", Some(3)), "ridrs-refine ended with 3");
        assert_eq!(reason("", None), "ridrs-refine ended with a signal");
    }
}
