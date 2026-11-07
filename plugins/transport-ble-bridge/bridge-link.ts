// SPDX-License-Identifier: AGPL-3.0-or-later

import { BridgeGoodbyeError, BridgeRejectedError, BridgeSession } from '@ridrs/ble-bridge';
import {
  type BleBridgeConnector,
  type BleCentral,
  type BleConnection,
  type BleDiscoveredPeripheral,
  type BleScanOptions,
  type BridgeState,
  type CompanionAdvert,
  formatPairingUri,
  type PluginContext,
  type StoredBridgePairing,
  bridgeCompanionsState,
  bridgeConnectService,
  bridgeDisconnectService,
  bridgeForgetService,
  bridgeLinkState,
  bridgePairingState,
  bridgePairService,
} from '@ridrs/contracts';

const CLIENT_NAME = 'ridrs';

/** Reconnect backoff in the local network: quick first tries, then every 5 s. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 5000;
/** "Connecting" never lasts longer than this: then ridrs says the companion is unreachable. */
const UNREACHABLE_AFTER_MS = 30_000;
/** While deliberately disconnected, how often ridrs asks whether the phone wants to connect. */
const PAUSED_PROBE_MS = 3000;
/** How often an unpaired ridrs tries the found companions with its QR code secret. */
const OFFER_RETRY_MS = 2000;
/** How often a forget that the companion has not heard yet is retried. */
const FORGET_RETRY_MS = 3000;

type Mode =
  | { readonly kind: 'unpaired' }
  /** A code entered by hand is being tried. */
  | { readonly kind: 'pairing' }
  /** Paired, not connected, trying: `connecting` / `reconnecting`, `unreachable` after 30 s. */
  | { readonly kind: 'linking'; readonly since: number; failures: number }
  /** Deliberately disconnected; the companion holds the pause and lifts it on Connect. */
  | { readonly kind: 'paused'; readonly by: 'ridrs' | 'companion' }
  | { readonly kind: 'connected' };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why a companion could not be reached, as the UI explains it. */
function unreachableReason(error: unknown): string {
  if (error instanceof BridgeRejectedError) {
    return error.reason;
  }
  const text = errorMessage(error).toLowerCase();
  if (text.includes('refused')) {
    return 'refused';
  }
  if (/no route|unreachable|os error (51|65)|permission denied/.test(text)) {
    return 'network';
  }
  if (text.includes('timed out') || text.includes('timeout')) {
    return 'timeout';
  }
  return 'error';
}

function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * The ridrs side of the companion bridge as an explicit state machine. Every state has a way
 * out for the rider (pair, connect, disconnect, forget), "connecting" ends after 30 s in
 * "unreachable", and deliberate ends are announced (`bye`) so both devices show the same.
 * Exposes the session as a stable `BleCentral`: scans wait for a session, connects wait for
 * the attempt in flight.
 */
export class BridgeLink {
  readonly central: BleCentral;
  private connector?: BleBridgeConnector;
  private session?: BridgeSession;
  private mode: Mode = { kind: 'unpaired' };
  private published?: string;
  private adverts: readonly CompanionAdvert[] = [];
  /** Bumped on every mode change: answers to older attempts are dropped. */
  private generation = 0;
  private attemptTimer?: ReturnType<typeof setTimeout>;
  private unreachableTimer?: ReturnType<typeof setTimeout>;
  private forgetTimer?: ReturnType<typeof setTimeout>;
  private attemptInFlight = false;
  /** The next attempt lifts a deliberate disconnect: the rider pressed Connect in ridrs. */
  private resumeNext = false;
  private lastFailure?: unknown;
  /** Set right before ridrs ends the session itself. */
  private endingAs?: 'disconnect' | 'forget';
  private offer?: { readonly secret: string; readonly timer: ReturnType<typeof setInterval> };
  private readonly offerAttempts = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private readonly cleanups: Array<() => void> = [];
  private stopped = false;

  constructor(private readonly ctx: PluginContext) {
    this.central = {
      route: 'companion',
      scan: (options) => this.scan(options),
      connect: (peripheralId, options) => this.connect(peripheralId, options),
    };
  }

  start(connector: BleBridgeConnector): void {
    this.connector = connector;
    // The rider's requests are services (ADR 0069): never in a journal, never done again.
    this.ctx.services.provide(bridgePairService, ({ address, code }) => {
      void this.pair(address, code);
      return {};
    });
    this.ctx.services.provide(bridgeConnectService, () => {
      this.requestConnect();
      return {};
    });
    this.ctx.services.provide(bridgeDisconnectService, () => {
      this.requestDisconnect();
      return {};
    });
    this.ctx.services.provide(bridgeForgetService, () => {
      this.requestForget();
      return {};
    });
    this.cleanups.push(
      connector.watchCompanions((adverts) => {
        this.adverts = adverts;
        this.publishCompanions();
      }),
    );
    const pairing = connector.loadPairing();
    if (pairing?.forgotten) {
      this.deliverForget();
      this.enterUnpaired();
    } else if (pairing) {
      this.enterLinking('connecting');
    } else {
      this.enterUnpaired();
    }
  }

  stop(): void {
    this.withdrawOffer();
    this.stopped = true;
    this.generation += 1;
    clearTimeout(this.attemptTimer);
    clearTimeout(this.unreachableTimer);
    clearTimeout(this.forgetTimer);
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
    this.session?.close();
    this.session = undefined;
    this.wake();
  }

  // ---- BleCentral facade ----------------------------------------------------------------------

  private async *scan(options: BleScanOptions): AsyncIterable<BleDiscoveredPeripheral> {
    const { signal } = options;
    while (!signal?.aborted && !this.stopped) {
      const session = this.session;
      if (!session) {
        await this.nextChange(signal);
        continue;
      }
      yield* session.scan(options);
      // The session ended mid-scan: scan again on the next one.
    }
  }

  private async connect(
    peripheralId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<BleConnection> {
    if (!this.session && this.mode.kind === 'linking' && this.published !== 'unreachable') {
      await this.nextChange(options?.signal);
    }
    const session = this.session;
    if (!session) {
      throw new Error('The companion bridge is not connected');
    }
    return session.connect(peripheralId, options);
  }

  private nextChange(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) {
      waiter();
    }
  }

  // ---- The rider's requests -----------------------------------------------------------------

  private requestConnect(): void {
    const pairing = this.pairing();
    if (!pairing || this.mode.kind === 'connected') {
      return;
    }
    this.resumeNext = true;
    this.enterLinking('connecting');
  }

  private requestDisconnect(): void {
    if (this.session && this.mode.kind === 'connected') {
      this.endingAs = 'disconnect';
      this.session.bye('disconnect');
    }
  }

  private requestForget(): void {
    const pairing = this.pairing();
    if (!pairing) {
      return;
    }
    if (this.session) {
      this.endingAs = 'forget';
      this.connector?.clearPairing();
      this.session.bye('forget');
      return;
    }
    // The companion is not reachable now: forget here at once, tell the companion later.
    this.connector?.savePairing({ ...pairing, forgotten: true });
    this.enterUnpaired();
    this.deliverForget();
  }

  // ---- Modes ----------------------------------------------------------------------------------

  private enterUnpaired(state: 'unpaired' | 'rejected' = 'unpaired', reason?: string): void {
    this.setMode({ kind: 'unpaired' });
    this.publish(state, reason ? { reason } : {});
  }

  private enterLinking(state: 'connecting' | 'reconnecting'): void {
    this.setMode({ kind: 'linking', since: this.ctx.clock.now(), failures: 0 });
    this.lastFailure = undefined;
    this.publish(state, { companionName: this.pairing()?.companionName });
    const generation = this.generation;
    this.unreachableTimer = setTimeout(() => {
      if (this.generation === generation && this.mode.kind === 'linking') {
        this.publishUnreachable();
      }
    }, UNREACHABLE_AFTER_MS);
    this.scheduleAttempt(0);
  }

  private enterPaused(by: 'ridrs' | 'companion'): void {
    if (this.mode.kind !== 'paused' || this.mode.by !== by) {
      this.setMode({ kind: 'paused', by });
    }
    this.publish('disconnected', {
      companionName: this.pairing()?.companionName,
      reason: by === 'ridrs' ? 'by-ridrs' : 'by-companion',
    });
    this.scheduleAttempt(PAUSED_PROBE_MS);
  }

  private adopt(session: BridgeSession, pairing: StoredBridgePairing): void {
    this.setMode({ kind: 'connected' });
    this.session = session;
    this.publish('connected', { companionName: pairing.companionName });
    this.publishCompanions();
    session.onClose(() => {
      if (this.session !== session) {
        return;
      }
      this.session = undefined;
      const endingAs = this.endingAs;
      this.endingAs = undefined;
      if (this.stopped) {
        return;
      }
      if (endingAs === 'disconnect') {
        this.enterPaused('ridrs');
      } else if (endingAs === 'forget') {
        this.enterUnpaired();
      } else if (session.byeReason === 'disconnect') {
        this.enterPaused('companion');
      } else if (session.byeReason === 'forget') {
        this.connector?.clearPairing();
        this.enterUnpaired();
      } else {
        this.ctx.logger.warn('companion bridge lost');
        this.enterLinking('reconnecting');
      }
      this.publishCompanions();
    });
    this.wake();
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.generation += 1;
    clearTimeout(this.attemptTimer);
    clearTimeout(this.unreachableTimer);
    if (mode.kind === 'unpaired' || mode.kind === 'pairing') {
      this.makeOffer();
    } else {
      this.withdrawOffer();
    }
    this.wake();
  }

  private pairing(): StoredBridgePairing | undefined {
    const pairing = this.connector?.loadPairing();
    return pairing && !pairing.forgotten ? pairing : undefined;
  }

  // ---- Connecting with the stored token -------------------------------------------------------

  private scheduleAttempt(delay: number): void {
    clearTimeout(this.attemptTimer);
    if (!this.stopped) {
      this.attemptTimer = setTimeout(() => void this.attempt(), delay);
    }
  }

  private async attempt(): Promise<void> {
    const connector = this.connector;
    const pairing = this.pairing();
    if (!connector || !pairing || this.attemptInFlight || this.session) {
      return;
    }
    const generation = this.generation;
    const intent = this.resumeNext ? 'resume' : 'reconnect';
    this.resumeNext = false;
    this.attemptInFlight = true;
    const address =
      this.adverts.find((a) => a.companionId === pairing.companionId)?.address ?? pairing.address;
    try {
      const session = await BridgeSession.open(await connector.open(address), {
        clock: this.ctx.clock,
        clientName: CLIENT_NAME,
        token: pairing.token,
        intent,
      });
      if (generation !== this.generation || this.stopped) {
        session.close();
        return;
      }
      const current = address === pairing.address ? pairing : { ...pairing, address };
      if (current !== pairing) {
        connector.savePairing(current);
      }
      this.adopt(session, current);
    } catch (error) {
      if (generation !== this.generation || this.stopped) {
        return;
      }
      if (error instanceof BridgeRejectedError && error.reason === 'bad-token') {
        // The companion forgot this ridrs (on the phone, or reinstalled): pair again.
        connector.clearPairing();
        this.ctx.reportDiagnostic('bridge-rejected', 'The companion no longer knows this ridrs', {
          companionId: pairing.companionId,
          reason: error.reason,
        });
        this.enterUnpaired();
        this.publishCompanions();
      } else if (error instanceof BridgeRejectedError && error.reason === 'paused') {
        this.enterPaused(error.pausedBy ?? 'companion');
      } else {
        this.failed(error, pairing);
      }
    } finally {
      this.attemptInFlight = false;
    }
  }

  private failed(error: unknown, pairing: StoredBridgePairing): void {
    this.lastFailure = error;
    if (this.mode.kind !== 'linking') {
      // Probing while paused: the phone is away; keep asking.
      this.scheduleAttempt(PAUSED_PROBE_MS);
      return;
    }
    this.mode.failures += 1;
    if (this.mode.failures === 1) {
      this.ctx.reportDiagnostic(
        'bridge-unreachable',
        `The companion "${pairing.companionName}" is not reachable: ${errorMessage(error)}`,
        { companionId: pairing.companionId },
      );
    }
    if (this.published === 'unreachable') {
      this.publishUnreachable();
    }
    this.wake();
    this.scheduleAttempt(Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (this.mode.failures - 1)));
  }

  private publishUnreachable(): void {
    this.publish('unreachable', {
      companionName: this.pairing()?.companionName,
      reason: this.lastFailure === undefined ? 'timeout' : unreachableReason(this.lastFailure),
    });
    this.wake();
  }

  /** Tells the companion about a forget it missed; ends once it knows (or knows no more). */
  private deliverForget(): void {
    clearTimeout(this.forgetTimer);
    const connector = this.connector;
    const pending = connector?.loadPairing();
    if (!connector || !pending?.forgotten || this.stopped) {
      return;
    }
    const address =
      this.adverts.find((a) => a.companionId === pending.companionId)?.address ?? pending.address;
    void (async () => {
      try {
        const session = await BridgeSession.open(await connector.open(address), {
          clock: this.ctx.clock,
          clientName: CLIENT_NAME,
          token: pending.token,
          intent: 'forget',
        });
        session.close();
      } catch (error) {
        const known =
          error instanceof BridgeGoodbyeError ||
          (error instanceof BridgeRejectedError && error.reason === 'bad-token');
        if (!known) {
          this.forgetTimer = setTimeout(() => this.deliverForget(), FORGET_RETRY_MS);
          return;
        }
      }
      if (connector.loadPairing()?.token === pending.token) {
        connector.clearPairing();
      }
    })();
  }

  // ---- Pairing by code ------------------------------------------------------------------------

  private async pair(address: string, code: string): Promise<void> {
    const connector = this.connector;
    if (!connector || this.stopped || this.mode.kind === 'connected') {
      return;
    }
    this.setMode({ kind: 'pairing' });
    const generation = this.generation;
    this.publish('connecting');
    try {
      const session = await BridgeSession.open(await connector.open(address), {
        clock: this.ctx.clock,
        clientName: CLIENT_NAME,
        pairingCode: code,
      });
      if (generation !== this.generation) {
        session.close();
        return;
      }
      const pairing: StoredBridgePairing = {
        companionId: session.welcome.companionId,
        companionName: session.welcome.companionName,
        address,
        token: session.welcome.token,
      };
      connector.savePairing(pairing);
      this.adopt(session, pairing);
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      const reason = error instanceof BridgeRejectedError ? error.reason : 'unreachable';
      this.ctx.reportDiagnostic(
        error instanceof BridgeRejectedError ? 'bridge-rejected' : 'bridge-unreachable',
        `Pairing with the companion at ${address} failed: ${errorMessage(error)}`,
        { address, reason },
      );
      this.enterUnpaired('rejected', reason);
    }
  }

  // ---- Pairing by QR code ---------------------------------------------------------------------

  /**
   * Shows a pairing QR code with a fresh secret and tries every found companion with it: only
   * the one whose phone scanned the code accepts. A code entered by hand works alongside.
   */
  private makeOffer(): void {
    if (this.offer || this.stopped) {
      return;
    }
    const secret = randomSecret();
    this.offer = {
      secret,
      timer: setInterval(() => this.tryOffer(secret), OFFER_RETRY_MS),
    };
    // The QR code holds the secret: app state, never on the bus (ADR 0069).
    this.ctx.state.set(bridgePairingState, this.ctx.manifest.id, {
      uri: formatPairingUri({ secret, name: CLIENT_NAME }),
    });
  }

  private withdrawOffer(): void {
    if (!this.offer) {
      return;
    }
    clearInterval(this.offer.timer);
    this.offer = undefined;
    if (!this.stopped) {
      this.ctx.state.remove(bridgePairingState, this.ctx.manifest.id);
    }
  }

  private tryOffer(secret: string): void {
    const connector = this.connector;
    for (const advert of this.adverts) {
      if (!connector || this.offerAttempts.has(advert.address)) {
        continue;
      }
      this.offerAttempts.add(advert.address);
      void (async () => {
        try {
          const session = await BridgeSession.open(await connector.open(advert.address), {
            clock: this.ctx.clock,
            clientName: CLIENT_NAME,
            pairingSecret: secret,
          });
          if (this.offer?.secret !== secret || this.session) {
            session.close();
            return;
          }
          const pairing: StoredBridgePairing = {
            companionId: session.welcome.companionId,
            companionName: session.welcome.companionName,
            address: advert.address,
            token: session.welcome.token,
          };
          connector.savePairing(pairing);
          this.adopt(session, pairing);
        } catch {
          // Not scanned on this companion (yet), busy, or unreachable: try again on the next tick.
        } finally {
          this.offerAttempts.delete(advert.address);
        }
      })();
    }
  }

  // ---- Events ---------------------------------------------------------------------------------

  /** Publishes the state; repeated identical states are not published again. */
  private publish(state: BridgeState, extra: { companionName?: string; reason?: string } = {}) {
    const payload = {
      state,
      ...(extra.companionName !== undefined ? { companionName: extra.companionName } : {}),
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    };
    const key = JSON.stringify(payload);
    if (this.stopped || key === this.publishedKey) {
      return;
    }
    this.publishedKey = key;
    this.published = state;
    this.ctx.state.set(bridgeLinkState, this.ctx.manifest.id, payload);
  }

  private publishedKey?: string;

  private publishCompanions(): void {
    if (this.stopped) {
      return;
    }
    const pairedId = this.pairing()?.companionId;
    this.ctx.state.set(bridgeCompanionsState, this.ctx.manifest.id, {
      companions: this.adverts.map((a) => ({
        companionId: a.companionId,
        name: a.name,
        address: a.address,
        paired: a.companionId !== '' && a.companionId === pairedId,
      })),
    });
  }
}
