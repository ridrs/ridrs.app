// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineState } from './app-state.ts';
import { defineCapability } from './capabilities.ts';
import { defineService } from './services.ts';

/**
 * The BLE bridge: a companion app on a phone holds the Bluetooth link and forwards raw GATT
 * traffic to ridrs over a socket in the same network. These are the wire protocol, the socket
 * port and the events/capability ridrs plugins use to find and pair a companion.
 */

/**
 * Wire protocol version; a companion accepts clients within the same major version.
 * 1.1: `write` / `written`. 1.2: `rssi`, `manufacturerData` and `serviceData` in `discovered`,
 * sent only to a client of 1.2 or later. 1.3: `withResponse` in `write`, `read` / `read-result`
 * (ADR 0052); ridrs sends them only to a companion of 1.3 or later. 1.4: `vanished`, sent only to
 * a client of 1.4 or later.
 */
export const BLE_BRIDGE_PROTOCOL_VERSION = '1.4.0';

/** The first protocol with `withResponse` in `write` and with `read`. */
export const BLE_BRIDGE_READ_PROTOCOL_VERSION = '1.3.0';

/** DNS-SD service type a companion advertises (TXT: `protocol`, `name`, `id`). */
export const BLE_BRIDGE_SERVICE_TYPE = '_ridrs-bridge._tcp';

/** Both sides send a heartbeat this often ... */
export const BLE_BRIDGE_HEARTBEAT_INTERVAL_MS = 1000;
/** ... and declare the link dead after this long without any inbound message. */
export const BLE_BRIDGE_LINK_TIMEOUT_MS = 5000;

/** u32 LE subscription id + f64 LE companion wall-clock ms (diagnostics only), then the payload. */
export const BLE_BRIDGE_FRAME_HEADER_BYTES = 12;

export const bridgeRejectReasonSchema = z.enum([
  'bad-code',
  'bad-token',
  'locked',
  'incompatible',
  'busy',
  'unknown-secret',
  'paused',
]);
export type BridgeRejectReason = z.infer<typeof bridgeRejectReasonSchema>;

const requestId = z.number().int().nonnegative();
const uuid = z.string().min(1);

/** Text messages (JSON). Binary messages are notification frames. */
export const bridgeMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('hello'),
      protocol: z.string().min(1),
      clientName: z.string(),
      pairingCode: z.string().optional(),
      /** Secret of a pairing QR code ridrs showed and the companion scanned. */
      pairingSecret: z.string().optional(),
      token: z.string().optional(),
      /**
       * With a token: `reconnect` (automatic, respects a deliberate disconnect), `resume` (the
       * rider pressed Connect in ridrs: lifts it) or `forget` (ridrs forgot the pairing).
       */
      intent: z.enum(['reconnect', 'resume', 'forget']).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('welcome'),
      protocol: z.string().min(1),
      companionId: z.string().min(1),
      companionName: z.string(),
      token: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('rejected'),
      reason: bridgeRejectReasonSchema,
      /** With `paused`: who disconnected deliberately. */
      pausedBy: z.enum(['ridrs', 'companion']).optional(),
    })
    .strict(),
  /** Announces a deliberate end before closing, so the other side shows the same at once. */
  z.object({ type: z.literal('bye'), reason: z.enum(['disconnect', 'forget']) }).strict(),
  z.object({ type: z.literal('ping'), sentAt: z.number() }).strict(),
  z.object({ type: z.literal('pong'), sentAt: z.number(), companionTime: z.number() }).strict(),
  z.object({ type: z.literal('scan'), requestId, serviceUuids: z.array(uuid) }).strict(),
  z.object({ type: z.literal('stop-scan'), requestId }).strict(),
  z
    .object({
      type: z.literal('discovered'),
      requestId,
      peripheralId: z.string().min(1),
      name: z.string(),
      serviceUuids: z.array(uuid),
      rssi: z.number().int().optional(),
      /** Company id (4 hex digits) → bytes as hex; see `BleDiscoveredPeripheral`. */
      manufacturerData: z.record(z.string(), z.string()).optional(),
      /** Normalized service UUID → bytes as hex. */
      serviceData: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  /** From 1.4: a device the scan reported is gone (a removed dummy device). */
  z.object({ type: z.literal('vanished'), requestId, peripheralId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('connect'), requestId, peripheralId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('connected'), requestId, peripheralId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('disconnect'), requestId, peripheralId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('disconnected'), requestId }).strict(),
  z.object({ type: z.literal('connection-lost'), peripheralId: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal('subscribe'),
      requestId,
      peripheralId: z.string().min(1),
      serviceUuid: uuid,
      characteristicUuid: uuid,
    })
    .strict(),
  z
    .object({
      type: z.literal('subscribed'),
      requestId,
      subscriptionId: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({ type: z.literal('unsubscribe'), subscriptionId: z.number().int().nonnegative() })
    .strict(),
  z
    .object({
      type: z.literal('write'),
      requestId,
      peripheralId: z.string().min(1),
      serviceUuid: uuid,
      characteristicUuid: uuid,
      /** Lowercase hex, see `bytesToHex`. */
      data: z.string().regex(/^(?:[0-9a-f]{2})*$/),
      /** From 1.3: a Write With Response; `written` follows the peripheral's write response. */
      withResponse: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('written'), requestId }).strict(),
  z
    .object({
      type: z.literal('read'),
      requestId,
      peripheralId: z.string().min(1),
      serviceUuid: uuid,
      characteristicUuid: uuid,
    })
    .strict(),
  z
    .object({
      type: z.literal('read-result'),
      requestId,
      /** Lowercase hex, see `bytesToHex`. */
      data: z.string().regex(/^(?:[0-9a-f]{2})*$/),
    })
    .strict(),
  z.object({ type: z.literal('failed'), requestId, message: z.string() }).strict(),
]);
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;

export interface BridgeNotificationFrame {
  readonly subscriptionId: number;
  /** Companion wall-clock ms at receive time: diagnostics only, never measurement time. */
  readonly companionTime: number;
  readonly data: Uint8Array;
}

export function encodeBridgeFrame(frame: BridgeNotificationFrame): Uint8Array {
  const bytes = new Uint8Array(BLE_BRIDGE_FRAME_HEADER_BYTES + frame.data.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, frame.subscriptionId, true);
  view.setFloat64(4, frame.companionTime, true);
  bytes.set(frame.data, BLE_BRIDGE_FRAME_HEADER_BYTES);
  return bytes;
}

export function decodeBridgeFrame(bytes: Uint8Array): BridgeNotificationFrame {
  if (bytes.byteLength < BLE_BRIDGE_FRAME_HEADER_BYTES) {
    throw new RangeError(`Bridge frame too short: ${bytes.byteLength} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    subscriptionId: view.getUint32(0, true),
    companionTime: view.getFloat64(4, true),
    data: bytes.slice(BLE_BRIDGE_FRAME_HEADER_BYTES),
  };
}

/**
 * One established, message-framed connection (a WebSocket, a Rust socket behind Tauri IPC, or an
 * in-memory pair in tests). Text carries JSON messages, binary carries notification frames.
 */
export interface BridgeSocket {
  send(message: string | Uint8Array): void;
  onMessage(listener: (message: string | Uint8Array) => void): () => void;
  /** Called once, whoever closed the socket. */
  onClose(listener: (reason: string) => void): () => void;
  close(): void;
}

/** A companion found in the network. */
export interface CompanionAdvert {
  /** Stable companion id from the TXT record; empty if the advert carries none. */
  readonly companionId: string;
  readonly name: string;
  /** `host:port`, connectable as is. */
  readonly address: string;
}

export interface StoredBridgePairing {
  readonly companionId: string;
  readonly companionName: string;
  readonly address: string;
  readonly token: string;
  /** The rider forgot this pairing while the companion was away; still to tell the companion. */
  readonly forgotten?: boolean;
}

/**
 * Platform side of the bridge, provided by the app's connector plugin: network discovery, opening
 * sockets and keeping the pairing across restarts.
 */
export interface BleBridgeConnector {
  /** Reports the full current list on every change; returns a stop function. */
  watchCompanions(listener: (companions: readonly CompanionAdvert[]) => void): () => void;
  open(address: string): Promise<BridgeSocket>;
  loadPairing(): StoredBridgePairing | undefined;
  savePairing(pairing: StoredBridgePairing): void;
  clearPairing(): void;
}

export const bleBridgeConnectorCapability = defineCapability<
  BleBridgeConnector,
  'single',
  'ble-bridge.connector'
>('ble-bridge.connector', { cardinality: 'single' });

export const bridgeStateSchema = z.enum([
  'unpaired',
  'connecting',
  'connected',
  'reconnecting',
  /** Connecting failed for 30 s; ridrs keeps trying. `reason` says why. */
  'unreachable',
  /** Deliberately disconnected; `reason` is `by-ridrs` or `by-companion`. */
  'disconnected',
  'rejected',
]);
export type BridgeState = z.infer<typeof bridgeStateSchema>;

/**
 * The companions found in this network, as one list (ADR 0069: app state, key: the bridge
 * plugin's id). Never in a journal.
 */
export const bridgeCompanionsState = defineState(
  'bridge.companions',
  z
    .object({
      companions: z.array(
        z
          .object({
            companionId: z.string(),
            name: z.string(),
            address: z.string(),
            paired: z.boolean(),
          })
          .strict(),
      ),
    })
    .strict(),
);

const done = z.object({}).strict();

/**
 * The rider entered the code shown on the phone, for a listed companion or a typed address. A
 * service (ADR 0069): the code never enters a journal, and a continued ride never pairs again.
 * Answers once pairing started; how it goes is the bridge's state.
 */
export const bridgePairService = defineService('bridge.pair', {
  request: z.object({ address: z.string().min(1), code: z.string().min(1) }).strict(),
  response: done,
});

/** URI in the pairing QR code ridrs shows: `ridrs://pair?v=1&s=<secret>&n=<ridrs name>`. */
export interface PairingOffer {
  /** 32 lowercase hex characters (128 bit), used once. */
  readonly secret: string;
  readonly name: string;
}

const PAIRING_SECRET = /^[0-9a-f]{32}$/;

export function formatPairingUri(offer: PairingOffer): string {
  const query = new URLSearchParams({ v: '1', s: offer.secret, n: offer.name });
  return `ridrs://pair?${query.toString()}`;
}

/** `undefined` for anything that is not a ridrs pairing QR code of a known version. */
export function parsePairingUri(text: string): PairingOffer | undefined {
  const prefix = 'ridrs://pair?';
  if (!text.startsWith(prefix)) {
    return undefined;
  }
  const query = new URLSearchParams(text.slice(prefix.length));
  const secret = query.get('s') ?? '';
  if (query.get('v') !== '1' || !PAIRING_SECRET.test(secret)) {
    return undefined;
  }
  return { secret, name: query.get('n') ?? '' };
}

/** The rider asks to connect to the paired companion (after a disconnect, or to retry now). */
export const bridgeConnectService = defineService('bridge.connect', {
  request: done,
  response: done,
});

/** The rider asks to disconnect from the paired companion, keeping the pairing. */
export const bridgeDisconnectService = defineService('bridge.disconnect', {
  request: done,
  response: done,
});

/** The rider asks to forget the paired companion, on both devices. */
export const bridgeForgetService = defineService('bridge.forget', {
  request: done,
  response: done,
});

/**
 * ridrs is not paired and shows this QR code; no key: nothing to show. It holds the pairing
 * secret: app state only (ADR 0069), never on the bus, never in a journal.
 */
export const bridgePairingState = defineState(
  'bridge.pairing',
  z.object({ uri: z.string().min(1) }).strict(),
);

export const bridgeLinkSchema = z
  .object({
    state: bridgeStateSchema,
    companionName: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();
export type BridgeLinkState = z.infer<typeof bridgeLinkSchema>;

/** The link to the companion (ADR 0069: app state, key: the bridge plugin's id). */
export const bridgeLinkState = defineState('bridge.state', bridgeLinkSchema);
