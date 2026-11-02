// SPDX-License-Identifier: AGPL-3.0-or-later

//! Companion role: a WebSocket listener on a free port, advertised over mDNS as
//! `_ridrs-bridge._tcp`. Each client gets synthetic FTMS notification frames at a rate it picks
//! (`rate:<hz>`) and answers to `ping:<t>` with `pong:<t>:<companion wall ms>`. There is no BLE
//! here: the spike only questions the network path.

use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;

use crate::clock::{monotonic_micros, wall_clock_millis};

pub const SERVICE_TYPE: &str = "_ridrs-bridge._tcp.local.";
/// u32 LE sequence + u64 LE monotonic µs + f64 LE wall ms, then the payload.
pub const FRAME_HEADER_BYTES: usize = 20;
/// FTMS Indoor Bike Data: 200 W, 90 rpm (the same packet the Phase 2 scenarios use).
const SAMPLE_PAYLOAD: [u8; 6] = [0x45, 0x00, 0xb4, 0x00, 0xc8, 0x00];

pub fn encode_frame(seq: u32, monotonic_us: u64, wall_ms: f64, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(&seq.to_le_bytes());
    frame.extend_from_slice(&monotonic_us.to_le_bytes());
    frame.extend_from_slice(&wall_ms.to_le_bytes());
    frame.extend_from_slice(payload);
    frame
}

/// Non-loopback IPv4 addresses, for the manual `host:port` fallback shown in the UI.
pub fn lan_ipv4() -> Vec<String> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.ip() {
            IpAddr::V4(v4) if !v4.is_link_local() => Some(v4.to_string()),
            _ => None,
        })
        .collect()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CompanionEvent {
    ClientConnected { peer: String },
    ClientGone { peer: String, reason: String },
    Stats { peer: String, sent: u64, rate_hz: f64 },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionInfo {
    port: u16,
    fullname: String,
    addresses: Vec<String>,
}

struct Running {
    daemon: ServiceDaemon,
    fullname: String,
    stop: watch::Sender<bool>,
}

#[derive(Default)]
pub struct CompanionState(Mutex<Option<Running>>);

#[tauri::command]
pub async fn companion_start(
    state: State<'_, CompanionState>,
    name: String,
    events: Channel<CompanionEvent>,
) -> Result<CompanionInfo, String> {
    stop_running(&state);
    let listener = TcpListener::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let host_name = format!("ridrs-companion-{port}.local.");
    let props = [("protocol", "1"), ("name", name.as_str())];
    let service = ServiceInfo::new(SERVICE_TYPE, &name, &host_name, "", port, &props[..])
        .map_err(|e| e.to_string())?
        .enable_addr_auto();
    let fullname = service.get_fullname().to_string();
    daemon.register(service).map_err(|e| e.to_string())?;

    let (stop_tx, stop_rx) = watch::channel(false);
    tauri::async_runtime::spawn(accept_loop(listener, events, stop_rx));
    *state.0.lock().unwrap() = Some(Running {
        daemon,
        fullname: fullname.clone(),
        stop: stop_tx,
    });
    Ok(CompanionInfo {
        port,
        fullname,
        addresses: lan_ipv4(),
    })
}

#[tauri::command]
pub fn companion_stop(state: State<'_, CompanionState>) {
    stop_running(&state);
}

fn stop_running(state: &CompanionState) {
    if let Some(running) = state.0.lock().unwrap().take() {
        let _ = running.stop.send(true);
        let _ = running.daemon.unregister(&running.fullname);
        let _ = running.daemon.shutdown();
    }
}

async fn accept_loop(
    listener: TcpListener,
    events: Channel<CompanionEvent>,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            _ = stop.changed() => return,
            accepted = listener.accept() => {
                let Ok((stream, addr)) = accepted else { continue };
                let _ = stream.set_nodelay(true);
                tauri::async_runtime::spawn(serve_client(stream, addr.to_string(), events.clone(), stop.clone()));
            }
        }
    }
}

async fn serve_client(
    stream: tokio::net::TcpStream,
    peer: String,
    events: Channel<CompanionEvent>,
    mut stop: watch::Receiver<bool>,
) {
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            let _ = events.send(CompanionEvent::ClientGone { peer, reason: format!("handshake: {e}") });
            return;
        }
    };
    let _ = events.send(CompanionEvent::ClientConnected { peer: peer.clone() });
    let (mut sink, mut source) = ws.split();
    let sent = Arc::new(AtomicU64::new(0));
    let mut rate_hz = 4.0_f64;
    let mut ticker = tokio::time::interval(Duration::from_secs_f64(1.0 / rate_hz));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut stats = tokio::time::interval(Duration::from_secs(1));
    let mut seq: u32 = 0;
    let reason = loop {
        tokio::select! {
            _ = stop.changed() => break "companion stopped".to_string(),
            _ = ticker.tick() => {
                let frame = encode_frame(seq, monotonic_micros(), wall_clock_millis(), &SAMPLE_PAYLOAD);
                seq = seq.wrapping_add(1);
                if let Err(e) = sink.send(Message::Binary(frame.into())).await {
                    break format!("send: {e}");
                }
                sent.fetch_add(1, Ordering::Relaxed);
            }
            _ = stats.tick() => {
                let _ = events.send(CompanionEvent::Stats { peer: peer.clone(), sent: sent.load(Ordering::Relaxed), rate_hz });
            }
            incoming = source.next() => {
                let text = match incoming {
                    None => break "closed by client".to_string(),
                    Some(Err(e)) => break format!("receive: {e}"),
                    Some(Ok(Message::Close(_))) => break "closed by client".to_string(),
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(_)) => continue,
                };
                if let Some(t) = text.strip_prefix("ping:") {
                    let pong = format!("pong:{t}:{}", wall_clock_millis());
                    if let Err(e) = sink.send(Message::Text(pong.into())).await {
                        break format!("send: {e}");
                    }
                } else if let Some(hz) = text.strip_prefix("rate:").and_then(|r| r.parse::<f64>().ok()) {
                    if hz > 0.0 && hz <= 1000.0 {
                        rate_hz = hz;
                        ticker = tokio::time::interval(Duration::from_secs_f64(1.0 / rate_hz));
                        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                    }
                }
            }
        }
    };
    let _ = events.send(CompanionEvent::ClientGone { peer, reason });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_layout() {
        let frame = encode_frame(7, 1_000_000, 1.5, &[0xab]);
        assert_eq!(frame.len(), FRAME_HEADER_BYTES + 1);
        assert_eq!(&frame[0..4], &7u32.to_le_bytes());
        assert_eq!(&frame[4..12], &1_000_000u64.to_le_bytes());
        assert_eq!(&frame[12..20], &1.5f64.to_le_bytes());
        assert_eq!(frame[20], 0xab);
    }
}
