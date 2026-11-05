// SPDX-License-Identifier: AGPL-3.0-or-later

//! What `@tauri-apps/plugin-fs` cannot do for `storage.app-files`: flush to the disk.
//! `app_file_replace` (ADR 0054) writes a temporary file, flushes it and renames it over the old
//! one; `app_file_sync` (ADR 0055) flushes a file appended to. `File::sync_all` is `F_FULLFSYNC`
//! on Apple platforms. Paths are relative to the app data directory, below the allowed folders.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// The folders the JS side may replace files in; the fs plugin's scopes name the same.
const REPLACEABLE: &[&str] = &["recordings", "training", "config"];
/// Only recordings are appended to while riding.
const SYNCABLE: &[&str] = &["recordings"];

/// `path` below `allowed`, without `.`, `..`, empty segments or backslashes.
fn resolve(app: &AppHandle, path: &str, allowed: &[&str]) -> Result<PathBuf, String> {
    let segments: Vec<&str> = path.split('/').collect();
    let valid = segments.len() > 1
        && !path.contains('\\')
        && segments
            .iter()
            .all(|s| !s.is_empty() && *s != "." && *s != "..")
        && allowed.contains(&segments[0]);
    if !valid {
        return Err(format!("invalid app file path \"{path}\""));
    }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(segments.iter().fold(root, |dir, s| dir.join(s)))
}

fn sync_directory(directory: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    fs::File::open(directory)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

/// After a crash the file is the old one or the new one, never a mixture.
#[tauri::command(async)]
pub fn app_file_replace(app: AppHandle, path: String, bytes: Vec<u8>) -> Result<(), String> {
    let file = resolve(&app, &path, REPLACEABLE)?;
    let directory = file.parent().ok_or("no directory")?.to_path_buf();
    let run = || -> std::io::Result<()> {
        fs::create_dir_all(&directory)?;
        let mut temporary = file.clone().into_os_string();
        temporary.push(".tmp");
        let temporary = PathBuf::from(temporary);
        {
            let mut out = fs::File::create(&temporary)?;
            out.write_all(&bytes)?;
            out.sync_all()?;
        }
        fs::rename(&temporary, &file)?;
        sync_directory(&directory)
    };
    run().map_err(|e| format!("{path}: {e}"))
}

/// Resolves once what was appended to `path` is on the disk.
#[tauri::command(async)]
pub fn app_file_sync(app: AppHandle, path: String) -> Result<(), String> {
    let file = resolve(&app, &path, SYNCABLE)?;
    fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("{path}: {e}"))
}
