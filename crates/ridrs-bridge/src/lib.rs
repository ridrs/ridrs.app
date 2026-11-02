// SPDX-License-Identifier: AGPL-3.0-or-later

//! The network half of the ridrs companion bridge, as Tauri commands. Both halves only move
//! message-framed bytes; the protocol (pairing, GATT forwarding) lives in TypeScript
//! (`packages/ble-bridge`) and is the same on every platform.
//!
//! - [`server`]: the companion. A WebSocket listener announced over mDNS as `_ridrs-bridge._tcp`.
//! - [`client`]: ridrs. mDNS browsing and WebSocket clients. The socket lives in Rust because
//!   Android release builds forbid cleartext `ws://` from the WebView (spike finding).
//!
//! Both forward to the WebView over one binary IPC channel. Every event starts with a tag byte.

use std::net::{IpAddr, Ipv4Addr};

pub mod client;
pub mod server;

pub const SERVICE_TYPE: &str = "_ridrs-bridge._tcp.local.";

pub const TAG_OPENED: u8 = 0;
pub const TAG_TEXT: u8 = 1;
pub const TAG_BINARY: u8 = 2;
pub const TAG_CLOSED: u8 = 3;

/// CLAT (464XLAT) addresses on mobile data: never reachable from the LAN (spike finding).
fn is_clat(ip: &Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    a == 192 && b == 0 && c == 0
}

/// Whether ridrs can reach a companion at this address from the local network.
pub fn is_lan_ipv4(ip: &Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() && !is_clat(ip)
}

/// This device's LAN IPv4 addresses, sorted.
pub fn lan_ipv4() -> Vec<Ipv4Addr> {
    let mut addresses: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            IpAddr::V4(v4) if is_lan_ipv4(&v4) => Some(v4),
            _ => None,
        })
        .collect();
    addresses.sort();
    addresses.dedup();
    addresses
}

/// `tag | u32 LE socket id | body`, the event layout of the server channel.
pub(crate) fn server_event(tag: u8, socket_id: u32, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + body.len());
    out.push(tag);
    out.extend_from_slice(&socket_id.to_le_bytes());
    out.extend_from_slice(body);
    out
}

/// `tag | body`, the event layout of a client socket channel.
pub(crate) fn client_event(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + body.len());
    out.push(tag);
    out.extend_from_slice(body);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_lan_addresses_count() {
        assert!(is_lan_ipv4(&Ipv4Addr::new(192, 168, 178, 110)));
        assert!(is_lan_ipv4(&Ipv4Addr::new(10, 0, 2, 16)));
        assert!(!is_lan_ipv4(&Ipv4Addr::new(127, 0, 0, 1)));
        assert!(!is_lan_ipv4(&Ipv4Addr::new(169, 254, 1, 2)));
        assert!(!is_lan_ipv4(&Ipv4Addr::new(192, 0, 0, 4)));
    }

    #[test]
    fn events_carry_tag_and_socket_id() {
        assert_eq!(server_event(TAG_TEXT, 7, b"hi"), vec![1, 7, 0, 0, 0, b'h', b'i']);
        assert_eq!(client_event(TAG_CLOSED, b"x"), vec![3, b'x']);
    }
}
