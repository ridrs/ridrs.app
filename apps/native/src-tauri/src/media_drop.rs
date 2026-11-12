// SPDX-License-Identifier: AGPL-3.0-or-later

//! `data.drop` (plugins/data-drop-tauri, ADR 0093): files dragged onto the window. The WebView
//! keeps its HTML5 drags (`dragDropEnabled: false`) and learns nothing about a dragged file
//! before it is let go; these commands read what is dragged from the system's drag pasteboard
//! while it hovers, as wry does for Tauri's own drag and drop, and keep the files behind the
//! tokens of `data.pick` (media_pick.rs): the WebView gets names, sizes and what a preview needs
//! (`ridrs_media::peek`), never a place on the device. A token is good for one copy
//! (`media_pick_copy`) and lasts until the next drag or until the drag leaves the window.

use std::path::PathBuf;
use std::sync::Mutex;

use ridrs_media::peek::{self, Peeked};
use serde::Serialize;
use tauri::State;
use tauri::ipc::Response;

use crate::media_pick::PickState;

/// A file of the drag: never its place on the device.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Dragged {
    token: String,
    name: String,
    size: u64,
}

/// The drag the tokens belong to: the drag pasteboard's change count, and its files.
#[derive(Default)]
pub struct DropState {
    drag: Mutex<Option<(isize, Vec<Dragged>)>>,
}

impl DropState {
    /// The files of the drag with `count` on the pasteboard: the same tokens for the same drag (its
    /// enter and its drop), new ones for a new drag, whose files of the last one are forgotten.
    fn files(&self, pick: &PickState, count: isize, paths: Vec<PathBuf>) -> Result<Vec<Dragged>, String> {
        let mut drag = self.drag.lock().map_err(|e| e.to_string())?;
        if let Some((known, files)) = drag.as_ref() {
            if *known == count {
                return Ok(files.clone());
            }
        }
        if let Some((_, old)) = drag.take() {
            pick.forget(&old.into_iter().map(|file| file.token).collect::<Vec<_>>())?;
        }
        let mut files = Vec::new();
        for path in paths {
            // A folder is no file to import.
            let Ok(metadata) = std::fs::metadata(&path) else { continue };
            if !metadata.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".into());
            files.push(Dragged { token: pick.register(path)?, name, size: metadata.len() });
        }
        *drag = Some((count, files.clone()));
        Ok(files)
    }

    /// The drag left the window: its files are forgotten.
    fn leave(&self, pick: &PickState) -> Result<(), String> {
        if let Some((_, old)) = self.drag.lock().map_err(|e| e.to_string())?.take() {
            pick.forget(&old.into_iter().map(|file| file.token).collect::<Vec<_>>())?;
        }
        Ok(())
    }

    /// Whether `token` is a file of the current drag: peeks reach no file of the open dialog.
    fn holds(&self, token: &str) -> Result<bool, String> {
        let drag = self.drag.lock().map_err(|e| e.to_string())?;
        Ok(drag.as_ref().is_some_and(|(_, files)| files.iter().any(|file| file.token == token)))
    }
}

/// The drag pasteboard's change count and the files on it.
#[cfg(target_os = "macos")]
fn dragged_paths() -> (isize, Vec<PathBuf>) {
    use std::ffi::CStr;

    use objc2::ClassType;
    use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag};
    use objc2_foundation::{NSArray, NSURL};

    // SAFETY: AppKit's pasteboard API on the pasteboard of drags, as wry's `collect_paths` uses it.
    unsafe {
        let pasteboard = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);
        let count = pasteboard.changeCount();
        let mut paths = Vec::new();
        let classes = NSArray::from_slice(&[NSURL::class()]);
        if let Some(items) = pasteboard.readObjectsForClasses_options(&classes, None) {
            for item in items.iter() {
                let Some(url) = item.downcast_ref::<NSURL>() else { continue };
                if !url.isFileURL() {
                    continue;
                }
                if let Some(path) = url.filePathURL().and_then(|url| url.path()) {
                    paths.push(PathBuf::from(CStr::from_ptr(path.UTF8String()).to_string_lossy().into_owned()));
                }
            }
        }
        (count, paths)
    }
}

/// Elsewhere there is no drag pasteboard to read: no files while a drag hovers.
#[cfg(not(target_os = "macos"))]
fn dragged_paths() -> (isize, Vec<PathBuf>) {
    (0, Vec::new())
}

/// The files being dragged; the page calls it when a drag of files enters and when it is let go.
#[tauri::command]
pub fn media_drop_files(pick: State<'_, PickState>, drop: State<'_, DropState>) -> Result<Vec<Dragged>, String> {
    let (count, paths) = dragged_paths();
    drop.files(&pick, count, paths)
}

/// The drag left the window without being let go.
#[tauri::command]
pub fn media_drop_leave(pick: State<'_, PickState>, drop: State<'_, DropState>) -> Result<(), String> {
    drop.leave(&pick)
}

/// What a preview may read of a dragged file (`ridrs_media::peek`).
#[tauri::command]
pub async fn media_drop_peek(
    pick: State<'_, PickState>,
    drop: State<'_, DropState>,
    token: String,
) -> Result<Peeked, String> {
    if !drop.holds(&token)? {
        return Err(format!("no dragged file \"{token}\""));
    }
    let path = pick.path(&token)?;
    tauri::async_runtime::spawn_blocking(move || peek::peek(&path)).await.map_err(|e| e.to_string())?
}

/// The bytes of a dragged file, or of one entry of it that its peek marked readable.
#[tauri::command]
pub async fn media_drop_read(
    pick: State<'_, PickState>,
    drop: State<'_, DropState>,
    token: String,
    entry: Option<String>,
) -> Result<Response, String> {
    if !drop.holds(&token)? {
        return Err(format!("no dragged file \"{token}\""));
    }
    let path = pick.path(&token)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || peek::read(&path, entry.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files_in(dir: &std::path::Path, names: &[&str]) -> Vec<PathBuf> {
        names
            .iter()
            .map(|name| {
                let path = dir.join(name);
                std::fs::write(&path, name.as_bytes()).unwrap();
                path
            })
            .collect()
    }

    #[test]
    fn keeps_the_tokens_of_one_drag_and_forgets_them_for_the_next() {
        let dir = tempfile::tempdir().unwrap();
        let (pick, drop) = (PickState::default(), DropState::default());
        let entered = drop.files(&pick, 7, files_in(dir.path(), &["a.zwo"])).unwrap();
        assert_eq!(entered.len(), 1);
        assert_eq!(entered[0].name, "a.zwo");
        assert_eq!(entered[0].size, 5);
        // The drop of the same drag: the same file, the same token.
        assert_eq!(drop.files(&pick, 7, Vec::new()).unwrap(), entered);
        assert!(drop.holds(&entered[0].token).unwrap());

        let next = drop.files(&pick, 8, files_in(dir.path(), &["b.ride"])).unwrap();
        assert_ne!(next[0].token, entered[0].token);
        assert!(pick.path(&entered[0].token).is_err());
        assert!(!drop.holds(&entered[0].token).unwrap());
    }

    #[test]
    fn leaves_out_folders_and_forgets_everything_when_the_drag_leaves() {
        let dir = tempfile::tempdir().unwrap();
        let (pick, drop) = (PickState::default(), DropState::default());
        let mut paths = files_in(dir.path(), &["a.zip"]);
        paths.push(dir.path().to_path_buf());
        let files = drop.files(&pick, 1, paths).unwrap();
        assert_eq!(files.len(), 1);
        drop.leave(&pick).unwrap();
        assert!(pick.path(&files[0].token).is_err());
        // The same drag entering again is new to it.
        assert_eq!(drop.files(&pick, 1, files_in(dir.path(), &["a.zip"])).unwrap().len(), 1);
    }

    #[test]
    fn holds_no_file_of_the_open_dialog() {
        let dir = tempfile::tempdir().unwrap();
        let (pick, drop) = (PickState::default(), DropState::default());
        let picked = pick.register(files_in(dir.path(), &["c.zip"]).remove(0)).unwrap();
        assert!(!drop.holds(&picked).unwrap());
    }
}
