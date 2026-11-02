// SPDX-License-Identifier: AGPL-3.0-or-later

//! Companion side: a WebSocket listener on a free port, announced over mDNS. Each accepted
//! socket gets an id; its messages go to the WebView, and the WebView answers per socket id.
//! The WebView owns the lifecycle: a page reload does not stop this server (spike finding), so
//! the page calls `bridge_unserve` (or `bridge_serve` again, which replaces the old server).

use std::collections::HashMap;
use std::time::Duration;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

use crate::{lan_ipv4, server_event, SERVICE_TYPE, TAG_BINARY, TAG_CLOSED, TAG_OPENED, TAG_TEXT};

type Sockets = Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<Message>>>>;

struct Running {
    daemon: ServiceDaemon,
    fullname: String,
    stop: watch::Sender<bool>,
    sockets: Sockets,
}

#[derive(Default)]
pub struct ServerState(Mutex<Option<Running>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServeInfo {
    port: u16,
    addresses: Vec<String>,
}

fn stop_running(state: &ServerState) {
    if let Some(running) = state.0.lock().unwrap().take() {
        let _ = running.stop.send(true);
        let _ = running.daemon.unregister(&running.fullname);
        let _ = running.daemon.shutdown();
        running.sockets.lock().unwrap().clear();
    }
}

/// What the companion announces over mDNS.
struct Advert {
    name: String,
    host_name: String,
    properties: HashMap<String, String>,
    port: u16,
}

impl Advert {
    fn fullname(&self) -> Result<String, String> {
        ServiceInfo::new(SERVICE_TYPE, &self.name, &self.host_name, "", self.port, None)
            .map(|s| s.get_fullname().to_string())
            .map_err(|e| e.to_string())
    }

    /// Registers (or re-registers) the service with these addresses; returns its full name.
    fn register(&self, daemon: &ServiceDaemon, ips: &[String]) -> Result<String, String> {
        let mut properties = self.properties.clone();
        properties.insert("name".to_string(), self.name.clone());
        // Explicit LAN addresses only: the automatic list would include mobile-data CLAT addresses.
        let service = ServiceInfo::new(
            SERVICE_TYPE,
            &self.name,
            &self.host_name,
            ips.join(","),
            self.port,
            properties,
        )
        .map_err(|e| e.to_string())?;
        let fullname = service.get_fullname().to_string();
        daemon.register(service).map_err(|e| e.to_string())?;
        Ok(fullname)
    }
}

/// How often the companion checks whether the phone's LAN addresses changed.
const ADDRESS_CHECK: Duration = Duration::from_secs(5);

/// Re-announces when the phone gets another address (Wi-Fi switch, new DHCP lease), so ridrs
/// finds the paired companion by its id again without a restart of the companion.
async fn follow_addresses(
    daemon: ServiceDaemon,
    advert: Advert,
    mut announced: Vec<String>,
    mut stop: watch::Receiver<bool>,
) {
    let mut ticker = tokio::time::interval(ADDRESS_CHECK);
    loop {
        tokio::select! {
            _ = stop.changed() => return,
            _ = ticker.tick() => {
                let current: Vec<String> = lan_ipv4().iter().map(ToString::to_string).collect();
                if current != announced && !current.is_empty() {
                    eprintln!("ridrs-bridge: addresses changed to {current:?}, announcing again");
                    // A goodbye first, so browsers drop the cached old address instead of
                    // keeping it next to the new one until its TTL runs out.
                    if let Ok(fullname) = advert.fullname() {
                        let _ = daemon.unregister(&fullname);
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                    if advert.register(&daemon, &current).is_ok() {
                        announced = current;
                    }
                }
            }
        }
    }
}

/// Starts listening and announcing; replaces a server started earlier (e.g. before a reload).
/// Listens on `port` when it is free, so an address ridrs stored stays valid where mDNS does not
/// reach (emulators, filtered networks); otherwise on any free port.
#[tauri::command]
pub async fn bridge_serve(
    state: State<'_, ServerState>,
    name: String,
    companion_id: String,
    protocol: String,
    port: u16,
    on_event: Channel<InvokeResponseBody>,
) -> Result<ServeInfo, String> {
    stop_running(&state);
    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(listener) => listener,
        Err(_) => TcpListener::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?,
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let addresses = lan_ipv4();

    let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let advert = Advert {
        name,
        host_name: format!("ridrs-companion-{companion_id}.local."),
        properties: HashMap::from([
            ("protocol".to_string(), protocol),
            ("id".to_string(), companion_id),
        ]),
        port,
    };
    let ips: Vec<String> = addresses.iter().map(ToString::to_string).collect();
    let fullname = advert.register(&daemon, &ips)?;

    let (stop_tx, stop_rx) = watch::channel(false);
    let sockets: Sockets = Arc::default();
    tauri::async_runtime::spawn(accept_loop(listener, on_event, stop_rx.clone(), sockets.clone()));
    tauri::async_runtime::spawn(follow_addresses(daemon.clone(), advert, ips.clone(), stop_rx));
    *state.0.lock().unwrap() = Some(Running {
        daemon,
        fullname,
        stop: stop_tx,
        sockets,
    });
    Ok(ServeInfo {
        port,
        addresses: ips,
    })
}

#[tauri::command]
pub fn bridge_unserve(state: State<'_, ServerState>) {
    stop_running(&state);
}

fn send_to(state: &ServerState, socket_id: u32, message: Message) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    let running = guard.as_ref().ok_or("the bridge server is not running")?;
    let sockets = running.sockets.lock().unwrap();
    let socket = sockets.get(&socket_id).ok_or("unknown socket")?;
    socket.send(message).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bridge_server_send_text(
    state: State<'_, ServerState>,
    socket_id: u32,
    text: String,
) -> Result<(), String> {
    send_to(&state, socket_id, Message::Text(text.into()))
}

/// Binary frames as a byte array argument. A raw request body would avoid the JSON number array,
/// but Android's IPC does not deliver raw bodies; BLE notifications are a few bytes anyway.
#[tauri::command]
pub fn bridge_server_send_binary(
    state: State<'_, ServerState>,
    socket_id: u32,
    data: Vec<u8>,
) -> Result<(), String> {
    send_to(&state, socket_id, Message::Binary(data.into()))
}

#[tauri::command]
pub fn bridge_server_close(state: State<'_, ServerState>, socket_id: u32) {
    if let Some(running) = state.0.lock().unwrap().as_ref() {
        // Dropping the sender ends the socket's write loop, which closes the connection.
        running.sockets.lock().unwrap().remove(&socket_id);
    }
}

async fn accept_loop(
    listener: TcpListener,
    on_event: Channel<InvokeResponseBody>,
    mut stop: watch::Receiver<bool>,
    sockets: Sockets,
) {
    let next_id = AtomicU32::new(1);
    loop {
        tokio::select! {
            _ = stop.changed() => return,
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { continue };
                let _ = stream.set_nodelay(true);
                let id = next_id.fetch_add(1, Ordering::Relaxed);
                tauri::async_runtime::spawn(serve_socket(
                    stream,
                    id,
                    peer.to_string(),
                    on_event.clone(),
                    stop.clone(),
                    sockets.clone(),
                ));
            }
        }
    }
}

async fn serve_socket(
    stream: TcpStream,
    id: u32,
    peer: String,
    on_event: Channel<InvokeResponseBody>,
    mut stop: watch::Receiver<bool>,
    sockets: Sockets,
) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    sockets.lock().unwrap().insert(id, tx);
    let emit = |tag: u8, body: &[u8]| {
        let _ = on_event.send(InvokeResponseBody::Raw(server_event(tag, id, body)));
    };
    emit(TAG_OPENED, peer.as_bytes());
    let reason = loop {
        tokio::select! {
            _ = stop.changed() => break "companion stopped".to_string(),
            outgoing = rx.recv() => match outgoing {
                Some(message) => {
                    if let Err(e) = sink.send(message).await {
                        break format!("send: {e}");
                    }
                }
                None => {
                    let _ = sink.close().await;
                    break "closed by companion".to_string();
                }
            },
            incoming = source.next() => match incoming {
                None | Some(Ok(Message::Close(_))) => break "closed by ridrs".to_string(),
                Some(Err(e)) => break format!("receive: {e}"),
                Some(Ok(Message::Text(text))) => emit(TAG_TEXT, text.as_bytes()),
                Some(Ok(Message::Binary(bytes))) => emit(TAG_BINARY, &bytes),
                Some(Ok(_)) => {}
            },
        }
    };
    sockets.lock().unwrap().remove(&id);
    emit(TAG_CLOSED, reason.as_bytes());
}
