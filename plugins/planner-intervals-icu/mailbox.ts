// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppFiles, HttpClient, HttpResponse, PluginLogger, Secrets } from '@ridrs/contracts';
import { z } from 'zod';
import {
  type DeviceKeys,
  encPublic,
  fromBase64Url,
  generateKeys,
  openEvent,
  type SealedEvent,
  signPublic,
  signRequest,
  toBase64Url,
} from './mailbox-crypto.ts';

/**
 * The client of the relay's mailbox (ADR 0079): per device an Ed25519 and an X25519 key pair, made
 * on the first connect; the private keys and the device id live in the secret store and nowhere
 * else. Every request but the registration is signed. An answer is untrusted: its shape is
 * checked with zod before use, and an event that does not open is dropped.
 */

/** The relay of ridrs; `mailboxConfig.baseUrl` is the override for tests. */
export const RELAY_URL = 'https://ridrs.app';
export const mailboxConfig = { baseUrl: RELAY_URL };

const SIGN_KEY = 'ridrs-mailbox.sign-private';
const ENC_KEY = 'ridrs-mailbox.enc-private';
const DEVICE_KEY = 'ridrs-mailbox.device-id';
const STATE_FILE = 'training/mailbox-state.json';
const PAGE = 50;

const sealedEventSchema = z
  .object({
    cursor: z.number().int().nonnegative(),
    id: z.string().min(1),
    type: z.string().min(1),
    timestamp: z.string().min(1),
    eph_pub: z.string().min(1),
    ciphertext: z.string().min(1),
  })
  .passthrough();

const updatesSchema = z.object({
  events: z.array(z.unknown()),
  next: z.number().int().nonnegative(),
  more: z.boolean(),
});

/** What is kept about the mailbox besides the keys: not secret. */
interface MailboxState {
  /** The highest cursor taken (applied and acked). */
  cursor: number;
  /** The last timestamp a signed request used; the next is greater. */
  lastTimestamp: number;
}

export interface MailboxEvent {
  readonly cursor: number;
  readonly id: string;
  readonly type: string;
  readonly timestamp: string;
  /** The decrypted JSON, not yet validated for its type. */
  readonly payload: unknown;
}

export interface Pickup {
  readonly events: readonly MailboxEvent[];
  /** The cursor to acknowledge once the events are applied. */
  readonly next: number;
}

export interface MailboxDeps {
  readonly http: HttpClient;
  readonly secrets: Secrets;
  readonly files: AppFiles;
  readonly logger: Pick<PluginLogger, 'warn'>;
  /** Epoch seconds. */
  readonly nowSeconds: () => number;
}

export interface Mailbox {
  /** Whether this device is registered (a device id is held). */
  registered(): Promise<boolean>;
  /**
   * Registers this device anew after every sign-in (the token goes to the relay once, over TLS); a
   * device from before is deleted at the relay, best effort, and its keys are replaced.
   */
  register(token: string): Promise<boolean>;
  /** Fetches what is waiting after the stored cursor, a page at a time. `undefined`: not registered or unreachable. */
  pickup(): Promise<Pickup | undefined>;
  /** Opens one sealed event (from the socket as well as from a pickup). */
  open(sealed: unknown): Promise<MailboxEvent | undefined>;
  /** Acknowledges the events up to `upto` and keeps the cursor. */
  acknowledge(upto: number): Promise<void>;
  /** Keeps the cursor of an event the socket delivered (the socket acknowledges it itself). */
  keepCursor(upto: number): Promise<void>;
  /** The cursor, for the socket's de-duplication. */
  cursor(): Promise<number>;
  /** The signed query for the socket: `device`, `ts`, `sig`. */
  signSocketQuery(): Promise<URLSearchParams | undefined>;
  /** Best effort: tells the relay, then drops the keys and the state. Always forgets locally. */
  disconnect(): Promise<void>;
  /**
   * Asks the relay whether it still knows the device (a refused socket does not say why). Forgets the
   * keys only when it answers `unknown_device`; true then, false when the device is known or the
   * relay cannot be reached.
   */
  checkRegistration(): Promise<boolean>;
  /** Drops the keys and the state of this device. */
  forget(): Promise<void>;
  /**
   * Tells the relay how the sign-in ended, so that its page in the browser can say it
   * (`POST /intervals/oauth/result`, unsigned: the secret is the state). Best effort with a short
   * time-out: never throws and never takes long.
   */
  reportSignIn(state: string, ok: boolean): Promise<void>;
}

/** How long the report of a sign-in result may take (wall-clock time of I/O). */
const REPORT_TIMEOUT_MS = 4000;

const encoder = new TextEncoder();

export function createMailbox(deps: MailboxDeps): Mailbox {
  const { http, secrets, files, logger } = deps;
  /** One request at a time: the timestamps of the signed requests must rise strictly. */
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.catch(() => undefined);
    return result;
  };

  const readState = async (): Promise<MailboxState> => {
    try {
      const parsed = z
        .object({ cursor: z.number().int().nonnegative(), lastTimestamp: z.number().nonnegative() })
        .safeParse(JSON.parse(new TextDecoder().decode(await files.read(STATE_FILE))));
      return parsed.success ? parsed.data : { cursor: 0, lastTimestamp: 0 };
    } catch {
      return { cursor: 0, lastTimestamp: 0 };
    }
  };
  const writeState = (state: MailboxState): Promise<void> =>
    files
      .write(STATE_FILE, encoder.encode(JSON.stringify(state)))
      .catch((error: unknown) => logger.warn({ error }, 'mailbox: state not kept'));

  const loadKeys = async (): Promise<{ keys: DeviceKeys; deviceId: string } | undefined> => {
    try {
      const [sign, enc, deviceId] = await Promise.all([
        secrets.get(SIGN_KEY),
        secrets.get(ENC_KEY),
        secrets.get(DEVICE_KEY),
      ]);
      if (!sign || !enc || !deviceId) {
        return undefined;
      }
      return { keys: { signPrivate: fromBase64Url(sign), encPrivate: fromBase64Url(enc) }, deviceId };
    } catch {
      return undefined;
    }
  };

  const forget = async (): Promise<void> => {
    await Promise.all([secrets.remove(SIGN_KEY), secrets.remove(ENC_KEY), secrets.remove(DEVICE_KEY)]).catch(
      () => undefined,
    );
    await files.remove(STATE_FILE).catch(() => undefined);
  };

  /** The relay says the device is not registered (it never says it for a clock or an order problem). */
  const unknownDevice = (response: HttpResponse): boolean =>
    response.status === 401 && z.object({ error: z.literal('unknown_device') }).safeParse(safeJson(response.body)).success;

  /**
   * A signed request. Any 401 but `unknown_device` (clock skew, a timestamp out of order) is tried
   * once more with a fresh timestamp, and is then given back as it is: the keys are never dropped for it.
   */
  const signed = async (
    held: { keys: DeviceKeys; deviceId: string },
    method: 'GET' | 'POST' | 'DELETE',
    pathAndQuery: string,
    body?: unknown,
  ): Promise<HttpResponse | undefined> => {
    const first = await signedOnce(held, method, pathAndQuery, body);
    if (first?.status === 401 && !unknownDevice(first)) {
      return signedOnce(held, method, pathAndQuery, body);
    }
    return first;
  };

  /** One signed request; the timestamp is `max(now, last + 1)`, kept before it is sent. */
  const signedOnce = async (
    held: { keys: DeviceKeys; deviceId: string },
    method: 'GET' | 'POST' | 'DELETE',
    pathAndQuery: string,
    body?: unknown,
  ): Promise<HttpResponse | undefined> => {
    const state = await readState();
    const timestamp = Math.max(deps.nowSeconds(), state.lastTimestamp + 1);
    await writeState({ ...state, lastTimestamp: timestamp });
    const bytes = body === undefined ? new Uint8Array() : encoder.encode(JSON.stringify(body));
    try {
      return await http.request({
        method,
        url: `${mailboxConfig.baseUrl}${pathAndQuery}`,
        headers: {
          'x-ridrs-device': held.deviceId,
          'x-ridrs-timestamp': String(timestamp),
          'x-ridrs-signature': signRequest(held.keys, method, pathAndQuery, timestamp, bytes),
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // Unreachable: the app works as without the mailbox, and says nothing.
      return undefined;
    }
  };

  const open = async (sealed: unknown): Promise<MailboxEvent | undefined> => {
    const held = await loadKeys();
    const parsed = sealedEventSchema.safeParse(sealed);
    if (!held || !parsed.success) {
      return undefined;
    }
    try {
      const event = parsed.data;
      const plain = openEvent(held.keys, held.deviceId, event as unknown as SealedEvent);
      return {
        cursor: event.cursor,
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
        payload: JSON.parse(plain) as unknown,
      };
    } catch {
      // Not for this device, or altered: dropped, never applied.
      logger.warn('mailbox: an event did not open and was dropped');
      return undefined;
    }
  };

  return {
    async reportSignIn(state, ok) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          http.request({
            method: 'POST',
            url: `${mailboxConfig.baseUrl}/intervals/oauth/result`,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ state, ok }),
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('time-out')), REPORT_TIMEOUT_MS);
          }),
        ]);
      } catch {
        // The page in the browser then says nothing was heard; the connect is not affected.
      } finally {
        clearTimeout(timer);
      }
    },

    async registered() {
      return (await loadKeys()) !== undefined;
    },

    register: (token) =>
      serial(async () => {
        // Always a new device: a sign-in is a new binding, and a different athlete must not inherit the old one.
        const previous = await loadKeys();
        const keys = generateKeys();
        let response: HttpResponse;
        try {
          response = await http.request({
            method: 'POST',
            url: `${mailboxConfig.baseUrl}/devices`,
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              token,
              sign_pub: toBase64Url(signPublic(keys)),
              enc_pub: toBase64Url(encPublic(keys)),
              name: 'ridrs',
            }),
          });
        } catch {
          return false;
        }
        const answer = z.object({ device_id: z.string().min(1) }).safeParse(safeJson(response.body));
        if (response.status !== 200 || !answer.success) {
          logger.warn({ status: response.status }, 'mailbox: the registration was not accepted');
          return false;
        }
        // The old device goes first, with its own keys, while they are still there: best effort.
        if (previous) {
          await signed(previous, 'DELETE', `/devices/${encodeURIComponent(previous.deviceId)}`).catch(() => undefined);
        }
        await secrets.set(SIGN_KEY, toBase64Url(keys.signPrivate));
        await secrets.set(ENC_KEY, toBase64Url(keys.encPrivate));
        await secrets.set(DEVICE_KEY, answer.data.device_id);
        await writeState({ cursor: 0, lastTimestamp: 0 });
        return true;
      }),

    pickup: () =>
      serial(async () => {
        const held = await loadKeys();
        if (!held) {
          return undefined;
        }
        const state = await readState();
        const events: MailboxEvent[] = [];
        let since = state.cursor;
        for (let page = 0; page < 100; page++) {
          const response = await signed(held, 'GET', `/updates?since=${since}&limit=${PAGE}`);
          if (!response) {
            return undefined;
          }
          if (unknownDevice(response)) {
            // The relay does not know the device any more: the next sign-in registers again.
            await forget();
            return undefined;
          }
          const answer = updatesSchema.safeParse(safeJson(response.body));
          if (response.status !== 200 || !answer.success) {
            return undefined;
          }
          for (const sealed of answer.data.events) {
            const opened = await open(sealed);
            if (opened) {
              events.push(opened);
            }
          }
          since = answer.data.next;
          if (!answer.data.more) {
            return { events, next: since };
          }
        }
        return { events, next: since };
      }),

    open,

    acknowledge: (upto) =>
      serial(async () => {
        const held = await loadKeys();
        if (!held) {
          return;
        }
        const response = await signed(held, 'POST', '/updates/ack', { upto });
        if (response?.status === 200) {
          const state = await readState();
          await writeState({ ...state, cursor: Math.max(state.cursor, upto) });
        }
      }),

    cursor: async () => (await readState()).cursor,

    keepCursor: (upto) =>
      serial(async () => {
        const state = await readState();
        await writeState({ ...state, cursor: Math.max(state.cursor, upto) });
      }),

    signSocketQuery: () =>
      serial(async () => {
        const held = await loadKeys();
        if (!held) {
          return undefined;
        }
        const state = await readState();
        const timestamp = Math.max(deps.nowSeconds(), state.lastTimestamp + 1);
        await writeState({ ...state, lastTimestamp: timestamp });
        return new URLSearchParams({
          device: held.deviceId,
          ts: String(timestamp),
          sig: signRequest(held.keys, 'GET', '/updates/ws', timestamp),
        });
      }),

    disconnect: () =>
      serial(async () => {
        const held = await loadKeys();
        if (held) {
          await signed(held, 'DELETE', `/devices/${encodeURIComponent(held.deviceId)}`).catch(() => undefined);
        }
        await forget();
      }),

    checkRegistration: () =>
      serial(async () => {
        const held = await loadKeys();
        if (!held) {
          return true;
        }
        const state = await readState();
        const response = await signed(held, 'GET', `/updates?since=${state.cursor}&limit=1`);
        if (response && unknownDevice(response)) {
          await forget();
          return true;
        }
        return false;
      }),

    forget: () => serial(forget),
  };
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
