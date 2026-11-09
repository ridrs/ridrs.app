// MailboxHub: one Durable Object per device holding that device's WebSocket
// (Hibernation API). It is only a fast path; the D1 mailbox stays the source
// of truth and nothing is replayed on connect.
import { ackUpdates, maxCursor } from "./mailbox.js";

export const MAX_MESSAGE_BYTES = 4096;
export const CLOSE_REPLACED = 4000;
export const CLOSE_UNREGISTERED = 4401;

export class MailboxHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    if (typeof WebSocketRequestResponsePair !== "undefined") {
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
  }

  // Internal only: the Worker verified the signature before forwarding.
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ws" && request.headers.get("upgrade") === "websocket") {
      const deviceId = request.headers.get("x-ridrs-device");
      if (!deviceId) return new Response(null, { status: 400 });
      const pair = new WebSocketPair();
      await this.connect(pair[1], deviceId);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/notify" && request.method === "POST") {
      await this.notify(await request.json());
      return new Response("{}");
    }
    if (url.pathname === "/close" && request.method === "POST") {
      this.closeAll(CLOSE_UNREGISTERED);
      return new Response("{}");
    }
    return new Response(null, { status: 404 });
  }

  async connect(ws, deviceId) {
    this.closeAll(CLOSE_REPLACED);
    this.state.acceptWebSocket(ws);
    ws.serializeAttachment({ device_id: deviceId });
    ws.send(JSON.stringify({ t: "hello", next: await maxCursor(this.env, deviceId) }));
  }

  closeAll(code) {
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.close(code, code === CLOSE_REPLACED ? "replaced" : "unregistered");
      } catch {
        // already closed
      }
    }
  }

  async notify(event) {
    const message = JSON.stringify({ t: "event", event });
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // the client catches up through GET /updates
      }
    }
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) {
      ws.close(1009, "too large");
      return;
    }
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (data?.t !== "ack" || !Number.isSafeInteger(data.upto) || data.upto < 0) return;
    const deviceId = ws.deserializeAttachment()?.device_id;
    if (!deviceId) return;
    const device = await this.env.DB.prepare("SELECT 1 AS x FROM devices WHERE device_id = ?").bind(deviceId).first();
    if (!device) {
      ws.close(CLOSE_UNREGISTERED, "unregistered");
      return;
    }
    await ackUpdates(this.env, deviceId, data.upto);
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code && code !== 1005 && code !== 1006 ? code : 1000);
    } catch {
      // already closed
    }
  }

  async webSocketError() {}
}
