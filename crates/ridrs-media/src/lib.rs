// SPDX-License-Identifier: AGPL-3.0-or-later

//! Large media for the native app (docs/ideas/video-sources.md): `storage.media`, `data.fetch`
//! and `data.archive` below `media` in the app data directory, and the `ridrs-media://` scheme
//! that serves it to the WebView.

pub mod archive;
pub mod commands;
pub mod fetch;
pub mod files;
pub mod paths;
pub mod protocol;
