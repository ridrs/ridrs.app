// SPDX-License-Identifier: Apache-2.0

import { defineCapability } from './capabilities.ts';

/**
 * HTTP to the services ridrs connects to (ADR 0048). The provider decides how requests leave
 * the app (Rust in the native app) and which URLs it allows. A network failure rejects; any
 * HTTP status resolves.
 */
export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Text, or bytes such as a multipart upload. */
  readonly body?: string | Uint8Array<ArrayBuffer>;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** As text, so that a provider can carry it across a process boundary; callers parse it. */
  readonly body: string;
}

export const netHttpCapability = defineCapability<HttpClient, 'single', 'net.http'>('net.http', {
  cardinality: 'single',
});

/**
 * A WebSocket to a service ridrs connects to (ADR 0079), behind a port so that the native app can
 * run it in Rust (the webview's CSP stays closed) and scenarios can simulate it. Text messages
 * only. `connect` resolves once the socket is open and rejects when it cannot be opened (an
 * HTTP error before the upgrade, such as 401, is in the message); `listener.close` gets the
 * close code when the peer or the network ends it.
 */
export interface WebSocketClient {
  connect(url: string, listener: WebSocketListener): Promise<WebSocketConnection>;
}

export interface WebSocketListener {
  message(text: string): void;
  close(code: number | undefined): void;
}

export interface WebSocketConnection {
  send(text: string): Promise<void>;
  close(): Promise<void>;
}

export const netWebSocketCapability = defineCapability<WebSocketClient, 'single', 'net.websocket'>(
  'net.websocket',
  { cardinality: 'single' },
);
