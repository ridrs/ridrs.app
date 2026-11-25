// SPDX-License-Identifier: AGPL-3.0-or-later

use std::path::Path;
use std::process::Command;

/// Builds `ridrs-refine` (helpers/ridrs-refine.swift, ADR 0110) for a Mac target as Tauri's
/// external binary `binaries/ridrs-refine-<target>`, which the bundle ships beside the app. It runs
/// on the app's macOS 11 and says on one older than 15.4 that it cannot compute in-between frames.
fn build_refine() {
    let target = std::env::var("TARGET").unwrap_or_default();
    println!("cargo:rerun-if-changed=helpers/ridrs-refine.swift");
    if !target.ends_with("apple-darwin") {
        return;
    }
    let arch = if target.starts_with("aarch64") { "arm64" } else { "x86_64" };
    std::fs::create_dir_all("binaries").expect("binaries/");
    let out = format!("binaries/ridrs-refine-{target}");
    let fresh = Path::new(&out).metadata().and_then(|m| m.modified()).ok()
        > Path::new("helpers/ridrs-refine.swift").metadata().and_then(|m| m.modified()).ok();
    if fresh {
        return;
    }
    let status = Command::new("xcrun")
        .args(["swiftc", "-O", "-swift-version", "5", "-target", &format!("{arch}-apple-macos11.0")])
        .args(["helpers/ridrs-refine.swift", "-o", &out])
        .status()
        .expect("swiftc (Xcode's command line tools) builds ridrs-refine");
    assert!(status.success(), "ridrs-refine did not build");
}

fn main() {
    build_refine();
    tauri_build::build()
}
