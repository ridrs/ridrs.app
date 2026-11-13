// SPDX-License-Identifier: AGPL-3.0-or-later

//! A video route's folder (ADR 0094): the entries of its package `route.ride`, where there is one,
//! and the files beside it, which count as entries. A file whose path equals an entry's path
//! (letters compared without case) replaces that entry; any other adds one. A folder without a
//! package is a route of its files alone. Hidden files (`.DS_Store`) are no entries.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use crate::paths::resolve;

/// The package in a route's folder; never an entry itself.
pub const PACKAGE: &str = "route.ride";

/// Where an entry's bytes lie.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Place {
    /// A file in the route's folder.
    File(PathBuf),
    /// A stored entry of the package: its bytes from this offset of `route.ride`, as they are.
    Stored { offset: u64 },
    /// A compressed entry of the package, the package's entry of this index: only whole.
    Packed { index: usize },
}

/// An entry of a route: its path relative to the folder, `/`-separated, its size and its place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub place: Place,
}

/// The entries of the route in the media folder `folder`: the package's in its order, each replaced
/// by a file of its path, then the other files in the order of their paths.
pub fn entries(root: &Path, folder: &str) -> Result<Vec<Entry>, String> {
    let dir = resolve(root, folder)?;
    if !dir.is_dir() {
        return Err(format!("{folder}: no route"));
    }
    let mut files = Vec::new();
    files_below(&dir, "", &mut files)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let package = dir.join(PACKAGE);
    let mut entries = if package.is_file() { package_entries(&package, folder)? } else { Vec::new() };
    for file in files {
        match entries.iter_mut().find(|entry| entry.path.eq_ignore_ascii_case(&file.path)) {
            Some(entry) => *entry = file,
            None => entries.push(file),
        }
    }
    Ok(entries)
}

/// The entry `path` of the route in `folder`, letters compared without case.
pub fn entry(root: &Path, folder: &str, path: &str) -> Result<Option<Entry>, String> {
    Ok(entries(root, folder)?.into_iter().find(|entry| entry.path.eq_ignore_ascii_case(path)))
}

/// The bytes of the entry `path`, whole; refused when it is larger than `limit`.
pub fn read(root: &Path, folder: &str, path: &str, limit: u64) -> Result<Vec<u8>, String> {
    let entry = entry(root, folder, path)?.ok_or_else(|| format!("{folder}: no entry \"{path}\""))?;
    if entry.size > limit {
        return Err(format!("{folder}/{path}: {} bytes, more than {limit} at once", entry.size));
    }
    let package = || resolve(root, &format!("{folder}/{PACKAGE}"));
    let mut bytes = Vec::with_capacity(entry.size as usize);
    match entry.place {
        Place::File(file) => {
            fs::File::open(&file)
                .and_then(|mut f| f.read_to_end(&mut bytes))
                .map_err(|e| format!("{folder}/{path}: {e}"))?;
        }
        Place::Stored { offset } => {
            let mut file = fs::File::open(package()?).map_err(|e| format!("{folder}: {e}"))?;
            bytes.resize(entry.size as usize, 0);
            file.seek(SeekFrom::Start(offset))
                .and_then(|_| file.read_exact(&mut bytes))
                .map_err(|e| format!("{folder}/{path}: {e}"))?;
        }
        Place::Packed { index } => {
            let file = fs::File::open(package()?).map_err(|e| format!("{folder}: {e}"))?;
            let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("{folder}: {e}"))?;
            let mut packed = zip.by_index(index).map_err(|e| format!("{folder}/{path}: {e}"))?;
            packed.read_to_end(&mut bytes).map_err(|e| format!("{folder}/{path}: {e}"))?;
        }
    }
    Ok(bytes)
}

/// The files below `dir`, their paths relative to the route's folder; not the package, nothing hidden.
fn files_below(dir: &Path, prefix: &str, files: &mut Vec<Entry>) -> Result<(), String> {
    for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || (prefix.is_empty() && name == PACKAGE) {
            continue;
        }
        let path = format!("{prefix}{name}");
        let kind = item.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            files_below(&item.path(), &format!("{path}/"), files)?;
        } else if kind.is_file() {
            let size = item.metadata().map_err(|e| e.to_string())?.len();
            files.push(Entry { path, size, place: Place::File(item.path()) });
        }
    }
    Ok(())
}

/// The files of the package `route.ride`; a name that would leave the folder refuses the package.
fn package_entries(package: &Path, folder: &str) -> Result<Vec<Entry>, String> {
    let file = fs::File::open(package).map_err(|e| format!("{folder}/{PACKAGE}: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("{folder}/{PACKAGE}: {e}"))?;
    let mut entries = Vec::new();
    for index in 0..zip.len() {
        let packed = zip.by_index_raw(index).map_err(|e| format!("{folder}/{PACKAGE}: {e}"))?;
        if packed.is_dir() {
            continue;
        }
        let raw = packed.name().map(|name| name.into_owned()).unwrap_or_default();
        let unsafe_name = || format!("{folder}/{PACKAGE}: unsafe name \"{raw}\"");
        let name = packed.enclosed_name().ok_or_else(unsafe_name)?;
        let segments: Vec<String> = name
            .components()
            .map(|c| match c {
                Component::Normal(s) => Ok(s.to_string_lossy().into_owned()),
                _ => Err(unsafe_name()),
            })
            .collect::<Result<_, _>>()?;
        let place = match (packed.compression(), packed.data_start()) {
            (zip::CompressionMethod::Stored, Some(offset)) => Place::Stored { offset },
            _ => Place::Packed { index },
        };
        entries.push(Entry { path: segments.join("/"), size: packed.size(), place });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    /// A package of `files` (name, text, stored or not) in the folder `route` of a new media root.
    fn route(files: &[(&str, &str, bool)]) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("route")).unwrap();
        let mut zip = zip::ZipWriter::new(fs::File::create(root.path().join("route").join(PACKAGE)).unwrap());
        for (name, text, stored) in files {
            let method = if *stored { CompressionMethod::Stored } else { CompressionMethod::Deflated };
            zip.start_file(*name, SimpleFileOptions::default().compression_method(method)).unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        root
    }

    fn beside(root: &tempfile::TempDir, path: &str, text: &str) {
        let file = root.path().join("route").join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }

    fn paths(entries: &[Entry]) -> Vec<&str> {
        entries.iter().map(|entry| entry.path.as_str()).collect()
    }

    #[test]
    fn finds_a_stored_entry_as_a_run_of_the_package() {
        let root = route(&[("Col.xml", "<gpx-import/>", false), ("Col.mp4", "frames of the video", true)]);
        let video = entry(root.path(), "route", "Col.mp4").unwrap().unwrap();
        let Place::Stored { offset } = video.place else { panic!("stored, not {:?}", video.place) };
        let package = fs::read(root.path().join("route").join(PACKAGE)).unwrap();
        assert_eq!(&package[offset as usize..][..video.size as usize], b"frames of the video");
    }

    #[test]
    fn reads_stored_and_compressed_entries_whole() {
        let root = route(&[("Col.xml", "<gpx-import/>", false), ("Col.mp4", "video", true)]);
        assert_eq!(read(root.path(), "route", "col.xml", 1024).unwrap(), b"<gpx-import/>");
        assert_eq!(read(root.path(), "route", "Col.mp4", 1024).unwrap(), b"video");
        assert!(read(root.path(), "route", "Col.mp4", 4).unwrap_err().contains("more than 4"));
        assert!(read(root.path(), "route", "Col.gpx", 1024).unwrap_err().contains("no entry"));
    }

    #[test]
    fn a_file_beside_the_package_replaces_its_entry_or_adds_one() {
        let root = route(&[("Col.xml", "old", false), ("Col.mp4", "video", true)]);
        beside(&root, "col.XML", "new control file");
        beside(&root, "pictures/preview.jpg", "picture");
        beside(&root, ".DS_Store", "hidden");
        let entries = entries(root.path(), "route").unwrap();
        assert_eq!(paths(&entries), ["col.XML", "Col.mp4", "pictures/preview.jpg"]);
        assert_eq!(read(root.path(), "route", "Col.xml", 1024).unwrap(), b"new control file");
        assert!(matches!(entries[0].place, Place::File(_)));
    }

    #[test]
    fn a_folder_without_a_package_is_a_route_of_its_files() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("route/sub")).unwrap();
        fs::write(root.path().join("route/route.xml"), "control").unwrap();
        fs::write(root.path().join("route/video.mp4"), "video").unwrap();
        fs::write(root.path().join("route/sub/track.gpx"), "track").unwrap();
        let entries = entries(root.path(), "route").unwrap();
        assert_eq!(paths(&entries), ["route.xml", "sub/track.gpx", "video.mp4"]);
        assert_eq!(read(root.path(), "route", "sub/track.gpx", 1024).unwrap(), b"track");
    }

    #[test]
    fn refuses_a_package_with_a_name_that_would_leave_the_folder() {
        let root = route(&[("../escape.txt", "no", true)]);
        assert!(entries(root.path(), "route").unwrap_err().contains("unsafe name"));
    }

    #[test]
    fn refuses_a_folder_outside_the_media_or_missing() {
        let root = tempfile::tempdir().unwrap();
        assert!(entries(root.path(), "../route").is_err());
        assert!(entries(root.path(), "route").unwrap_err().contains("no route"));
    }
}
