// SPDX-License-Identifier: AGPL-3.0-or-later

//! The `ridrs-media://` scheme: the media storage's files for the WebView, by range (ADR 0067), and
//! the entries of a video route's package `route.ride` as if they were files of its folder
//! (ADR 0094): a stored entry by range straight from the package, a compressed one whole.
//! The URL's path is the media path, percent-encoded (`convertFileSrc(path, 'ridrs-media')`), never
//! a path of the device. Every answer allows any origin of the app's WebView, a 416 and the CORS
//! preflight included, and a range answer is cut at `MAX_RANGE`: the reader asks for the rest.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use tauri::http::{header, Method, Request, Response, StatusCode};

use crate::paths::resolve;
use crate::ride::{self, Place, PACKAGE};

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
    match path.rsplit('.').next().map(str::to_ascii_lowercase).as_deref() {
        // A route's video comes in any container its control file names (ADR 0101).
        Some("mp4") => "video/mp4",
        Some("m4v") => "video/x-m4v",
        Some("mov") => "video/quicktime",
        Some("mkv") => "video/x-matroska",
        Some("webm") => "video/webm",
        Some("json") => "application/json",
        Some("gpx") => "application/gpx+xml",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
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
    let mut source = match source(root, &path) {
        Ok(source) => source,
        Err(status) => return empty(status),
    };
    let len = source.len();
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
    match source.read(start, length) {
        Ok(body) => builder.body(body).expect("a valid response"),
        Err(_) => empty(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Where the bytes of a media path lie: `len` bytes of a file from `base` (a file, or a stored
/// entry of a route's package), or a compressed entry's bytes.
enum Source {
    File { file: File, base: u64, len: u64 },
    Bytes(Vec<u8>),
}

impl Source {
    fn len(&self) -> u64 {
        match self {
            Source::File { len, .. } => *len,
            Source::Bytes(bytes) => bytes.len() as u64,
        }
    }

    fn read(&mut self, start: u64, length: u64) -> std::io::Result<Vec<u8>> {
        match self {
            Source::File { file, base, .. } => {
                let mut body = vec![0; length as usize];
                file.seek(SeekFrom::Start(*base + start))?;
                file.read_exact(&mut body)?;
                Ok(body)
            }
            Source::Bytes(bytes) => Ok(bytes[start as usize..(start + length) as usize].to_vec()),
        }
    }
}

/// The file of `path`, or else the entry of the package in the nearest folder above it that has one.
fn source(root: &Path, path: &str) -> Result<Source, StatusCode> {
    let file_path = resolve(root, path).map_err(|_| StatusCode::FORBIDDEN)?;
    if file_path.is_file() {
        let file = File::open(&file_path).map_err(|_| StatusCode::NOT_FOUND)?;
        let len = file.metadata().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.len();
        return Ok(Source::File { file, base: 0, len });
    }
    let Some((folder, name)) = ride::package_entry(root, path).map_err(|_| StatusCode::FORBIDDEN)? else {
        return Err(StatusCode::NOT_FOUND);
    };
    let package = resolve(root, &format!("{folder}/{PACKAGE}")).map_err(|_| StatusCode::FORBIDDEN)?;
    let entry = ride::entry(root, &folder, &name)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let open = |file: &Path| File::open(file).map_err(|_| StatusCode::NOT_FOUND);
    match entry.place {
        Place::File(file) => Ok(Source::File { file: open(&file)?, base: 0, len: entry.size }),
        Place::Stored { offset } => Ok(Source::File { file: open(&package)?, base: offset, len: entry.size }),
        // A compressed entry cannot be read by range: only small ones, whole.
        Place::Packed { .. } if entry.size > MAX_WHOLE => Err(StatusCode::PAYLOAD_TOO_LARGE),
        Place::Packed { .. } => ride::read(root, &folder, &name, MAX_WHOLE)
            .map(Source::Bytes)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// `%XX` escapes as bytes, the result as UTF-8; `None` for a broken escape or invalid UTF-8.
pub fn percent_decode(text: &str) -> Option<String> {
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
    fn sends_a_route_picture_as_an_image() {
        assert_eq!(content_type("videos/a/thumbnail.jpg"), "image/jpeg");
        assert_eq!(content_type("videos/a/thumbnail.png"), "image/png");
    }

    /// A route's folder `videos/r` with a package of a stored video and a compressed control file.
    fn route() -> tempfile::TempDir {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let root = media();
        std::fs::create_dir_all(root.path().join("videos/r")).unwrap();
        let mut zip = zip::ZipWriter::new(File::create(root.path().join("videos/r/route.ride")).unwrap());
        let deflated = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("Col.xml", deflated).unwrap();
        zip.write_all(b"<gpx-import/>").unwrap();
        let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("Col.mp4", stored).unwrap();
        zip.write_all(&(0..100u8).collect::<Vec<_>>()).unwrap();
        zip.finish().unwrap();
        root
    }

    #[test]
    fn answers_a_range_of_a_stored_entry_of_a_route_package() {
        let root = route();
        let response = respond(root.path(), &request(Method::GET, "videos%2Fr%2FCol.mp4", Some("bytes=10-19")));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 10-19/100");
        assert_eq!(response.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(response.body(), &(10..20u8).collect::<Vec<_>>());
    }

    #[test]
    fn sends_a_compressed_entry_whole_and_a_file_beside_the_package_instead_of_its_entry() {
        let root = route();
        let get = |path: &str| respond(root.path(), &request(Method::GET, path, None));
        assert_eq!(get("videos%2Fr%2FCol.xml").body(), b"<gpx-import/>");
        std::fs::write(root.path().join("videos/r/col.xml"), "a better control file").unwrap();
        assert_eq!(get("videos%2Fr%2FCol.xml").body(), b"a better control file");
        assert_eq!(get("videos%2Fr%2FCol.gpx").status(), StatusCode::NOT_FOUND);
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

    #[test]
    fn names_the_type_of_every_video_container_whatever_the_case() {
        assert_eq!(content_type("videos/a/Col.MP4"), "video/mp4");
        assert_eq!(content_type("videos/a/Col.mov"), "video/quicktime");
        assert_eq!(content_type("videos/a/Col.m4v"), "video/x-m4v");
        assert_eq!(content_type("videos/a/Col.mkv"), "video/x-matroska");
        assert_eq!(content_type("videos/a/Col.WebM"), "video/webm");
        assert_eq!(content_type("videos/a/Col.xml"), "application/octet-stream");
    }
}
