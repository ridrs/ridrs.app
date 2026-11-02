<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0021: QR Pairing with `uqr` and `tauri-plugin-barcode-scanner`

Pairing a companion needs no typing. **ridrs shows a QR code; the phone scans it.** That is the WhatsApp Web direction: the phone has a camera, the Mac or TV running ridrs usually does not. The 6-digit code the phone shows remains as an alternative. ridrs finds companions only through mDNS; the "pair by address" field was removed.

- The QR code holds `ridrs://pair?v=1&s=<secret>&n=<ridrs name>`, with a 128-bit random secret (Web Crypto). The phone accepts that secret for **one** pairing within **ten minutes**. While nothing is paired, ridrs tries every found companion with it every 2 s; only the one that scanned welcomes it with a token. Misses never lock the code out (`unknown-secret`); a 128-bit secret cannot be guessed.
- **Rendering** in ridrs: [`uqr`](https://github.com/unjs/uqr) 0.1.3 (MIT, unjs). It is pure ESM with no dependencies and renders SVG, which is shown as a `data:` image, allowed by the native app's existing CSP (`img-src 'self' data:`).
- **Scanning** on the phone: the official [`tauri-plugin-barcode-scanner`](https://github.com/tauri-apps/plugins-workspace) 2.5.3 (MIT OR Apache-2.0; npm `@tauri-apps/plugin-barcode-scanner` 2.5.3). It uses the native camera scanners (ML Kit on Android, AVFoundation on iOS) and is mobile-only, so the companion registers it under `#[cfg(mobile)]` with a mobile-only capability. iOS needs `NSCameraUsageDescription`.

Rejected: ridrs scanning a QR code on the phone (needs a camera at the Mac/TV and a JS decoder); a QR code that carries an address (would only help where mDNS fails, and needs the address field the rider does not want).
