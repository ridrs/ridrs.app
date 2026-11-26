// SPDX-License-Identifier: AGPL-3.0-or-later

//! `process.run` (ADR 0106): a program of the device that the rider granted to an installed plugin,
//! started without a shell. The grants are the rider's plugin choices in the app files
//! (`config/plugin-choices.json`), read anew for every program; a program is found on the `PATH`
//! and where a GUI app's minimal `PATH` misses it (Homebrew, `/usr/local/bin`, `~/.local/bin`).
//! Its lines go to a channel; `process_cancel` ends it. A program under a key outlives a reload of
//! the page: `process_attach` finds it again (ADR 0112).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};

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

/// One running program: who hears its lines, and its exit code once it has ended.
struct Run {
    child: Mutex<Child>,
    listeners: Mutex<Vec<Channel<Line>>>,
    exit: Mutex<Option<i32>>,
    ended: Condvar,
}

impl Run {
    fn hear(&self, line: Line) {
        if let Ok(listeners) = self.listeners.lock() {
            for listener in listeners.iter() {
                let _ = listener.send(line.clone());
            }
        }
    }

    fn wait_exit(&self) -> i32 {
        let mut exit = self.exit.lock().unwrap_or_else(|e| e.into_inner());
        while exit.is_none() {
            exit = self.ended.wait(exit).unwrap_or_else(|e| e.into_inner());
        }
        exit.unwrap_or(-1)
    }
}

/// The running programs (ADR 0112). A program outlives the page that started it: after a reload,
/// a caller with the program's key attaches to it and hears its lines and exit code, instead of
/// starting a second one that would race it over the same files (two yt-dlp on one video: one
/// merged and deleted the fragments the other still wanted).
#[derive(Default)]
pub struct Processes {
    /// The programs started under a key, by it.
    runs: Mutex<HashMap<String, Arc<Run>>>,
    /// Every program, by the id of each caller that waits for it, to end it.
    ids: Mutex<HashMap<String, Arc<Run>>>,
}

impl Processes {
    /// Hears `run` until it ends; resolves with its exit code.
    fn join(&self, id: &str, run: Arc<Run>, on_line: Channel<Line>) -> Result<i32, String> {
        run.listeners.lock().map_err(|e| e.to_string())?.push(on_line);
        self.ids.lock().map_err(|e| e.to_string())?.insert(id.to_string(), run.clone());
        let code = run.wait_exit();
        self.forget(id, &run);
        Ok(code)
    }

    /// Joins the program under `key`, if one runs; resolves with its exit code.
    fn attach(&self, id: &str, key: &str, on_line: Channel<Line>) -> Result<Option<i32>, String> {
        let run = self.runs.lock().map_err(|e| e.to_string())?.get(key).cloned();
        run.map(|run| self.join(id, run, on_line)).transpose()
    }

    /// Runs the program `start` starts to its end, or, under a `key` where one runs, attaches to
    /// that one; resolves with its exit code (-1 when a signal ended it).
    fn run(
        &self,
        id: &str,
        key: Option<String>,
        on_line: Channel<Line>,
        start: impl FnOnce() -> Result<Child, String>,
    ) -> Result<i32, String> {
        let mut runs = self.runs.lock().map_err(|e| e.to_string())?;
        if let Some(run) = key.as_ref().and_then(|key| runs.get(key).cloned()) {
            drop(runs);
            return self.join(id, run, on_line);
        }
        let mut child = start()?;
        let readers = [
            child.stdout.take().map(|out| ("out", Box::new(out) as Box<dyn std::io::Read + Send>)),
            child.stderr.take().map(|err| ("err", Box::new(err) as Box<dyn std::io::Read + Send>)),
        ];
        let run = Arc::new(Run {
            child: Mutex::new(child),
            listeners: Mutex::new(vec![on_line]),
            exit: Mutex::new(None),
            ended: Condvar::new(),
        });
        if let Some(key) = &key {
            runs.insert(key.clone(), run.clone());
        }
        drop(runs);
        self.ids.lock().map_err(|e| e.to_string())?.insert(id.to_string(), run.clone());
        let threads: Vec<_> = readers
            .into_iter()
            .flatten()
            .map(|(stream, reader)| {
                let run = run.clone();
                std::thread::spawn(move || {
                    for line in BufReader::new(reader).lines().map_while(Result::ok) {
                        run.hear(Line { stream, line });
                    }
                })
            })
            .collect();
        for thread in threads {
            let _ = thread.join();
        }
        let status = run.child.lock().map_err(|e| e.to_string())?.wait().map_err(|e| e.to_string());
        // Gone from the running ones before its end is told: a run after it starts anew.
        if let (Some(key), Ok(mut runs)) = (&key, self.runs.lock()) {
            if runs.get(key).is_some_and(|each| Arc::ptr_eq(each, &run)) {
                runs.remove(key);
            }
        }
        let code = status.as_ref().map(|status| status.code().unwrap_or(-1)).unwrap_or(-1);
        *run.exit.lock().unwrap_or_else(|e| e.into_inner()) = Some(code);
        run.ended.notify_all();
        self.forget(id, &run);
        status.map(|_| code)
    }

    fn forget(&self, id: &str, run: &Arc<Run>) {
        if let Ok(mut ids) = self.ids.lock() {
            if ids.get(id).is_some_and(|each| Arc::ptr_eq(each, run)) {
                ids.remove(id);
            }
        }
    }

    /// Ends the program the caller of `id` started or attached to, if it runs.
    fn cancel(&self, id: &str) -> Result<(), String> {
        let run = self.ids.lock().map_err(|e| e.to_string())?.get(id).cloned();
        if let Some(run) = run {
            let _ = run.child.lock().map_err(|e| e.to_string())?.kill();
        }
        Ok(())
    }

    /// Ends every running program: programs do not outlive the app.
    pub fn end_all(&self) {
        let runs: Vec<_> = self.ids.lock().map(|ids| ids.values().cloned().collect()).unwrap_or_default();
        for run in runs {
            if let Ok(mut child) = run.child.lock() {
                let _ = child.kill();
            }
        }
    }
}

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

/// Runs a granted program to its end, or, under a `key` where one runs, attaches to that one;
/// resolves with its exit code (-1 when a signal ended it).
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn process_run(
    app: AppHandle,
    state: State<'_, Processes>,
    id: String,
    program: String,
    args: Vec<String>,
    key: Option<String>,
    on_line: Channel<Line>,
) -> Result<i32, String> {
    if !valid_name(&program) || !granted(&read_choices(&app)).contains(&program) {
        return Err(format!("No installed plugin was granted the program \"{program}\""));
    }
    state.run(&id, key, on_line, || {
        let path = find(&program, &search_folders()).ok_or_else(|| format!("The program \"{program}\" was not found"))?;
        Command::new(path)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("The program \"{program}\" could not start: {e}"))
    })
}

/// Joins the program under `key`, if one runs (ADR 0112); resolves with its exit code, or with
/// none at once.
#[tauri::command(async)]
pub fn process_attach(state: State<'_, Processes>, id: String, key: String, on_line: Channel<Line>) -> Result<Option<i32>, String> {
    state.attach(&id, &key, on_line)
}

/// Ends the program of the caller's id, if it runs.
#[tauri::command]
pub fn process_cancel(state: State<'_, Processes>, id: String) -> Result<(), String> {
    state.cancel(&id)
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

    fn quiet() -> Channel<Line> {
        Channel::new(|_| Ok(()))
    }

    fn shell(script: &str) -> Result<Child, String> {
        Command::new("sh")
            .args(["-c", script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())
    }

    fn key() -> Option<String> {
        Some("download-youtube:route".into())
    }

    #[test]
    fn a_run_under_a_key_that_runs_attaches_to_its_program() {
        let processes = Arc::new(Processes::default());
        let first = {
            let processes = processes.clone();
            std::thread::spawn(move || processes.run("before-reload", key(), quiet(), || shell("sleep 0.5; exit 3")))
        };
        std::thread::sleep(std::time::Duration::from_millis(150));
        let started_again = std::sync::atomic::AtomicBool::new(false);
        let second = processes.run("after-reload", key(), quiet(), || {
            started_again.store(true, std::sync::atomic::Ordering::SeqCst);
            shell("exit 0")
        });
        assert_eq!(second, Ok(3));
        assert!(!started_again.load(std::sync::atomic::Ordering::SeqCst), "no second program");
        assert_eq!(first.join().unwrap(), Ok(3));
        // Once it has ended, nothing runs under the key, and the same run starts anew.
        assert_eq!(processes.attach("later", "download-youtube:route", quiet()), Ok(None));
        assert_eq!(processes.run("later", key(), quiet(), || shell("exit 5")), Ok(5));
    }

    #[test]
    fn the_page_that_attached_can_end_the_program() {
        let processes = Arc::new(Processes::default());
        let first = {
            let processes = processes.clone();
            std::thread::spawn(move || processes.run("before-reload", key(), quiet(), || shell("sleep 30")))
        };
        std::thread::sleep(std::time::Duration::from_millis(150));
        let second = {
            let processes = processes.clone();
            std::thread::spawn(move || processes.attach("after-reload", "download-youtube:route", quiet()))
        };
        std::thread::sleep(std::time::Duration::from_millis(150));
        processes.cancel("after-reload").unwrap();
        assert_eq!(second.join().unwrap(), Ok(Some(-1)));
        assert_eq!(first.join().unwrap(), Ok(-1));
    }

    #[test]
    fn programs_end_with_the_app() {
        let processes = Arc::new(Processes::default());
        let run = {
            let processes = processes.clone();
            std::thread::spawn(move || processes.run("a", None, quiet(), || shell("sleep 30")))
        };
        std::thread::sleep(std::time::Duration::from_millis(150));
        processes.end_all();
        assert_eq!(run.join().unwrap(), Ok(-1));
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
