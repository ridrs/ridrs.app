// SPDX-License-Identifier: AGPL-3.0-or-later

//! `data.archive` in Rust: every file of a ZIP (ZIP64 included) streamed into a folder of the
//! media root. A name that would leave the folder fails the whole extraction.

use std::fs;
use std::io;
use std::path::{Component, Path};

use crate::paths::resolve;

/// Unpacks `archive` into `directory` (media paths below `root`); returns the files' media paths.
pub fn extract(root: &Path, archive: &str, directory: &str) -> Result<Vec<String>, String> {
    let file = fs::File::open(resolve(root, archive)?).map_err(|e| format!("{archive}: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("{archive}: {e}"))?;
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
        io::copy(&mut entry, &mut out).map_err(|e| format!("{path}: {e}"))?;
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
        let files = extract(root.path(), "a.zip", "out").unwrap();
        assert_eq!(files, vec!["out/x.txt", "out/sub/y.txt"]);
        assert_eq!(fs::read_to_string(root.path().join("out/sub/y.txt")).unwrap(), "two");
    }

    #[test]
    fn refuses_a_name_that_would_leave_the_folder() {
        let root = tempfile::tempdir().unwrap();
        zip_of(&root.path().join("evil.zip"), &[("../escape.txt", "no")]);
        assert!(extract(root.path(), "evil.zip", "out").unwrap_err().contains("unsafe name"));
        assert!(!root.path().join("escape.txt").exists());
    }
}
