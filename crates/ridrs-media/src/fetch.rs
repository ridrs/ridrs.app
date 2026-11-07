// SPDX-License-Identifier: AGPL-3.0-or-later

//! `data.fetch` in Rust: a URL into a file, resumable. The data goes to `<target>.part`, what it
//! was fetched against to `<target>.part.json`. A second fetch of the same URL goes on from the
//! part's end with `Range` and `If-Range`; a source that changed meanwhile answers with all of it,
//! which starts over, as does an ETag other than the expected one. The same rules as
//! `plugins/data-fetch-node`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

/// What a finished fetch got.
#[derive(Debug, Serialize, PartialEq)]
pub struct Fetched {
    pub size: u64,
    pub etag: Option<String>,
}

/// What the part file was fetched against: a resume asks for the same version of the source.
#[derive(Serialize, Deserialize)]
struct PartInfo {
    url: String,
    etag: Option<String>,
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// The total of a `206` from its `Content-Range: bytes a-b/total`.
fn total_of(range: Option<&str>) -> Option<u64> {
    range?.rsplit('/').next()?.parse().ok()
}

/// Fetches `url` into `target`; `progress` gets the bytes so far and, once known, all of them.
/// Fails when `cancel` is set, keeping the part for the next fetch.
pub async fn fetch(
    client: &reqwest::Client,
    target: &Path,
    url: &str,
    expected_etag: Option<&str>,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<Fetched, String> {
    let part = with_suffix(target, ".part");
    let info = with_suffix(target, ".part.json");
    if let Some(directory) = target.parent() {
        tokio::fs::create_dir_all(directory).await.map_err(|e| e.to_string())?;
    }

    let before: Option<PartInfo> = tokio::fs::read(&info)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let resume_etag = before
        .filter(|b| b.url == url && b.etag.is_some() && expected_etag.is_none_or(|e| Some(e) == b.etag.as_deref()))
        .and_then(|b| b.etag);
    let mut offset = match &resume_etag {
        Some(_) => tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0),
        None => 0,
    };

    let mut request = client.get(url);
    if let (true, Some(etag)) = (offset > 0, &resume_etag) {
        request = request
            .header(reqwest::header::RANGE, format!("bytes={offset}-"))
            .header(reqwest::header::IF_RANGE, etag);
    }
    let response = request.send().await.map_err(|e| format!("{url}: {e}"))?;
    let status = response.status().as_u16();
    if status != 200 && status != 206 {
        return Err(format!("{url}: HTTP {status}"));
    }
    if status == 200 {
        offset = 0;
    }
    let header = |name: reqwest::header::HeaderName| {
        response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned)
    };
    let etag = header(reqwest::header::ETAG);
    let size = if status == 206 {
        total_of(header(reqwest::header::CONTENT_RANGE).as_deref())
    } else {
        response.content_length()
    };
    let noted = serde_json::to_vec(&PartInfo { url: url.to_owned(), etag: etag.clone() }).map_err(|e| e.to_string())?;
    tokio::fs::write(&info, noted).await.map_err(|e| e.to_string())?;

    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&part)
        .await
        .map_err(|e| e.to_string())?;
    file.set_len(offset).await.map_err(|e| e.to_string())?;
    file.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;
    let mut received = offset;
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        if cancel.load(Ordering::Relaxed) {
            file.flush().await.map_err(|e| e.to_string())?;
            return Err(format!("{url}: cancelled"));
        }
        let chunk = chunk.map_err(|e| format!("{url}: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        progress(received, size);
    }
    file.flush().await.map_err(|e| e.to_string())?;
    file.sync_all().await.map_err(|e| e.to_string())?;
    drop(file);
    if let Some(size) = size {
        if received != size {
            return Err(format!("{url}: {received} of {size} bytes"));
        }
    }
    tokio::fs::rename(&part, target).await.map_err(|e| e.to_string())?;
    let _ = tokio::fs::remove_file(&info).await;
    Ok(Fetched { size: received, etag })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// A source like nginx: ranges, an ETag, `If-Range`; it can close the connection after
    /// `cut_after` bytes of the body.
    struct Source {
        bytes: Vec<u8>,
        etag: String,
        cut_after: usize,
        requests: Vec<(Option<String>, Option<String>)>,
    }

    fn serve(source: Arc<Mutex<Source>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = stream.read(&mut buffer).unwrap();
                    request.extend_from_slice(&buffer[..n]);
                }
                let text = String::from_utf8_lossy(&request).to_lowercase();
                let header = |name: &str| {
                    text.lines()
                        .find_map(|l| l.strip_prefix(&format!("{name}: ")).map(|v| v.trim().to_owned()))
                };
                let (range, if_range) = (header("range"), header("if-range"));
                let mut source = source.lock().unwrap();
                source.requests.push((range.clone(), if_range.clone()));
                let from = match (&range, &if_range) {
                    (Some(r), i) if i.is_none() || i.as_deref() == Some(source.etag.as_str()) => {
                        r.trim_start_matches("bytes=").trim_end_matches('-').parse().unwrap()
                    }
                    _ => 0,
                };
                let body = &source.bytes[from..];
                let head = if from > 0 {
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nETag: {}\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                        source.etag, body.len(), from, source.bytes.len() - 1, source.bytes.len()
                    )
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\nETag: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        source.etag,
                        body.len()
                    )
                };
                stream.write_all(head.as_bytes()).unwrap();
                let _ = stream.write_all(&body[..body.len().min(source.cut_after)]);
            }
        });
        format!("http://{address}/route.zip")
    }

    fn source(bytes: Vec<u8>) -> Arc<Mutex<Source>> {
        Arc::new(Mutex::new(Source { bytes, etag: "\"v1\"".into(), cut_after: usize::MAX, requests: vec![] }))
    }

    fn bytes(seed: u8) -> Vec<u8> {
        (0..200_000u32).map(|i| (i % 251) as u8 ^ seed).collect()
    }

    #[tokio::test]
    async fn fetches_a_file_and_reports_progress() {
        let dir = tempfile::tempdir().unwrap();
        let src = source(bytes(0));
        let url = serve(src.clone());
        let target = dir.path().join("a/whole.zip");
        let mut last = 0;
        let got = fetch(&reqwest::Client::new(), &target, &url, None, &AtomicBool::new(false), |r, _| last = r)
            .await
            .unwrap();
        assert_eq!(got, Fetched { size: 200_000, etag: Some("\"v1\"".into()) });
        assert_eq!(last, 200_000);
        assert_eq!(std::fs::read(&target).unwrap(), bytes(0));
        assert!(!with_suffix(&target, ".part").exists());
    }

    #[tokio::test]
    async fn goes_on_where_an_interrupted_download_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let src = source(bytes(0));
        let url = serve(src.clone());
        let target = dir.path().join("resumed.zip");
        src.lock().unwrap().cut_after = 60_000;
        let client = reqwest::Client::new();
        assert!(fetch(&client, &target, &url, None, &AtomicBool::new(false), |_, _| {}).await.is_err());
        src.lock().unwrap().cut_after = usize::MAX;
        fetch(&client, &target, &url, None, &AtomicBool::new(false), |_, _| {}).await.unwrap();
        let (range, if_range) = src.lock().unwrap().requests.last().cloned().unwrap();
        assert!(range.unwrap().starts_with("bytes="));
        assert_eq!(if_range.as_deref(), Some("\"v1\""));
        assert_eq!(std::fs::read(&target).unwrap(), bytes(0));
    }

    #[tokio::test]
    async fn starts_over_when_the_source_changed() {
        let dir = tempfile::tempdir().unwrap();
        let src = source(bytes(0));
        let url = serve(src.clone());
        let target = dir.path().join("changed.zip");
        src.lock().unwrap().cut_after = 60_000;
        let client = reqwest::Client::new();
        assert!(fetch(&client, &target, &url, None, &AtomicBool::new(false), |_, _| {}).await.is_err());
        {
            let mut s = src.lock().unwrap();
            s.cut_after = usize::MAX;
            s.etag = "\"v2\"".into();
            s.bytes = bytes(7);
        }
        fetch(&client, &target, &url, None, &AtomicBool::new(false), |_, _| {}).await.unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), bytes(7));
    }

    #[tokio::test]
    async fn stops_when_cancelled_and_keeps_the_part() {
        let dir = tempfile::tempdir().unwrap();
        let url = serve(source(bytes(0)));
        let target = dir.path().join("cancelled.zip");
        let error = fetch(&reqwest::Client::new(), &target, &url, None, &AtomicBool::new(true), |_, _| {})
            .await
            .unwrap_err();
        assert!(error.ends_with("cancelled"), "{error}");
        assert!(with_suffix(&target, ".part.json").exists());
    }
}
