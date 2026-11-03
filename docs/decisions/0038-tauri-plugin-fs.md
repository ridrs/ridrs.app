<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0038: Files in the Native App with `@tauri-apps/plugin-fs`

`storage-files-tauri` uses the official Tauri fs plugin (**@tauri-apps/plugin-fs** 2.7.1, MIT OR Apache-2.0; Rust crate `tauri-plugin-fs` 2.7.1 registered in `src-tauri/src/lib.rs`) with `BaseDirectory.AppData`. The capability `src-tauri/capabilities/default.json` allows only `exists`, `mkdir`, `read-dir`, `stat`, `read-file`, `write-file`, `write-text-file` and `remove`, scoped to `$APPDATA/recordings` and `$APPDATA/recordings/**`. On iOS the files stay in the app container for now (no share sheet in Phase 9).

Not verified in this phase's implementation: the Rust side was not compiled (no Rust toolchain on the implementing machine); `Cargo.lock` updates on the next `cargo build`.
