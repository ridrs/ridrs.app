// SPDX-License-Identifier: AGPL-3.0-or-later

//! Native BLE surface behind `ble.central` (packages/ble-tauri; hosted by ridrs and the
//! companion): scan, connect, subscribe, write, disconnect, connection-lost.
//!
//! Platform backends come from `tauri-plugin-blec` (btleplug on Windows/macOS/iOS, its own Kotlin
//! backend on Android). This module only adds what the ridrs `BleCentral` needs and blec's own
//! JS commands lack: a service-UUID scan filter, a Rust-side receive timestamp per notification,
//! and binary (not JSON number array) notification frames. It never interprets payloads.

// Tauri command macros clash at a crate root, so the commands live in a module.
pub mod commands;

pub use commands::process_start;
