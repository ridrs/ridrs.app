// SPDX-License-Identifier: AGPL-3.0-or-later

//! `data.pick` (plugins/data-pick-tauri, ADR 0090): the system's open dialog, opened from Rust,
//! and a copy of the chosen file into the media storage. The WebView never learns where the file
//! lies: it gets a token for the copy, the file's name and its size. A token is good for one copy.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use ridrs_media::commands::{root, throttled, Progress};
use ridrs_media::peek::{self, Peeked};
use ridrs_media::archive;
use ridrs_media::paths;
use serde::Serialize;
use tauri::ipc::{Channel, Response};
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

/// Whether `file` and the folder `dir` lie on one volume: there a copy can be a clone.
#[cfg(unix)]
fn one_volume(file: &std::fs::Metadata, dir: &std::path::Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(dir).is_ok_and(|folder| folder.dev() == file.dev())
}

#[cfg(not(unix))]
fn one_volume(_: &std::fs::Metadata, _: &std::path::Path) -> bool {
    false
}

/// Copies `from` to `to`, telling `progress` of the bytes copied and of the file's size. On one
/// volume `std::fs::copy`, a clone on APFS (`fclonefileat`): no bytes are written (ADR 0094).
/// Across volumes in pieces, with progress.
fn copy(from: &std::path::Path, to: &std::path::Path, mut progress: impl FnMut(u64, Option<u64>)) -> Result<(), String> {
    let parent = to.parent().ok_or_else(|| format!("{}: no folder", to.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut input = std::fs::File::open(from).map_err(|e| e.to_string())?;
    let metadata = input.metadata().map_err(|e| e.to_string())?;
    let size = metadata.len();
    if one_volume(&metadata, parent) {
        progress(0, Some(size));
        std::fs::copy(from, to).map_err(|e| e.to_string())?;
        progress(size, Some(size));
        return Ok(());
    }
    copy_in_pieces(&mut input, size, to, progress)
}

/// Copies `input` of `size` bytes to `to` in pieces of 1 MB, telling `progress` after each.
fn copy_in_pieces(
    input: &mut std::fs::File,
    size: u64,
    to: &std::path::Path,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<(), String> {
    use std::io::{Read, Write};
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

/// The chosen file of `token`, taken: a token is good for one copy or one unpacking.
fn take(state: &PickState, token: &str) -> Result<PathBuf, String> {
    state
        .chosen
        .lock()
        .map_err(|e| e.to_string())?
        .remove(token)
        .ok_or_else(|| format!("no chosen file \"{token}\""))
}

/// What a preview or an import may read of the chosen file of `token` (`peek.rs`): a ZIP's
/// entries, whether each is stored, and the small ones' bytes through [`media_pick_read`].
#[tauri::command]
pub async fn media_pick_peek(state: State<'_, PickState>, token: String) -> Result<Peeked, String> {
    let path = state.path(&token)?;
    tauri::async_runtime::spawn_blocking(move || peek::peek(&path)).await.map_err(|e| e.to_string())?
}

/// The bytes of the chosen file of `token`, or of one entry of it that its peek marked readable.
#[tauri::command]
pub async fn media_pick_read(
    state: State<'_, PickState>,
    token: String,
    entry: Option<String>,
) -> Result<Response, String> {
    let path = state.path(&token)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || peek::read(&path, entry.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

/// Unpacks the chosen ZIP of `token` into the media folder `directory`, straight from where it
/// lies (ADR 0094), off the async runtime, telling how many of its files' bytes are unpacked.
#[tauri::command]
pub async fn media_pick_extract(
    app: AppHandle,
    state: State<'_, PickState>,
    token: String,
    directory: String,
    on_progress: Channel<Progress>,
) -> Result<(), String> {
    let from = take(&state, &token)?;
    let root = root(&app)?;
    paths::resolve(&root, &directory)?;
    let mut progress = throttled(on_progress);
    tauri::async_runtime::spawn_blocking(move || {
        archive::extract_from(&root, &from, &directory, |received, size| progress(received, Some(size))).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
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
    let from = take(&state, &token)?;
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
    fn copies_in_pieces_and_tells_how_many_bytes_are_copied() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.zip"), vec![7u8; (1 << 20) + 5]).unwrap();
        let mut input = std::fs::File::open(dir.path().join("a.zip")).unwrap();
        let mut heard = Vec::new();
        copy_in_pieces(&mut input, (1 << 20) + 5, &dir.path().join("b.zip"), |received, size| {
            heard.push((received, size))
        })
        .unwrap();
        assert_eq!(std::fs::read(dir.path().join("b.zip")).unwrap().len(), (1 << 20) + 5);
        let size = Some((1 << 20) + 5);
        assert_eq!(heard, [(0, size), (1 << 20, size), ((1 << 20) + 5, size)]);
    }

    #[test]
    fn copies_a_file_on_one_volume_at_once() {
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
