// SPDX-License-Identifier: AGPL-3.0-or-later

//! A screenshot of the web view for the debug bridge (`apps/native/debug-bridge`): the native
//! snapshot of the `WKWebView` (`web_snapshot`), which needs no screen recording permission.
//! Debug builds on the Mac only; a release build has no such command.

use std::path::Path;

use crate::web_snapshot::{self, Format};

/// Takes a snapshot of the main window's web view `width` points wide and writes it as a PNG to `path`.
#[tauri::command]
pub async fn debug_snapshot(
    window: tauri::WebviewWindow,
    width: f64,
    path: String,
) -> Result<String, String> {
    web_snapshot::take(&window, Some(width), Path::new(&path), Format::Png).await?;
    Ok(path)
}
