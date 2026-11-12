// SPDX-License-Identifier: AGPL-3.0-or-later

//! A look into a file the rider drags onto the window, before it is copied (ADR 0093): what a
//! preview needs, read in place. A ZIP is read through its central directory, so a package of
//! 15 GB costs as much as one of 15 kB; only small entries of the kinds a preview reads (control
//! files, tracks, workouts) are unpacked. The limits are those of `data.drop` in the contracts.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

/// Bytes read of one file or of one entry of a ZIP, at most (`PEEK_LIMIT` of the contracts).
pub const PEEK_LIMIT: u64 = 8 * 1024 * 1024;

/// The entries of a ZIP whose bytes a peek reads (`PEEK_EXTENSIONS` of the contracts).
pub const PEEK_EXTENSIONS: &[&str] = &["xml", "gpx", "json", "zwo", "fit", "erg", "mrc", "tcx", "txt", "md"];

/// One file entry of a ZIP.
#[derive(Debug, PartialEq, Serialize)]
pub struct PeekedEntry {
    pub name: String,
    pub size: u64,
    /// Whether [`read`] gives its bytes.
    pub readable: bool,
}

/// What a peek finds: a ZIP's file entries, or whether the file itself can be read.
#[derive(Debug, PartialEq, Serialize)]
pub struct Peeked {
    /// `None` for a file that is no ZIP, or a ZIP that cannot be read.
    pub entries: Option<Vec<PeekedEntry>>,
    /// Whether [`read`] without an entry gives the file's bytes: no ZIP, and small enough.
    pub readable: bool,
}

fn peekable(name: &str) -> bool {
    let extension = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    extension.is_some_and(|e| PEEK_EXTENSIONS.contains(&e.as_str()))
}

fn archive(path: &Path) -> Option<zip::ZipArchive<fs::File>> {
    zip::ZipArchive::new(fs::File::open(path).ok()?).ok()
}

/// Looks into `path`: never reads more than a ZIP's central directory.
pub fn peek(path: &Path) -> Result<Peeked, String> {
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    let Some(mut zip) = archive(path) else {
        return Ok(Peeked { entries: None, readable: size <= PEEK_LIMIT });
    };
    let mut entries = Vec::new();
    for index in 0..zip.len() {
        let entry = zip.by_index_raw(index).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().map(|n| n.into_owned()).unwrap_or_default();
        let size = entry.size();
        entries.push(PeekedEntry { readable: peekable(&name) && size <= PEEK_LIMIT, name, size });
    }
    Ok(Peeked { entries: Some(entries), readable: false })
}

/// The bytes of `path` itself (`entry` `None`), or of its ZIP entry `entry`, within the limits of
/// [`peek`]. An entry that claims to be small but unpacks to more is refused.
pub fn read(path: &Path, entry: Option<&str>) -> Result<Vec<u8>, String> {
    let Some(name) = entry else {
        let peeked = peek(path)?;
        if !peeked.readable {
            return Err("the file is too large or a ZIP".into());
        }
        return fs::read(path).map_err(|e| e.to_string());
    };
    if !peekable(name) {
        return Err(format!("\"{name}\" is not read for a preview"));
    }
    let mut zip = archive(path).ok_or("the file is no ZIP")?;
    let file = zip.by_name(name).map_err(|e| format!("\"{name}\": {e}"))?;
    let mut bytes = Vec::new();
    file.take(PEEK_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > PEEK_LIMIT {
        return Err(format!("\"{name}\" is too large for a preview"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_of(path: &Path, files: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.add_directory("pack/", options).unwrap();
        for (name, bytes) in files {
            zip.start_file(*name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn lists_a_package_and_marks_what_a_preview_reads() {
        let dir = tempfile::tempdir().unwrap();
        let pack = dir.path().join("Col.ride");
        let video = vec![0u8; 1000];
        zip_of(&pack, &[("pack/Col.xml", b"<gpx-import/>"), ("pack/Col.GPX", b"<gpx/>"), ("pack/Col.mp4", &video)]);
        let peeked = peek(&pack).unwrap();
        assert!(!peeked.readable);
        assert_eq!(
            peeked.entries.unwrap(),
            vec![
                PeekedEntry { name: "pack/Col.xml".into(), size: 13, readable: true },
                PeekedEntry { name: "pack/Col.GPX".into(), size: 6, readable: true },
                PeekedEntry { name: "pack/Col.mp4".into(), size: 1000, readable: false },
            ]
        );
        assert_eq!(read(&pack, Some("pack/Col.GPX")).unwrap(), b"<gpx/>");
        assert!(read(&pack, Some("pack/Col.mp4")).unwrap_err().contains("not read"));
        assert!(read(&pack, Some("pack/Other.gpx")).is_err());
        assert!(read(&pack, None).is_err());
    }

    #[test]
    fn reads_a_small_file_and_refuses_a_large_one() {
        let dir = tempfile::tempdir().unwrap();
        let workout = dir.path().join("a.zwo");
        fs::write(&workout, "<workout_file/>").unwrap();
        assert_eq!(peek(&workout).unwrap(), Peeked { entries: None, readable: true });
        assert_eq!(read(&workout, None).unwrap(), b"<workout_file/>");

        let video = dir.path().join("b.mp4");
        fs::File::create(&video).unwrap().set_len(PEEK_LIMIT + 1).unwrap();
        assert_eq!(peek(&video).unwrap(), Peeked { entries: None, readable: false });
        assert!(read(&video, None).is_err());
    }

    #[test]
    fn refuses_an_entry_too_large_for_a_preview() {
        let dir = tempfile::tempdir().unwrap();
        let pack = dir.path().join("big.zip");
        let track = vec![b' '; (PEEK_LIMIT + 1) as usize];
        zip_of(&pack, &[("big.gpx", &track)]);
        let entries = peek(&pack).unwrap().entries.unwrap();
        assert!(!entries[0].readable);
        assert!(read(&pack, Some("big.gpx")).unwrap_err().contains("too large"));
    }
}
