// SPDX-License-Identifier: AGPL-3.0-or-later

//! Downloads a package into a media root and unpacks it, as the app's `media_fetch` and
//! `media_extract` do, for checking a source by hand:
//!
//!   cargo run --example fetch-and-extract -- <url> <media root> <target> <directory>
//!
//! Run it again after an interruption: it goes on where it stopped.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [url, root, target, directory] = args.as_slice() else {
        return Err("usage: fetch-and-extract <url> <media root> <target> <directory>".into());
    };
    let root = PathBuf::from(root);
    let started = Instant::now();
    let mut shown = 0;
    let fetched = ridrs_media::fetch::fetch(
        &reqwest::Client::new(),
        &ridrs_media::paths::resolve(&root, target)?,
        url,
        None,
        &AtomicBool::new(false),
        |received, size| {
            let percent = size.map_or(0, |s| received * 100 / s.max(1));
            if percent >= shown + 10 {
                shown = percent;
                eprintln!("{percent} % after {:.0} s", started.elapsed().as_secs_f64());
            }
        },
    )
    .await?;
    eprintln!("fetched {} bytes in {:.0} s", fetched.size, started.elapsed().as_secs_f64());
    let files = ridrs_media::archive::extract(&root, target, directory)?;
    eprintln!("extracted {files:?} after {:.0} s", started.elapsed().as_secs_f64());
    Ok(())
}
