// SPDX-License-Identifier: AGPL-3.0-or-later

//! ridrs side: browses for companions over mDNS and holds WebSocket connections to them.

use std::collections::{BTreeMap, HashMap};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::{client_event, is_lan_ipv4, SERVICE_TYPE, TAG_BINARY, TAG_CLOSED, TAG_TEXT};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionAdvert {
    companion_id: String,
    name: String,
    address: String,
}

#[derive(Default)]
pub struct ClientState {
    browser: Mutex<Option<ServiceDaemon>>,
    sockets: Mutex<HashMap<u32, mpsc::UnboundedSender<String>>>,
    next_id: AtomicU32,
}

/// Reports the full list of reachable companions on every change.
#[tauri::command]
pub fn bridge_browse(
    state: State<'_, ClientState>,
    on_event: Channel<Vec<CompanionAdvert>>,
) -> Result<(), String> {
    if let Some(old) = state.browser.lock().unwrap().take() {
        let _ = old.shutdown();
    }
    let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let receiver = daemon.browse(SERVICE_TYPE).map_err(|e| e.to_string())?;
    eprintln!("ridrs-bridge: browsing for {SERVICE_TYPE}");
    *state.browser.lock().unwrap() = Some(daemon);
    std::thread::spawn(move || {
        let mut found: BTreeMap<String, CompanionAdvert> = BTreeMap::new();
        let _ = on_event.send(Vec::new());
        while let Ok(event) = receiver.recv() {
            match event {
                ServiceEvent::ServiceResolved(info) => {
                    // mDNS also reports loopback for a service on this machine (spike finding).
                    let mut lan: Vec<_> = info
                        .get_addresses()
                        .iter()
                        .filter_map(|a| match a.to_ip_addr() {
                            IpAddr::V4(v4) if is_lan_ipv4(&v4) => Some(v4),
                            _ => None,
                        })
                        .collect();
                    lan.sort();
                    let Some(ip) = lan.first() else {
                        eprintln!("ridrs-bridge: {} has no LAN address, ignored", info.fullname);
                        continue;
                    };
                    eprintln!("ridrs-bridge: found {} at {ip}:{}", info.fullname, info.port);
                    let name = info
                        .get_property_val_str("name")
                        .map(str::to_string)
                        .unwrap_or_else(|| info.fullname.clone());
                    found.insert(
                        info.fullname.clone(),
                        CompanionAdvert {
                            companion_id: info.get_property_val_str("id").unwrap_or_default().to_string(),
                            name,
                            address: format!("{ip}:{}", info.port),
                        },
                    );
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    eprintln!("ridrs-bridge: lost {fullname}");
                    if found.remove(&fullname).is_none() {
                        continue;
                    }
                }
                ServiceEvent::SearchStopped(_) => break,
                _ => continue,
            }
            if on_event.send(found.values().cloned().collect()).is_err() {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn bridge_stop_browse(state: State<'_, ClientState>) {
    if let Some(daemon) = state.browser.lock().unwrap().take() {
        let _ = daemon.shutdown();
    }
}

/// Connects to `host:port`; resolves with a socket id once the WebSocket handshake is done.
#[tauri::command]
pub async fn bridge_open(
    state: State<'_, ClientState>,
    address: String,
    on_message: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let url = format!("ws://{address}");
    // Without a limit a connect into a silent network hangs for about 75 s (macOS), and ridrs
    // would show "connecting" all that time.
    let (ws, _) = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(url.as_str()))
        .await
        .map_err(|_| format!("{address}: connect timed out"))?
        .map_err(|e| format!("{address}: {e}"))?;
    if let tokio_tungstenite::MaybeTlsStream::Plain(stream) = ws.get_ref() {
        let _ = stream.set_nodelay(true);
    }
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state.sockets.lock().unwrap().insert(id, tx);
    let emit = move |tag: u8, body: &[u8]| {
        let _ = on_message.send(InvokeResponseBody::Raw(client_event(tag, body)));
    };
    tauri::async_runtime::spawn(async move {
        let reason = loop {
            tokio::select! {
                outgoing = rx.recv() => match outgoing {
                    Some(text) => {
                        if let Err(e) = sink.send(Message::Text(text.into())).await {
                            break format!("send: {e}");
                        }
                    }
                    None => {
                        let _ = sink.close().await;
                        break "closed by ridrs".to_string();
                    }
                },
                incoming = source.next() => match incoming {
                    None | Some(Ok(Message::Close(_))) => break "closed by companion".to_string(),
                    Some(Err(e)) => break format!("receive: {e}"),
                    Some(Ok(Message::Text(text))) => emit(TAG_TEXT, text.as_bytes()),
                    Some(Ok(Message::Binary(bytes))) => emit(TAG_BINARY, &bytes),
                    Some(Ok(_)) => {}
                },
            }
        };
        emit(TAG_CLOSED, reason.as_bytes());
    });
    Ok(id)
}

#[tauri::command]
pub fn bridge_send_text(
    state: State<'_, ClientState>,
    socket_id: u32,
    text: String,
) -> Result<(), String> {
    let sockets = state.sockets.lock().unwrap();
    let socket = sockets.get(&socket_id).ok_or("unknown socket")?;
    socket.send(text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bridge_close(state: State<'_, ClientState>, socket_id: u32) {
    // Dropping the sender ends the write loop, which closes the connection.
    state.sockets.lock().unwrap().remove(&socket_id);
}
