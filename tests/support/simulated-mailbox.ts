// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  createCipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  verify,
} from 'node:crypto';

/**
 * The relay's mailbox for the scenarios (ADR 0079): the server side of the protocol of
 * `https://ridrs.app` that the app talks to. It registers a device with the token (and checks
 * it), verifies every signed request (device, a timestamp within 300 s that rises strictly, the
 * Ed25519 signature over `METHOD \n path \n timestamp \n sha256(body)`), keeps the sealed events
 * of the device and seals new ones the way the real server does (X25519, HKDF-SHA256, AES-256-GCM).
 * The steps play intervals.icu's webhook with `push`.
 */

export const RELAY_ORIGIN = 'https://ridrs.app';
/** The id of the first device the relay registers; later ones count on. */
export const DEVICE_ID = 'SIMDEVICE00000000001Q';
const deviceIdNumber = (n: number) =>
  n === 1 ? DEVICE_ID : `SIMDEVICE0000000000${String(n).padStart(2, '0')}Q`;

interface Request {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array<ArrayBuffer>;
}
interface Response {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface SocketListener {
  message(text: string): void;
  close(code: number | undefined): void;
}

export interface SealedEvent {
  readonly cursor: number;
  readonly id: string;
  readonly type: string;
  readonly timestamp: string;
  readonly eph_pub: string;
  readonly ciphertext: string;
}

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const raw = (value: string) => Buffer.from(value, 'base64url');

export class SimulatedMailbox {
  /** Every request the app made to the relay, as `METHOD /path`. */
  readonly requests: string[] = [];
  /** The registered device: its raw public keys and the last timestamp it used. */
  device?: {
    readonly id: string;
    readonly signPub: Buffer;
    readonly encPub: Buffer;
    lastTimestamp: number;
  };
  /** The ids of every device registered so far, and those deleted. */
  readonly registered: string[] = [];
  private readonly devices = new Map<string, NonNullable<SimulatedMailbox['device']>>();
  readonly deletedIds: string[] = [];
  /** The token the registration sent, kept to assert it was sent once and only to /devices. */
  readonly tokensSeen: string[] = [];
  deleted = false;
  /** The next signed requests answer 401 `stale_timestamp` (clock skew): the device stays known. */
  skewedRequests = 0;
  /** The relay no longer knows the device: signed requests answer 401 `unknown_device`. */
  forgetDevice(): void {
    this.device = undefined;
    this.devices.clear();
  }
  /** Events not yet acknowledged. */
  events: SealedEvent[] = [];
  private cursor = 0;
  /** The relay is not reachable. */
  reachable = true;
  /** Called with a sealed event when it is pushed (a connected socket gets it). */
  readonly listeners = new Set<(event: SealedEvent) => void>();

  /** The sockets: the open one of the device, and every connection attempt as its URL path. */
  private current?: { readonly listener: SocketListener; closed: boolean };
  readonly socketAttempts: string[] = [];
  /** The messages the app sent over the socket (`ping` and acknowledgements). */
  readonly socketReceived: string[] = [];
  /** Connections accepted so far. */
  accepted = 0;

  /** `net.websocket` of the relay: `wss://ridrs.app/updates/ws?device&ts&sig` (ADR 0079). */
  readonly webSocket = {
    connect: async (rawUrl: string, listener: SocketListener) => {
      const url = new URL(rawUrl);
      this.socketAttempts.push(url.pathname);
      if (!this.reachable || url.origin !== 'wss://ridrs.app') {
        throw new Error('connection refused');
      }
      const unauthorized = this.authenticate(
        {
          method: 'GET',
          url: rawUrl,
          headers: {
            'x-ridrs-device': url.searchParams.get('device') ?? '',
            'x-ridrs-timestamp': url.searchParams.get('ts') ?? '',
            'x-ridrs-signature': url.searchParams.get('sig') ?? '',
          },
        },
        url.pathname,
        '',
      );
      if (unauthorized) {
        throw new Error('HTTP error: 401 Unauthorized');
      }
      // One socket per device: the older one is closed with 4000.
      if (this.current && !this.current.closed) {
        this.current.closed = true;
        this.current.listener.close(4000);
      }
      const mine = { listener, closed: false };
      this.current = mine;
      this.accepted += 1;
      const push = (event: SealedEvent) => {
        if (!mine.closed) {
          listener.message(JSON.stringify({ t: 'event', event }));
        }
      };
      this.listeners.add(push);
      listener.message(JSON.stringify({ t: 'hello', next: this.events.at(-1)?.cursor ?? 0 }));
      return {
        send: async (text: string) => {
          this.socketReceived.push(text);
          if (text === 'ping') {
            listener.message('pong');
          } else {
            const upto = (JSON.parse(text) as { t?: string; upto?: number }).upto;
            if (typeof upto === 'number') {
              this.events = this.events.filter((event) => event.cursor > upto);
            }
          }
        },
        close: async () => {
          mine.closed = true;
          this.listeners.delete(push);
        },
      };
    },
  };

  /** True while a socket of the device is open. */
  get socketOpen(): boolean {
    return this.current !== undefined && !this.current.closed;
  }

  /** The network drops the socket. */
  dropSocket(): void {
    if (this.current && !this.current.closed) {
      this.current.closed = true;
      this.current.listener.close(1006);
    }
  }

  /** Another connection of the device replaces this one: the relay closes it with 4000. */
  replaceSocket(): void {
    if (this.current && !this.current.closed) {
      this.current.closed = true;
      this.current.listener.close(4000);
    }
  }

  constructor(private readonly validToken: () => string | undefined) {}

  count(call: string): number {
    return this.requests.filter((line) => line === call).length;
  }

  /** Plays the webhook of intervals.icu: seals the event for the device and stores it. */
  push(
    type: string,
    payload: Record<string, unknown>,
    timestamp = new Date().toISOString().slice(0, 19),
  ): SealedEvent {
    const device = this.device;
    if (!device) {
      throw new Error('No device is registered at the relay');
    }
    this.cursor += 1;
    const id = `evt-${this.cursor}`;
    const plaintext = JSON.stringify({ athlete_id: 'i4711', type, timestamp, ...payload });
    const sealed = this.seal(device.encPub, plaintext, type, timestamp);
    const event: SealedEvent = { cursor: this.cursor, id, type, timestamp, ...sealed };
    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }

  /** The same event again, under a new cursor: the relay delivers at least once. */
  duplicate(event: SealedEvent): SealedEvent {
    this.cursor += 1;
    const copy = { ...event, cursor: this.cursor };
    this.events.push(copy);
    for (const listener of this.listeners) {
      listener(copy);
    }
    return copy;
  }

  private seal(devicePub: Buffer, plaintext: string, type: string, timestamp: string) {
    const eph = generateKeyPairSync('x25519');
    const ephPub = raw(eph.publicKey.export({ format: 'jwk' }).x ?? '');
    const peer = createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: b64u(devicePub) },
      format: 'jwk',
    });
    const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: peer });
    const key = Buffer.from(
      hkdfSync('sha256', shared, Buffer.concat([ephPub, devicePub]), 'ridrs-mailbox-v1', 32),
    );
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`${this.device?.id ?? DEVICE_ID}|${type}|${timestamp}`));
    const body = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return { eph_pub: b64u(ephPub), ciphertext: b64u(Buffer.concat([nonce, body])) };
  }

  /** The relay's answer; `undefined` for a URL that is not the relay's. */
  handle(request: Request): Response | undefined {
    const url = new URL(request.url);
    if (url.origin !== RELAY_ORIGIN) {
      return undefined;
    }
    const path = `${url.pathname}${url.search}`;
    this.requests.push(`${request.method} ${url.pathname}`);
    if (!this.reachable) {
      throw new Error('getaddrinfo ENOTFOUND ridrs.app');
    }
    const body = typeof request.body === 'string' ? request.body : '';
    if (request.method === 'POST' && url.pathname === '/devices') {
      return this.register(body);
    }
    const unauthorized = this.authenticate(request, path, body);
    if (unauthorized) {
      return unauthorized;
    }
    if (request.method === 'GET' && url.pathname === '/updates') {
      const since = Number(url.searchParams.get('since') ?? '0');
      const limit = Math.min(100, Number(url.searchParams.get('limit') ?? '50'));
      const due = this.events.filter((event) => event.cursor > since);
      const page = due.slice(0, limit);
      return json(200, {
        events: page,
        next: page.at(-1)?.cursor ?? since,
        more: due.length > page.length,
      });
    }
    if (request.method === 'POST' && url.pathname === '/updates/ack') {
      const upto = (JSON.parse(body) as { upto?: number }).upto ?? 0;
      this.events = this.events.filter((event) => event.cursor > upto);
      return json(200, {});
    }
    const removal = /^\/devices\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (request.method === 'DELETE' && removal) {
      this.deletedIds.push(removal[1] ?? '');
      this.devices.delete(removal[1] ?? '');
      if (this.device?.id === removal[1]) {
        this.device = undefined;
      }
      this.deleted = true;
      return json(200, {});
    }
    return json(404, { error: 'No route' });
  }

  private register(body: string): Response {
    const fields = JSON.parse(body) as { token?: string; sign_pub?: string; enc_pub?: string };
    this.tokensSeen.push(fields.token ?? '');
    if (!fields.token || fields.token !== this.validToken()) {
      return json(401, { error: 'Unknown token' });
    }
    const signPub = raw(fields.sign_pub ?? '');
    const encPub = raw(fields.enc_pub ?? '');
    if (signPub.length !== 32 || encPub.length !== 32) {
      return json(400, { error: 'Bad keys' });
    }
    const id = deviceIdNumber(this.registered.length + 1);
    this.registered.push(id);
    this.device = { id, signPub, encPub, lastTimestamp: 0 };
    this.devices.set(id, this.device);
    this.deleted = false;
    return json(200, { device_id: id });
  }

  /** The checks of every signed request; the answer is 401 for the first that fails. */
  private authenticate(request: Request, path: string, body: string): Response | undefined {
    const header = (name: string) =>
      Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
    const device = this.devices.get(header('x-ridrs-device') ?? '');
    const timestamp = Number(header('x-ridrs-timestamp'));
    const signature = header('x-ridrs-signature');
    if (!device || !Number.isInteger(timestamp) || !signature) {
      return json(401, { error: 'unknown_device' });
    }
    if (this.skewedRequests > 0) {
      this.skewedRequests -= 1;
      return json(401, { error: 'stale_timestamp' });
    }
    if (Math.abs(Date.now() / 1000 - timestamp) > 300 || timestamp <= device.lastTimestamp) {
      return json(401, { error: 'stale_timestamp' });
    }
    const message = `${request.method}\n${path}\n${timestamp}\n${createHash('sha256').update(body).digest('hex')}`;
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: b64u(device.signPub) },
      format: 'jwk',
    });
    if (!verify(null, Buffer.from(message), key, raw(signature))) {
      return json(401, { error: 'bad_signature' });
    }
    device.lastTimestamp = timestamp;
    return undefined;
  }
}

function json(status: number, body: unknown): Response {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
