// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, netWebSocketCapability, type WebSocketClient } from '@ridrs/contracts';
import WebSocket from '@tauri-apps/plugin-websocket';

/**
 * `net.websocket` in the native app (ADR 0079): the socket runs in Rust through the official Tauri
 * websocket plugin, so the webview's CSP stays closed, as for `net.http` (ADR 0049). Text messages
 * only. The plugin has no URL scope: the only caller is the mailbox, which connects to the relay.
 */
const tauriWebSocket: WebSocketClient = {
  async connect(url, listener) {
    const socket = await WebSocket.connect(url);
    socket.addListener((message) => {
      if (message.type === 'Text' && typeof message.data === 'string') {
        listener.message(message.data);
      } else if (message.type === 'Close') {
        listener.close(message.data?.code);
      }
    });
    return {
      send: (text) => socket.send(text),
      close: () => socket.disconnect(),
    };
  },
};

export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(netWebSocketCapability, tauriWebSocket);
  },
});
