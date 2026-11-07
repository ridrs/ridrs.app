// SPDX-License-Identifier: AGPL-3.0-or-later

//! The `ridrs-media://` scheme: the media storage's files for the WebView, by range (ADR 0067).
//! The URL's path is the media path, percent-encoded (`convertFileSrc(path, 'ridrs-media')`), never
//! a path of the device. Every answer allows any origin of the app's WebView, a 416 and the CORS
//! preflight included, and a range answer is cut at `MAX_RANGE`: the reader asks for the rest.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use tauri::http::{header, Method, Request, Response, StatusCode};

use crate::paths::resolve;

/// The scheme's name, as registered by the app and named in the CSP.
pub const SCHEME: &str = "ridrs-media";

/// The most bytes one range answer carries: a few seconds of video, and no 11 GB in memory.
pub const MAX_RANGE: u64 = 16 * 1024 * 1024;

/// A file without a range is sent whole only up to this size: `route.json` and the track, not a video.
pub const MAX_WHOLE: u64 = 64 * 1024 * 1024;

fn answer(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "content-range, content-length, accept-ranges")
        .header(header::ACCEPT_RANGES, "bytes")
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    answer(status).body(Vec::new()).expect("a valid response")
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("mp4") => "video/mp4",
        Some("json") => "application/json",
        Some("gpx") => "application/gpx+xml",
        Some("jpg" | "jpeg") => "image/jpeg",
        _ => "application/octet-stream",
    }
}

/// The answer to a request for the media below `root`.
pub fn respond(root: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() == Method::OPTIONS {
        return answer(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "range")
            .body(Vec::new())
            .expect("a valid response");
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    let raw = request.uri().path().trim_start_matches('/');
    let path = match percent_decode(raw) {
        Some(path) => path,
        None => return empty(StatusCode::BAD_REQUEST),
    };
    let Ok(file_path) = resolve(root, &path) else {
        return empty(StatusCode::FORBIDDEN);
    };
    let Ok(mut file) = File::open(&file_path) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let range = request.headers().get(header::RANGE).and_then(|r| r.to_str().ok());
    let (status, start, length) = match range {
        Some(range) => match http_range::HttpRange::parse(range, len).ok().as_deref() {
            Some([one]) => (StatusCode::PARTIAL_CONTENT, one.start, one.length.min(MAX_RANGE)),
            _ => {
                return answer(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                    .body(Vec::new())
                    .expect("a valid response");
            }
        },
        None if len > MAX_WHOLE => return empty(StatusCode::PAYLOAD_TOO_LARGE),
        None => (StatusCode::OK, 0, len),
    };
    let mut builder = answer(status)
        .header(header::CONTENT_TYPE, content_type(&path))
        .header(header::CONTENT_LENGTH, length);
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{}/{len}", start + length - 1));
    }
    if request.method() == Method::HEAD {
        return builder.body(Vec::new()).expect("a valid response");
    }
    let mut body = vec![0; length as usize];
    if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut body)).is_err() {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    }
    builder.body(body).expect("a valid response")
}

/// `%XX` escapes as bytes, the result as UTF-8; `None` for a broken escape or invalid UTF-8.
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: Method, path: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut builder = Request::builder().method(method).uri(format!("ridrs-media://localhost/{path}"));
        if let Some(range) = range {
            builder = builder.header(header::RANGE, range);
        }
        builder.body(Vec::new()).unwrap()
    }

    fn media() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("videos/a")).unwrap();
        std::fs::write(root.path().join("videos/a/video.mp4"), (0..100u8).collect::<Vec<_>>()).unwrap();
        root
    }

    const VIDEO: &str = "videos%2Fa%2Fvideo.mp4";

    #[test]
    fn answers_a_range_with_its_bytes_and_the_total() {
        let root = media();
        let response = respond(root.path(), &request(Method::GET, VIDEO, Some("bytes=10-19")));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 10-19/100");
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(response.body(), &(10..20u8).collect::<Vec<_>>());
    }

    #[test]
    fn a_range_past_the_end_is_416_and_still_readable_across_origins() {
        let root = media();
        let response = respond(root.path(), &request(Method::GET, VIDEO, Some("bytes=100-115")));
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */100");
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    }

    #[test]
    fn answers_the_cors_preflight_of_a_range_request() {
        let root = media();
        let response = respond(root.path(), &request(Method::OPTIONS, VIDEO, None));
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS], "range");
    }

    #[test]
    fn sends_a_small_file_whole() {
        let root = media();
        let response = respond(root.path(), &request(Method::GET, VIDEO, None));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body().len(), 100);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "video/mp4");
    }

    #[test]
    fn refuses_paths_outside_the_media_and_missing_files() {
        let root = media();
        let status = |path: &str| respond(root.path(), &request(Method::GET, path, None)).status();
        assert_eq!(status("..%2Fsecret"), StatusCode::FORBIDDEN);
        assert_eq!(status("%2FUsers%2Fx"), StatusCode::FORBIDDEN);
        assert_eq!(status("videos%2Fmissing.mp4"), StatusCode::NOT_FOUND);
        assert_eq!(status("bad%zz"), StatusCode::BAD_REQUEST);
    }
}
