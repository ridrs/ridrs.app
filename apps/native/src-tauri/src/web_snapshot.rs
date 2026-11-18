// SPDX-License-Identifier: AGPL-3.0-or-later

//! The native snapshot of the main window's `WKWebView` (ADR 0077, ADR 0102): what the page
//! shows, with its video and canvases, without the screen recording permission. macOS only; the
//! debug bridge's screenshot and the rider's screenshot of a ride both take it.

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSImageCompressionFactor};
use objc2_foundation::{NSDictionary, NSError, NSNumber, NSString};
use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

/// The file a snapshot is written as.
#[derive(Clone, Copy)]
pub enum Format {
    /// Only the debug bridge takes PNGs, and release builds have no debug bridge.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    Png,
    /// With a compression factor from 0 (smallest) to 1 (best).
    Jpeg(f64),
}

/// Takes a snapshot of the window's web view, `width` points wide (its own width without one),
/// and writes it to `path`. Resolves once the file is written.
pub async fn take(
    window: &tauri::WebviewWindow,
    width: Option<f64>,
    path: &Path,
    format: Format,
) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel::<Result<(), String>>();
    let target = path.to_path_buf();
    window
        .with_webview(move |webview| {
            // SAFETY: `inner` is the `WKWebView` of this window, and the closure runs on the main thread.
            let view: &WKWebView = unsafe { &*(webview.inner() as *const WKWebView) };
            let Some(main) = MainThreadMarker::new() else {
                let _ = sender.send(Err("Not on the main thread".into()));
                return;
            };
            let configuration = unsafe { WKSnapshotConfiguration::new(main) };
            if let Some(width) = width {
                unsafe { configuration.setSnapshotWidth(Some(&NSNumber::new_f64(width))) };
            }
            let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let outcome = if image.is_null() {
                    let reason = unsafe { error.as_ref() }
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_else(|| "no image".into());
                    Err(format!("The snapshot failed: {reason}"))
                } else {
                    write(unsafe { &*image }, &target, format)
                };
                let _ = sender.send(outcome);
            });
            unsafe { view.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &handler) };
        })
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(15)))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "The snapshot did not finish within 15 s".to_string())?
}

fn write(image: &NSImage, path: &Path, format: Format) -> Result<(), String> {
    let tiff = image.TIFFRepresentation().ok_or("The image has no data")?;
    let representation = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("The image is not a bitmap")?;
    let data = match format {
        Format::Png => {
            let properties: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();
            unsafe { representation.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) }
        }
        Format::Jpeg(quality) => {
            let factor = NSNumber::new_f64(quality);
            let key: &NSString = unsafe { NSImageCompressionFactor };
            let properties: Retained<NSDictionary<NSString, AnyObject>> =
                NSDictionary::from_slices(&[key], &[factor.as_ref() as &AnyObject]);
            unsafe { representation.representationUsingType_properties(NSBitmapImageFileType::JPEG, &properties) }
        }
    }
    .ok_or("The picture could not be encoded")?;
    std::fs::write(path, data.to_vec()).map_err(|error| error.to_string())
}
