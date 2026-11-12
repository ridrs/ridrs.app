// SPDX-License-Identifier: AGPL-3.0-or-later

//! `data.pick` (plugins/data-pick-tauri, ADR 0090): the system's open dialog, opened from Rust,
//! and a copy of the chosen file into the media storage. The WebView never learns where the file
//! lies: it gets a token for the copy, the file's name and its size. A token is good for one copy.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use ridrs_media::commands::{root, throttled, Progress};
use ridrs_media::paths;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

/// The files chosen and not yet copied, by token: of the open dialog and of drags onto the
/// window (media_drop.rs, ADR 0093).
#[derive(Default)]
pub struct PickState {
    next: Mutex<u64>,
    chosen: Mutex<HashMap<String, PathBuf>>,
}

impl PickState {
    /// Keeps `path` behind a new token.
    pub fn register(&self, path: PathBuf) -> Result<String, String> {
        let token = {
            let mut next = self.next.lock().map_err(|e| e.to_string())?;
            *next += 1;
            next.to_string()
        };
        self.chosen.lock().map_err(|e| e.to_string())?.insert(token.clone(), path);
        Ok(token)
    }

    /// The file behind `token`, while it is not copied or forgotten.
    pub fn path(&self, token: &str) -> Result<PathBuf, String> {
        self.chosen
            .lock()
            .map_err(|e| e.to_string())?
            .get(token)
            .cloned()
            .ok_or_else(|| format!("no chosen file \"{token}\""))
    }

    /// Forgets the files behind `tokens`, copied or not.
    pub fn forget(&self, tokens: &[String]) -> Result<(), String> {
        let mut chosen = self.chosen.lock().map_err(|e| e.to_string())?;
        for token in tokens {
            chosen.remove(token);
        }
        Ok(())
    }
}

/// A file the rider chose: never its place on the device.
#[derive(Serialize)]
pub struct Picked {
    token: String,
    name: String,
    size: u64,
}

/// Opens the open dialog for files with one of `extensions`; `None` when the rider cancelled.
#[tauri::command]
pub async fn media_pick(
    app: AppHandle,
    state: State<'_, PickState>,
    name: String,
    extensions: Vec<String>,
) -> Result<Option<Picked>, String> {
    // The dialog runs on the main thread; waiting for it blocks a thread of the blocking pool.
    let dialog = app.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let extensions: Vec<&str> = extensions.iter().map(String::as_str).collect();
        dialog.dialog().file().add_filter(name, &extensions).blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let token = state.register(path)?;
    Ok(Some(Picked { token, name, size }))
}

/// Copies `from` to `to` in pieces, telling `progress` of the bytes copied and of the file's size.
fn copy(from: &std::path::Path, to: &std::path::Path, mut progress: impl FnMut(u64, Option<u64>)) -> Result<(), String> {
    use std::io::{Read, Write};
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut input = std::fs::File::open(from).map_err(|e| e.to_string())?;
    let size = input.metadata().map_err(|e| e.to_string())?.len();
    let mut output = std::fs::File::create(to).map_err(|e| e.to_string())?;
    let mut buffer = vec![0; 1 << 20];
    let mut copied = 0;
    progress(copied, Some(size));
    loop {
        let read = match input.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.to_string()),
        };
        output.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
        copied += read as u64;
        progress(copied, Some(size));
    }
    output.flush().map_err(|e| e.to_string())
}

/// Copies the chosen file of `token` to the media path `target`, off the async runtime, telling
/// how many of its bytes are copied.
#[tauri::command]
pub async fn media_pick_copy(
    app: AppHandle,
    state: State<'_, PickState>,
    token: String,
    target: String,
    on_progress: Channel<Progress>,
) -> Result<(), String> {
    let from = state
        .chosen
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&token)
        .ok_or_else(|| format!("no chosen file \"{token}\""))?;
    let to = paths::resolve(&root(&app)?, &target)?;
    let progress = throttled(on_progress);
    tauri::async_runtime::spawn_blocking(move || copy(&from, &to, progress))
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_a_file_and_tells_how_many_bytes_are_copied() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.zip"), b"twelve bytes").unwrap();
        let mut heard = Vec::new();
        copy(&dir.path().join("a.zip"), &dir.path().join("out/b.zip"), |received, size| {
            heard.push((received, size))
        })
        .unwrap();
        assert_eq!(std::fs::read(dir.path().join("out/b.zip")).unwrap(), b"twelve bytes");
        assert_eq!(heard.first(), Some(&(0, Some(12))));
        assert_eq!(heard.last(), Some(&(12, Some(12))));
    }
}
