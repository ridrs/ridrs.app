// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  bleTransportRequestedEvent,
  type BridgeState,
  bridgeCompanionsChangedEvent,
  bridgeConnectRequestedEvent,
  bridgeDisconnectRequestedEvent,
  bridgeForgetRequestedEvent,
  bridgePairingOfferEvent,
  bridgePairRequestedEvent,
  bridgeStateChangedEvent,
} from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { type FormEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderSVG } from 'uqr';

interface Companion {
  readonly companionId: string;
  readonly name: string;
  readonly address: string;
  readonly paired: boolean;
}

const STATE_TEXT: Record<BridgeState, string> = {
  unpaired: 'No companion paired',
  connecting: 'Connecting to',
  connected: 'Connected to',
  reconnecting: 'Reconnecting to',
  unreachable: 'Cannot reach',
  disconnected: 'Disconnected from',
  rejected: 'Pairing failed',
};

const REASON_TEXT: Record<string, string> = {
  'bad-code': 'wrong code',
  'bad-token': 'pairing was revoked',
  locked: 'too many wrong codes, wait a minute',
  incompatible: 'app versions do not match',
  busy: 'the companion is in use by another ridrs',
  unreachable: 'companion not reachable',
  'by-ridrs': 'by ridrs',
  'by-companion': 'on the phone',
  refused: 'the companion app is not open on the phone',
  network: 'not in this network',
  timeout: 'no answer',
  error: 'connection failed',
};

/** What the rider can check when the companion cannot be reached. */
const UNREACHABLE_HINT: Record<string, string> = {
  refused: 'Open the ridrs companion on the phone and keep its screen on.',
  network:
    'Phone and this device need the same Wi-Fi. On a Mac, allow ridrs under System Settings › Privacy & Security › Local Network.',
  timeout: 'Phone and this device need the same Wi-Fi, and the companion app must be open.',
  error: 'Open the ridrs companion on the phone; ridrs keeps trying.',
};

const box = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  minWidth: 320,
  padding: 16,
  borderRadius: 12,
  border: '1px solid rgba(0, 0, 0, 0.15)',
  fontFamily: 'system-ui, sans-serif',
} as const;

/** Code entry for a companion found in the network: the code the phone shows. */
function PairForm({
  companion,
  onPair,
}: {
  readonly companion: Companion;
  readonly onPair: (address: string, code: string) => void;
}) {
  const [code, setCode] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (code.trim()) {
      onPair(companion.address, code.trim());
    }
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <span style={{ flex: 1 }}>{companion.name}</span>
      <input
        aria-label={`Pairing code for ${companion.name}`}
        inputMode="numeric"
        placeholder="Code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        size={7}
      />
      <button type="submit">Pair</button>
    </form>
  );
}

/** The pairing QR code; the companion app scans it. The URI stays readable for tests and tools. */
function PairingQr({ uri }: { readonly uri: string }) {
  const svg = renderSVG(uri, { ecc: 'M', border: 2, pixelSize: 6 });
  return (
    <img
      data-testid="pairing-qr"
      data-uri={uri}
      alt="Pairing QR code: scan it with the ridrs companion app"
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      style={{ width: 200, height: 200, alignSelf: 'center', background: '#fff', borderRadius: 8 }}
    />
  );
}

function BridgePairingView({ ctx }: { readonly ctx: UiContext }) {
  const [companions, setCompanions] = useState<readonly Companion[]>([]);
  const [state, setState] = useState<{
    state: BridgeState;
    companionName?: string;
    reason?: string;
  }>();

  useEffect(
    () =>
      ctx.events.subscribe(bridgeCompanionsChangedEvent, ({ payload }) =>
        setCompanions(payload.companions),
      ),
    [ctx],
  );
  useEffect(
    () => ctx.events.subscribe(bridgeStateChangedEvent, ({ payload }) => setState(payload)),
    [ctx],
  );
  const [offer, setOffer] = useState<string | null>(null);
  useEffect(
    () => ctx.events.subscribe(bridgePairingOfferEvent, ({ payload }) => setOffer(payload.uri)),
    [ctx],
  );

  const pair = (address: string, code: string) =>
    ctx.events.publish(bridgePairRequestedEvent, { address, code });
  const connect = () => ctx.events.publish(bridgeConnectRequestedEvent, {});
  const disconnect = () => ctx.events.publish(bridgeDisconnectRequestedEvent, {});
  const forget = () => ctx.events.publish(bridgeForgetRequestedEvent, {});

  // Without bridge events the companion transport is not running: this device's Bluetooth is used.
  if (!state) {
    return (
      <section data-testid="bridge-pairing" data-state="local" style={box}>
        <strong>Bluetooth</strong>
        <div data-testid="bridge-status">Using this device's Bluetooth</div>
        <button
          type="button"
          onClick={() => ctx.events.publish(bleTransportRequestedEvent, { transport: 'bridge' })}
        >
          Use a companion phone
        </button>
      </section>
    );
  }

  const status = [
    STATE_TEXT[state.state],
    state.companionName,
    state.reason ? `(${REASON_TEXT[state.reason] ?? state.reason})` : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section data-testid="bridge-pairing" data-state={state.state} style={box}>
      <strong>Companion</strong>
      <div data-testid="bridge-status">{status}</div>
      {state.state === 'unreachable' && (
        <div style={{ opacity: 0.8 }}>
          {UNREACHABLE_HINT[state.reason ?? 'error'] ?? UNREACHABLE_HINT.error} ridrs keeps
          trying.
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {state.state === 'connected' && (
          <button type="button" onClick={disconnect}>
            Disconnect
          </button>
        )}
        {state.state === 'disconnected' && (
          <button type="button" onClick={connect}>
            Connect
          </button>
        )}
        {state.state === 'unreachable' && (
          <button type="button" onClick={connect}>
            Try again
          </button>
        )}
        {!offer && (
          <button type="button" onClick={forget}>
            Forget companion
          </button>
        )}
      </div>
      {offer && (
        <>
          <div>Open the ridrs companion on your phone and scan this code:</div>
          <PairingQr uri={offer} />
          {companions.length > 0 && <div>Or enter the code shown on the phone:</div>}
          {companions.map((c) => (
            <PairForm key={c.address} companion={c} onPair={pair} />
          ))}
          {companions.length === 0 && (
            <div style={{ opacity: 0.7 }}>
              Looking for the companion in this network… Phone and this device need the same Wi-Fi.
            </div>
          )}
        </>
      )}
      <button
        type="button"
        onClick={() => ctx.events.publish(bleTransportRequestedEvent, { transport: 'local' })}
      >
        Use this device's Bluetooth
      </button>
    </section>
  );
}

export const BridgePairing: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<BridgePairingView ctx={ctx} />);
  return () => root.unmount();
};
