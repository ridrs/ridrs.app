//! Local media server for the video panel.
//!
//! WebKit copies every response of a custom URL scheme (`asset://`) on the app's main thread, so streaming a
//! large video that way freezes the window every few seconds (spinning beach ball). Plain HTTP from
//! 127.0.0.1 is streamed by WebKit's own network process instead. Only files registered with `register`
//! are served, each under a random token; Range requests are supported (needed for seeking).

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::fs::File;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Media {
    port: u16,
    files: Arc<Mutex<HashMap<String, PathBuf>>>,
}

fn token() -> String {
    let mut s = String::new();
    for _ in 0..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        s.push_str(&format!("{:016x}", h.finish()));
    }
    s
}

impl Media {
    pub fn start() -> std::io::Result<Media> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let files: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::new(Mutex::new(HashMap::new()));
        let f2 = files.clone();
        std::thread::Builder::new().name("media-server".into()).spawn(move || {
            for conn in listener.incoming().flatten() {
                let files = f2.clone();
                let _ = std::thread::Builder::new().name("media-conn".into()).spawn(move || {
                    let _ = serve(conn, &files);
                });
            }
        })?;
        Ok(Media { port, files })
    }

    /// Returns the http URL under which `path` is served.
    pub fn register(&self, path: &str) -> Result<String, String> {
        let p = PathBuf::from(path);
        if !p.is_file() {
            return Err(format!("Datei nicht gefunden: {path}"));
        }
        let mut files = self.files.lock().map_err(|e| e.to_string())?;
        let tok = match files.iter().find(|(_, v)| **v == p) {
            Some((k, _)) => k.clone(),
            None => {
                let t = token();
                files.insert(t.clone(), p.clone());
                t
            }
        };
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        Ok(format!("http://127.0.0.1:{}/v/{}/{}", self.port, tok, encode(&name)))
    }
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn content_type(p: &Path) -> &'static str {
    match p.extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        _ => "application/octet-stream",
    }
}

fn respond(s: &mut TcpStream, status: &str, extra: &str) -> std::io::Result<()> {
    write!(s, "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n{extra}\r\n")
}

fn serve(stream: TcpStream, files: &Mutex<HashMap<String, PathBuf>>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;
    let mut out = stream.try_clone()?;
    let mut rd = BufReader::new(stream);
    let mut line = String::new();
    rd.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let mut range: Option<(u64, Option<u64>)> = None;
    loop {
        let mut h = String::new();
        if rd.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        let lower = h.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("range:") {
            if let Some(r) = v.trim().strip_prefix("bytes=") {
                let mut it = r.splitn(2, '-');
                let a = it.next().and_then(|x| x.trim().parse::<u64>().ok());
                let b = it.next().and_then(|x| x.trim().parse::<u64>().ok());
                if let Some(a) = a {
                    range = Some((a, b));
                }
            }
        }
    }
    if method != "GET" && method != "HEAD" {
        return respond(&mut out, "405 Method Not Allowed", "");
    }
    let tok = target.strip_prefix("/v/").and_then(|r| r.split('/').next()).unwrap_or("");
    let path = match files.lock().ok().and_then(|f| f.get(tok).cloned()) {
        Some(p) => p,
        None => return respond(&mut out, "404 Not Found", ""),
    };
    let mut f = File::open(&path)?;
    let len = f.metadata()?.len();
    let ct = content_type(&path);
    let (start, end, status) = match range {
        Some((a, b)) if a < len => (a, b.unwrap_or(len - 1).min(len - 1), "206 Partial Content"),
        Some(_) => return respond(&mut out, "416 Range Not Satisfiable", &format!("Content-Range: bytes */{len}\r\n")),
        None => (0, len.saturating_sub(1), "200 OK"),
    };
    let n = if len == 0 { 0 } else { end - start + 1 };
    let mut head = format!("HTTP/1.1 {status}\r\nContent-Type: {ct}\r\nContent-Length: {n}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n");
    if status.starts_with("206") {
        head.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
    }
    head.push_str("\r\n");
    out.write_all(head.as_bytes())?;
    if method == "HEAD" || n == 0 {
        return Ok(());
    }
    f.seek(SeekFrom::Start(start))?;
    let mut left = n;
    let mut buf = vec![0u8; 256 * 1024];
    while left > 0 {
        let k = (left as usize).min(buf.len());
        let got = f.read(&mut buf[..k])?;
        if got == 0 {
            break;
        }
        // the player closes connections it no longer needs; that ends the loop with an error
        out.write_all(&buf[..got])?;
        left -= got as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(port: u16, path: &str, extra: &str) -> (String, Vec<u8>) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: x\r\n{extra}\r\n").unwrap();
        let mut all = vec![];
        s.read_to_end(&mut all).unwrap();
        let i = all.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (String::from_utf8_lossy(&all[..i]).to_string(), all[i + 4..].to_vec())
    }

    #[test]
    fn range_requests_and_tokens() {
        let dir = std::env::temp_dir().join(format!("v2g_media_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("clip.mp4");
        let data: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&f, &data).unwrap();
        let m = Media::start().unwrap();
        let url = m.register(f.to_str().unwrap()).unwrap();
        let path = &url[url.find("/v/").unwrap()..];
        let (h, b) = get(m.port, path, "Range: bytes=1000-1999\r\n");
        assert!(h.starts_with("HTTP/1.1 206"), "{h}");
        assert!(h.contains("Content-Range: bytes 1000-1999/100000"), "{h}");
        assert_eq!(b, data[1000..2000]);
        let (h, b) = get(m.port, path, "Range: bytes=99990-\r\n");
        assert!(h.starts_with("HTTP/1.1 206"));
        assert_eq!(b, data[99990..]);
        let (h, b) = get(m.port, path, "");
        assert!(h.starts_with("HTTP/1.1 200") && h.contains("video/mp4"));
        assert_eq!(b.len(), 100_000);
        let (h, _) = get(m.port, "/v/wrongtoken/clip.mp4", "");
        assert!(h.starts_with("HTTP/1.1 404"));
        // same file -> same URL
        assert_eq!(m.register(f.to_str().unwrap()).unwrap(), url);
        std::fs::remove_dir_all(&dir).ok();
    }
}
