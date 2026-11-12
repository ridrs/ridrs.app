// SPDX-License-Identifier: AGPL-3.0-or-later

//! `data.archive` in Rust: every file of a ZIP (ZIP64 included) streamed into a folder of the
//! media root. A name that would leave the folder fails the whole extraction.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path};

use crate::paths::resolve;

/// Unpacks `archive` into `directory` (media paths below `root`); returns the files' media paths.
/// `progress` hears of the bytes unpacked so far and of the files' unpacked size in all.
pub fn extract(
    root: &Path,
    archive: &str,
    directory: &str,
    mut progress: impl FnMut(u64, u64),
) -> Result<Vec<String>, String> {
    let file = fs::File::open(resolve(root, archive)?).map_err(|e| format!("{archive}: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("{archive}: {e}"))?;
    let mut size = 0;
    for index in 0..zip.len() {
        let entry = zip.by_index_raw(index).map_err(|e| format!("{archive}: {e}"))?;
        if !entry.is_dir() {
            size += entry.size();
        }
    }
    let mut done = 0;
    progress(done, size);
    let mut extracted = Vec::new();
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| format!("{archive}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let raw = entry.name().map(|name| name.into_owned()).unwrap_or_default();
        let name = entry
            .enclosed_name()
            .ok_or_else(|| format!("{archive}: unsafe name \"{raw}\""))?;
        let segments: Vec<String> = name
            .components()
            .map(|c| match c {
                Component::Normal(s) => Ok(s.to_string_lossy().into_owned()),
                _ => Err(format!("{archive}: unsafe name \"{raw}\"")),
            })
            .collect::<Result<_, _>>()?;
        let path = format!("{directory}/{}", segments.join("/"));
        let target = resolve(root, &path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&target).map_err(|e| format!("{path}: {e}"))?;
        let mut buffer = vec![0; 1 << 20];
        loop {
            let read = match entry.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(format!("{path}: {e}")),
            };
            out.write_all(&buffer[..read]).map_err(|e| format!("{path}: {e}"))?;
            done += read as u64;
            progress(done, size);
        }
        extracted.push(path);
    }
    Ok(extracted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_of(path: &Path, files: &[(&str, &str)]) {
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, text) in files {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn unpacks_every_file_and_names_them() {
        let root = tempfile::tempdir().unwrap();
        zip_of(&root.path().join("a.zip"), &[("x.txt", "one"), ("sub/y.txt", "two")]);
        let files = extract(root.path(), "a.zip", "out", |_, _| {}).unwrap();
        assert_eq!(files, vec!["out/x.txt", "out/sub/y.txt"]);
        assert_eq!(fs::read_to_string(root.path().join("out/sub/y.txt")).unwrap(), "two");
    }

    #[test]
    fn tells_how_many_bytes_are_unpacked() {
        let root = tempfile::tempdir().unwrap();
        zip_of(&root.path().join("a.zip"), &[("x.txt", "one"), ("sub/y.txt", "three")]);
        let mut heard = Vec::new();
        extract(root.path(), "a.zip", "out", |received, size| heard.push((received, size))).unwrap();
        assert_eq!(heard.first(), Some(&(0, 8)));
        assert_eq!(heard.last(), Some(&(8, 8)));
    }

    #[test]
    fn refuses_a_name_that_would_leave_the_folder() {
        let root = tempfile::tempdir().unwrap();
        zip_of(&root.path().join("evil.zip"), &[("../escape.txt", "no")]);
        assert!(extract(root.path(), "evil.zip", "out", |_, _| {}).unwrap_err().contains("unsafe name"));
        assert!(!root.path().join("escape.txt").exists());
    }
}
