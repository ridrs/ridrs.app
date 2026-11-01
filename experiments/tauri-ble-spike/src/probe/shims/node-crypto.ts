// SPDX-License-Identifier: AGPL-3.0-or-later

// Measuring-only shim for the stage 3 probe: the WebView has the same function on globalThis.
export const randomUUID = (): string => globalThis.crypto.randomUUID();
