// SPDX-License-Identifier: AGPL-3.0-or-later

//! The small file operations of `storage.media` below the media root.

use std::fs;
use std::path::Path;

use crate::paths::resolve;

pub fn exists(root: &Path, path: &str) -> Result<bool, String> {
    Ok(resolve(root, path)?.exists())
}

pub fn read(root: &Path, path: &str) -> Result<Vec<u8>, String> {
    fs::read(resolve(root, path)?).map_err(|e| format!("{path}: {e}"))
}

pub fn write(root: &Path, path: &str, bytes: &[u8]) -> Result<(), String> {
    let file = resolve(root, path)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&file, bytes).map_err(|e| format!("{path}: {e}"))
}

/// Moves a file, creating the target's directories; replaces a file there.
pub fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let target = resolve(root, to)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(resolve(root, from)?, &target).map_err(|e| format!("{from} → {to}: {e}"))
}

/// A file, or a directory with everything in it; a missing one is not an error.
pub fn remove(root: &Path, path: &str) -> Result<(), String> {
    let target = resolve(root, path)?;
    let result = if target.is_dir() { fs::remove_dir_all(&target) } else { fs::remove_file(&target) };
    match result {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{path}: {e}")),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_moves_and_removes_below_the_root() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        write(r, "videos/a/package.zip", &[1, 2, 3]).unwrap();
        rename(r, "videos/a/package.zip", "videos/a/route/video.mp4").unwrap();
        assert!(!exists(r, "videos/a/package.zip").unwrap());
        assert_eq!(read(r, "videos/a/route/video.mp4").unwrap(), vec![1, 2, 3]);
        remove(r, "videos/a").unwrap();
        assert!(!exists(r, "videos/a/route/video.mp4").unwrap());
        remove(r, "videos/missing").unwrap();
        assert!(read(r, "../outside").is_err());
    }
}
