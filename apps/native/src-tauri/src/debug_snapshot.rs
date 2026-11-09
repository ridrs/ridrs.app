// SPDX-License-Identifier: AGPL-3.0-or-later

//! A screenshot of the web view for the debug bridge (`apps/native/debug-bridge`): the native
//! snapshot of the `WKWebView`, which needs no screen recording permission. Debug builds on the
//! Mac only; a release build has no such command.

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
use objc2_foundation::{NSDictionary, NSError, NSNumber};
use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

/// Takes a snapshot of the main window's web view `width` points wide and writes it as a PNG to `path`.
#[tauri::command]
pub async fn debug_snapshot(
    window: tauri::WebviewWindow,
    width: f64,
    path: String,
) -> Result<String, String> {
    let (sender, receiver) = mpsc::channel::<Result<(), String>>();
    let target = path.clone();
    window
        .with_webview(move |webview| {
            // SAFETY: `inner` is the `WKWebView` of this window, and the closure runs on the main thread.
            let view: &WKWebView = unsafe { &*(webview.inner() as *const WKWebView) };
            let Some(main) = MainThreadMarker::new() else {
                let _ = sender.send(Err("Not on the main thread".into()));
                return;
            };
            let configuration = unsafe { WKSnapshotConfiguration::new(main) };
            unsafe { configuration.setSnapshotWidth(Some(&NSNumber::new_f64(width))) };
            let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let outcome = if image.is_null() {
                    let reason = unsafe { error.as_ref() }
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_else(|| "no image".into());
                    Err(format!("The snapshot failed: {reason}"))
                } else {
                    write_png(unsafe { &*image }, &target)
                };
                let _ = sender.send(outcome);
            });
            unsafe { view.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &handler) };
        })
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(15)))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "The snapshot did not finish within 15 s".to_string())??;
    Ok(path)
}

fn write_png(image: &NSImage, path: &str) -> Result<(), String> {
    let tiff = image.TIFFRepresentation().ok_or("The image has no data")?;
    let representation = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("The image is not a bitmap")?;
    let properties: Retained<NSDictionary<_, AnyObject>> = NSDictionary::new();
    let png = unsafe { representation.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) }
        .ok_or("The PNG could not be made")?;
    std::fs::write(path, png.to_vec()).map_err(|error| error.to_string())
}
