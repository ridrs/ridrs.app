// SPDX-License-Identifier: AGPL-3.0-or-later

//! Media paths: relative, `/`-separated, without `.`, `..`, empty segments or backslashes, as the
//! contract's `assertAppFilePath` checks them. Everything the JS side names lies below the root.

use std::path::{Path, PathBuf};

/// `path` below `root`, or an error naming the path.
pub fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
    let segments: Vec<&str> = path.split('/').collect();
    let valid = !path.is_empty()
        && !path.contains('\\')
        && !path.contains(':')
        && segments
            .iter()
            .all(|s| !s.is_empty() && *s != "." && *s != "..");
    if !valid {
        return Err(format!("invalid media path \"{path}\""));
    }
    Ok(segments.iter().fold(root.to_path_buf(), |dir, s| dir.join(s)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_below_the_root_and_refuses_the_rest() {
        let root = Path::new("/media");
        assert_eq!(resolve(root, "videos/a/route.json").unwrap(), Path::new("/media/videos/a/route.json"));
        for bad in ["", "../x", "a/../b", "a//b", "/abs", "a\\b", "c:/x", "./a"] {
            assert!(resolve(root, bad).is_err(), "{bad}");
        }
    }
}
