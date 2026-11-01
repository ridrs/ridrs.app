// SPDX-License-Identifier: AGPL-3.0-or-later

//! Native BLE surface behind `ble.central` (plugins/transport-ble-tauri): scan, connect,
//! subscribe, disconnect, connection-lost.
//!
//! Platform backends come from `tauri-plugin-blec` (btleplug on Windows/macOS/iOS, its own Kotlin
//! backend on Android). This module only adds what the ridrs `BleCentral` needs and blec's own
//! JS commands lack: a service-UUID scan filter, a Rust-side receive timestamp per notification,
//! and binary (not JSON number array) notification frames. It never interprets payloads.

use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri_plugin_blec::models::{BleDevice, ScanFilter};
use tauri_plugin_blec::{get_handler, OnDisconnectHandler};
use uuid::Uuid;

/// Header in front of every notification frame: u64 monotonic µs (LE) + f64 wall-clock ms (LE).
pub const FRAME_HEADER_BYTES: usize = 16;

/// Scan duration per `ble_scan` call. The TS side stops earlier through `ble_stop_scan`.
const SCAN_TIMEOUT_MS: u64 = 120_000;

/// Called first thing in `run()`, so monotonic times count from process start.
pub fn process_start() -> Instant {
    static START: OnceLock<Instant> = OnceLock::new();
    *START.get_or_init(Instant::now)
}

fn monotonic_micros() -> u64 {
    process_start().elapsed().as_micros() as u64
}

fn wall_clock_millis() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Prepends the receive timestamps to the notification payload.
pub fn encode_frame(monotonic_us: u64, wall_ms: f64, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(&monotonic_us.to_le_bytes());
    frame.extend_from_slice(&wall_ms.to_le_bytes());
    frame.extend_from_slice(payload);
    frame
}

/// Accepts 16-bit short forms ("1826", "0x1826") and full 128-bit UUIDs.
pub fn parse_uuid(raw: &str) -> Result<Uuid, String> {
    let cleaned = raw.trim().to_ascii_lowercase();
    let cleaned = cleaned.strip_prefix("0x").unwrap_or(&cleaned);
    let full = if cleaned.len() <= 4 && cleaned.chars().all(|c| c.is_ascii_hexdigit()) {
        format!("0000{cleaned:0>4}-0000-1000-8000-00805f9b34fb")
    } else {
        cleaned.to_string()
    };
    Uuid::parse_str(&full).map_err(|e| format!("invalid UUID {raw:?}: {e}"))
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEvent {
    peripheral_id: String,
    name: String,
    service_uuids: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLostEvent {
    peripheral_id: String,
    monotonic_us: u64,
    wall_ms: f64,
}

#[tauri::command]
pub async fn ble_check_permissions(ask_if_denied: bool) -> Result<bool, String> {
    tauri_plugin_blec::check_permissions(ask_if_denied)
        .await
        .map_err(err)
}

/// "On" / "Off" / "Unknown" as blec reports it; a scan itself gives no error without an adapter.
#[tauri::command]
pub async fn ble_adapter_state() -> Result<String, String> {
    let state = get_handler().map_err(err)?.get_adapter_state().await;
    Ok(format!("{state:?}"))
}

#[tauri::command]
pub async fn ble_scan(service_uuids: Vec<String>, on_event: Channel<ScanEvent>) -> Result<(), String> {
    let handler = get_handler().map_err(err)?;
    let services = service_uuids
        .iter()
        .map(|s| parse_uuid(s))
        .collect::<Result<Vec<_>, _>>()?;
    let filter = if services.is_empty() {
        ScanFilter::None
    } else {
        ScanFilter::AnyService(services)
    };
    // blec polls the adapter every 200 ms and sends the full list of matching devices each time.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<BleDevice>>(16);
    // Keep draining until blec closes the sender: blec's scan task panics (`expect`) when the
    // receiver is dropped early, which would leave its scanning state stale.
    tauri::async_runtime::spawn(async move {
        while let Some(devices) = rx.recv().await {
            for device in devices {
                let _ = on_event.send(ScanEvent {
                    peripheral_id: device.address,
                    name: device.name,
                    service_uuids: device.services.iter().map(Uuid::to_string).collect(),
                });
            }
        }
    });
    handler
        .discover(Some(tx), SCAN_TIMEOUT_MS, filter, false)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn ble_stop_scan() -> Result<(), String> {
    get_handler().map_err(err)?.stop_scan().await.map_err(err)
}

#[tauri::command]
pub async fn ble_connect(
    peripheral_id: String,
    on_connection_lost: Channel<ConnectionLostEvent>,
) -> Result<(), String> {
    let handler = get_handler().map_err(err)?;
    let id = peripheral_id.clone();
    let on_disconnect = OnDisconnectHandler::from_sync(move || {
        let _ = on_connection_lost.send(ConnectionLostEvent {
            peripheral_id: id,
            monotonic_us: monotonic_micros(),
            wall_ms: wall_clock_millis(),
        });
    });
    handler
        .connect(&peripheral_id, on_disconnect, false)
        .await
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
pub async fn ble_disconnect(peripheral_id: String) -> Result<(), String> {
    get_handler()
        .map_err(err)?
        .disconnect_device(&peripheral_id)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn ble_subscribe(
    peripheral_id: String,
    service_uuid: String,
    characteristic_uuid: String,
    on_notification: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let handler = get_handler().map_err(err)?;
    let service = parse_uuid(&service_uuid)?;
    let characteristic = parse_uuid(&characteristic_uuid)?;
    let callback = move |payload: Vec<u8>| {
        let frame = encode_frame(monotonic_micros(), wall_clock_millis(), &payload);
        // Raw bodies reach JS as an ArrayBuffer instead of a JSON number array.
        let _ = on_notification.send(InvokeResponseBody::Raw(frame));
    };
    handler
        .subscribe_to(&peripheral_id, characteristic, Some(service), callback)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn ble_unsubscribe(
    peripheral_id: String,
    service_uuid: String,
    characteristic_uuid: String,
) -> Result<(), String> {
    let handler = get_handler().map_err(err)?;
    handler
        .unsubscribe_from(
            &peripheral_id,
            parse_uuid(&characteristic_uuid)?,
            Some(parse_uuid(&service_uuid)?),
        )
        .await
        .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_uuids_expand_to_the_bluetooth_base_uuid() {
        assert_eq!(
            parse_uuid("1826").unwrap().to_string(),
            "00001826-0000-1000-8000-00805f9b34fb"
        );
        assert_eq!(
            parse_uuid("0x2AD2").unwrap().to_string(),
            "00002ad2-0000-1000-8000-00805f9b34fb"
        );
        assert_eq!(
            parse_uuid("00000002-19CA-4651-86E5-FA29DCDD09D1").unwrap().to_string(),
            "00000002-19ca-4651-86e5-fa29dcdd09d1"
        );
        assert!(parse_uuid("not-a-uuid").is_err());
    }

    #[test]
    fn frames_carry_both_timestamps_in_front_of_the_payload() {
        let frame = encode_frame(42, 1_700_000_000_123.5, &[0x44, 0x02]);
        assert_eq!(frame.len(), FRAME_HEADER_BYTES + 2);
        assert_eq!(u64::from_le_bytes(frame[0..8].try_into().unwrap()), 42);
        assert_eq!(
            f64::from_le_bytes(frame[8..16].try_into().unwrap()),
            1_700_000_000_123.5
        );
        assert_eq!(&frame[16..], &[0x44, 0x02]);
    }
}
