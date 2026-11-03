// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TimeSource } from '@ridrs/contracts';

const MAX_WRONG_CODES = 5;
const LOCK_MS = 60_000;
/** How long a scanned QR code may be used to pair. */
const SCANNED_SECRET_MS = 10 * 60_000;

/** One paired ridrs, as the companion remembers it. */
export interface PairedClient {
  readonly token: string;
  readonly clientName: string;
  /** Deliberately disconnected (from either side): automatic reconnects are refused. */
  readonly pausedBy?: 'ridrs' | 'companion';
}

export interface PairingState {
  readonly companionId: string;
  readonly pairings?: readonly PairedClient[];
  /** Before pairings had names (first companion builds); read only. */
  readonly tokens?: readonly string[];
}

/** Where the companion keeps its id and the tokens it issued (survives app restarts). */
export interface PairingStore {
  load(): PairingState | undefined;
  save(state: PairingState): void;
}

export interface PairingAuthorityOptions {
  readonly clock: TimeSource;
  readonly store?: PairingStore;
  /** Random bytes; Web Crypto by default (available in Node and every WebView). */
  readonly randomBytes?: (length: number) => Uint8Array;
  /** Produces the 6-digit code shown on the phone; derived from `randomBytes` by default. */
  readonly generateCode?: () => string;
}

function webCryptoBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function memoryStore(): PairingStore {
  let state: PairingState | undefined;
  return {
    load: () => state,
    save: (next) => {
      state = next;
    },
  };
}

/**
 * The companion's trust anchor: a pairing code shown on the phone, entered once in ridrs, and a
 * token per paired ridrs for later reconnects. Five wrong codes lock pairing for a minute.
 */
export class PairingAuthority {
  readonly companionId: string;
  private readonly clock: TimeSource;
  private readonly store: PairingStore;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly generateCode: () => string;
  private pairings: PairedClient[];
  private currentCode: string;
  private wrongCodes = 0;
  private lockedUntil = 0;
  private scanned?: { readonly secret: string; readonly until: number };

  constructor(options: PairingAuthorityOptions) {
    this.clock = options.clock;
    this.store = options.store ?? memoryStore();
    this.randomBytes = options.randomBytes ?? webCryptoBytes;
    this.generateCode =
      options.generateCode ??
      (() => {
        const value = new DataView(this.randomBytes(4).buffer).getUint32(0) % 1_000_000;
        return value.toString().padStart(6, '0');
      });
    const stored = this.store.load();
    this.companionId = stored?.companionId ?? toHex(this.randomBytes(8));
    this.pairings = [
      ...(stored?.pairings ?? []),
      ...(stored?.tokens ?? []).map((token) => ({ token, clientName: 'ridrs' })),
    ];
    this.persist();
    this.currentCode = this.generateCode();
  }

  get code(): string {
    return this.currentCode;
  }

  /** Checks a code; a correct one is used up and replaced by a fresh code. */
  verifyCode(code: string): 'ok' | 'bad-code' | 'locked' {
    if (this.clock.now() < this.lockedUntil) {
      return 'locked';
    }
    if (code !== this.currentCode) {
      this.wrongCodes += 1;
      if (this.wrongCodes >= MAX_WRONG_CODES) {
        this.wrongCodes = 0;
        this.lockedUntil = this.clock.now() + LOCK_MS;
      }
      return 'bad-code';
    }
    this.wrongCodes = 0;
    this.currentCode = this.generateCode();
    return 'ok';
  }

  /** The phone scanned a pairing QR code shown by ridrs: that ridrs may pair once, for ten minutes. */
  acceptScannedSecret(secret: string): void {
    this.scanned = { secret, until: this.clock.now() + SCANNED_SECRET_MS };
  }

  /**
   * Checks the secret of a scanned QR code; a match is used up. Unlike codes, misses never lock:
   * a 128-bit secret cannot be guessed, and ridrs tries every companion it finds with it.
   */
  verifySecret(secret: string): 'ok' | 'unknown-secret' {
    const scanned = this.scanned;
    if (!scanned || scanned.secret !== secret || this.clock.now() >= scanned.until) {
      return 'unknown-secret';
    }
    this.scanned = undefined;
    return 'ok';
  }

  issueToken(clientName: string): string {
    const token = toHex(this.randomBytes(16));
    this.pairings.push({ token, clientName });
    this.persist();
    return token;
  }

  verifyToken(token: string): boolean {
    return this.find(token) !== undefined;
  }

  find(token: string): PairedClient | undefined {
    return this.pairings.find((p) => p.token === token);
  }

  list(): readonly PairedClient[] {
    return this.pairings;
  }

  /** A deliberate disconnect (`by` set) or its end (`undefined`); kept across restarts. */
  setPaused(token: string, by: 'ridrs' | 'companion' | undefined): void {
    this.pairings = this.pairings.map((p) =>
      p.token === token ? { token: p.token, clientName: p.clientName, pausedBy: by } : p,
    );
    this.persist();
  }

  /** Revokes one pairing: that ridrs has to pair again. */
  forget(token: string): void {
    this.pairings = this.pairings.filter((p) => p.token !== token);
    this.persist();
  }

  /** Revokes every issued token: each ridrs has to pair again. */
  forgetAll(): void {
    this.pairings = [];
    this.persist();
  }

  private persist(): void {
    this.store.save({ companionId: this.companionId, pairings: this.pairings });
  }
}
