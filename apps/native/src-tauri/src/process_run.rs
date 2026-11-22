// SPDX-License-Identifier: AGPL-3.0-or-later

//! `process.run` (ADR 0106): a program of the device that the rider granted to an installed plugin,
//! started without a shell. The grants are the rider's plugin choices in the app files
//! (`config/plugin-choices.json`), read anew for every program; a program is found on the `PATH`
//! and where a GUI app's minimal `PATH` misses it (Homebrew, `/usr/local/bin`, `~/.local/bin`).
//! Its lines go to a channel; `process_cancel` ends it.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// The rider's choices of plugins, as far as the grants go.
#[derive(Deserialize, Default)]
struct Choices {
    #[serde(default)]
    disabled: Vec<String>,
    #[serde(default)]
    programs: HashMap<String, Vec<String>>,
}

/// The programs granted to the installed plugins that are on.
fn granted(choices: &Choices) -> HashSet<String> {
    choices
        .programs
        .iter()
        .filter(|(id, _)| !choices.disabled.contains(id))
        .flat_map(|(_, programs)| programs.iter().cloned())
        .collect()
}

/// A program's name, no path: what a manifest may name.
fn valid_name(program: &str) -> bool {
    let mut chars = program.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && program.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Where a program is: the first folder of `folders` that holds it as a file.
fn find(program: &str, folders: &[PathBuf]) -> Option<PathBuf> {
    folders.iter().map(|folder| folder.join(program)).find(|path| path.is_file())
}

/// The `PATH`, then the folders a GUI app's minimal `PATH` lacks.
fn search_folders() -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        folders.push(PathBuf::from(extra));
    }
    if let Some(home) = std::env::var_os("HOME") {
        folders.push(Path::new(&home).join(".local/bin"));
    }
    folders
}

/// The running programs, by the caller's id, to end them.
#[derive(Default)]
pub struct Processes(Mutex<HashMap<String, Arc<Mutex<std::process::Child>>>>);

/// A line a program wrote, on its standard output (`out`) or error (`err`).
#[derive(Clone, Serialize)]
pub struct Line {
    stream: &'static str,
    line: String,
}

fn read_choices(app: &AppHandle) -> Choices {
    app.path()
        .app_data_dir()
        .ok()
        .and_then(|dir| std::fs::read(dir.join("config").join("plugin-choices.json")).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Runs a granted program to its end; resolves with its exit code (-1 when a signal ended it).
#[tauri::command(async)]
pub fn process_run(
    app: AppHandle,
    state: State<'_, Processes>,
    id: String,
    program: String,
    args: Vec<String>,
    on_line: Channel<Line>,
) -> Result<i32, String> {
    if !valid_name(&program) || !granted(&read_choices(&app)).contains(&program) {
        return Err(format!("No installed plugin was granted the program \"{program}\""));
    }
    let path = find(&program, &search_folders()).ok_or_else(|| format!("The program \"{program}\" was not found"))?;
    let mut child = Command::new(path)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("The program \"{program}\" could not start: {e}"))?;
    let readers = [
        child.stdout.take().map(|out| ("out", Box::new(out) as Box<dyn std::io::Read + Send>)),
        child.stderr.take().map(|err| ("err", Box::new(err) as Box<dyn std::io::Read + Send>)),
    ];
    let threads: Vec<_> = readers
        .into_iter()
        .flatten()
        .map(|(stream, reader)| {
            let channel = on_line.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(reader).lines().map_while(Result::ok) {
                    let _ = channel.send(Line { stream, line });
                }
            })
        })
        .collect();
    let child = Arc::new(Mutex::new(child));
    state.0.lock().map_err(|e| e.to_string())?.insert(id.clone(), child.clone());
    for thread in threads {
        let _ = thread.join();
    }
    let status = child.lock().map_err(|e| e.to_string())?.wait().map_err(|e| e.to_string());
    state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(status?.code().unwrap_or(-1))
}

/// Ends the program of the caller's id, if it runs.
#[tauri::command]
pub fn process_cancel(state: State<'_, Processes>, id: String) -> Result<(), String> {
    if let Some(child) = state.0.lock().map_err(|e| e.to_string())?.get(&id) {
        let _ = child.lock().map_err(|e| e.to_string())?.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_only_the_programs_of_plugins_that_are_on() {
        let choices = Choices {
            disabled: vec!["off".into()],
            programs: HashMap::from([("on".into(), vec!["yt-dlp".into()]), ("off".into(), vec!["ffmpeg".into()])]),
        };
        assert_eq!(granted(&choices), HashSet::from(["yt-dlp".to_string()]));
    }

    #[test]
    fn a_program_is_a_name_never_a_path() {
        assert!(valid_name("yt-dlp"));
        assert!(!valid_name("../bin/sh"));
        assert!(!valid_name("/bin/sh"));
        assert!(!valid_name("-rf"));
        assert!(!valid_name(""));
    }

    #[test]
    fn finds_a_program_in_the_first_folder_that_holds_it() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        std::fs::write(second.path().join("tool"), b"").unwrap();
        let folders = [first.path().to_path_buf(), second.path().to_path_buf()];
        assert_eq!(find("tool", &folders), Some(second.path().join("tool")));
        assert_eq!(find("other", &folders), None);
    }
}
