// SPDX-License-Identifier: AGPL-3.0-or-later

//! Host role (the ridrs side): mDNS browse for `_ridrs-bridge._tcp`, and an alternative
//! Rust-side WebSocket client (O3 fallback) that forwards everything over one binary IPC channel:
//! byte 0 = 0 for a binary frame, 1 for a text message, 2 for a close reason; then the body.

use std::net::IpAddr;
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::companion::SERVICE_TYPE;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum BrowseEvent {
    Resolved {
        fullname: String,
        name: String,
        host: String,
        port: u16,
        ipv4: Vec<String>,
        protocol: String,
        elapsed_ms: f64,
    },
    Removed {
        fullname: String,
    },
}

#[derive(Default)]
pub struct HostState {
    browser: Mutex<Option<ServiceDaemon>>,
    socket: Mutex<Option<mpsc::UnboundedSender<String>>>,
}

#[tauri::command]
pub fn host_browse(state: State<'_, HostState>, events: Channel<BrowseEvent>) -> Result<(), String> {
    if let Some(old) = state.browser.lock().unwrap().take() {
        let _ = old.shutdown();
    }
    let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let receiver = daemon.browse(SERVICE_TYPE).map_err(|e| e.to_string())?;
    *state.browser.lock().unwrap() = Some(daemon);
    let started = std::time::Instant::now();
    std::thread::spawn(move || {
        while let Ok(event) = receiver.recv() {
            let out = match event {
                ServiceEvent::ServiceResolved(info) => {
                    let mut ipv4: Vec<String> = info
                        .get_addresses()
                        .iter()
                        .filter_map(|a| match a.to_ip_addr() {
                            IpAddr::V4(v4) => Some(v4.to_string()),
                            IpAddr::V6(_) => None,
                        })
                        .collect();
                    ipv4.sort();
                    BrowseEvent::Resolved {
                        fullname: info.fullname.clone(),
                        name: info.get_property_val_str("name").unwrap_or_default().to_string(),
                        host: info.host.clone(),
                        port: info.port,
                        ipv4,
                        protocol: info.get_property_val_str("protocol").unwrap_or_default().to_string(),
                        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
                    }
                }
                ServiceEvent::ServiceRemoved(_, fullname) => BrowseEvent::Removed { fullname },
                ServiceEvent::SearchStopped(_) => break,
                _ => continue,
            };
            if events.send(out).is_err() {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn host_stop_browse(state: State<'_, HostState>) {
    if let Some(daemon) = state.browser.lock().unwrap().take() {
        let _ = daemon.shutdown();
    }
}

fn tagged(tag: u8, body: &[u8]) -> InvokeResponseBody {
    let mut out = Vec::with_capacity(body.len() + 1);
    out.push(tag);
    out.extend_from_slice(body);
    InvokeResponseBody::Raw(out)
}

/// Connects from Rust; resolves once the handshake is done.
#[tauri::command]
pub async fn host_rust_connect(
    state: State<'_, HostState>,
    url: String,
    events: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let (ws, _) = tokio_tungstenite::connect_async(url.as_str()).await.map_err(|e| e.to_string())?;
    if let Ok(stream) = match ws.get_ref() {
        tokio_tungstenite::MaybeTlsStream::Plain(s) => Ok(s),
        _ => Err(()),
    } {
        let _ = stream.set_nodelay(true);
    }
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    *state.socket.lock().unwrap() = Some(tx);
    tauri::async_runtime::spawn(async move {
        let reason = loop {
            tokio::select! {
                outgoing = rx.recv() => match outgoing {
                    Some(text) => if let Err(e) = sink.send(Message::Text(text.into())).await { break format!("send: {e}") },
                    None => { let _ = sink.close().await; break "closed by host".to_string() }
                },
                incoming = source.next() => match incoming {
                    None | Some(Ok(Message::Close(_))) => break "closed by companion".to_string(),
                    Some(Err(e)) => break format!("receive: {e}"),
                    Some(Ok(Message::Binary(b))) => { let _ = events.send(tagged(0, &b)); }
                    Some(Ok(Message::Text(t))) => { let _ = events.send(tagged(1, t.as_bytes())); }
                    Some(Ok(_)) => {}
                },
            }
        };
        let _ = events.send(tagged(2, reason.as_bytes()));
    });
    Ok(())
}

#[tauri::command]
pub fn host_rust_send(state: State<'_, HostState>, text: String) -> Result<(), String> {
    match state.socket.lock().unwrap().as_ref() {
        Some(tx) => tx.send(text).map_err(|e| e.to_string()),
        None => Err("not connected".into()),
    }
}

#[tauri::command]
pub fn host_rust_close(state: State<'_, HostState>) {
    state.socket.lock().unwrap().take();
}
