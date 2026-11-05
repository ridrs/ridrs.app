// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  bridgeCompanionsChangedEvent,
  bridgePairingOfferEvent,
  bridgePairRequestedEvent,
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

/** The look of the device setup around it (`ui-devices`): dark tiles and fields. */
const COLORS = { line: '#1f3447', muted: '#8b9db2', field: '#06121c' } as const;

/** The code the companion shows has six digits. */
const CODE_LENGTH = 6;

const TILE = {
  flex: '1 1 150px',
  minWidth: 0,
  display: 'grid',
  alignContent: 'start',
  justifyItems: 'center',
  gap: 10,
  padding: 12,
  borderRadius: 12,
  border: `1px solid ${COLORS.line}`,
} as const;

const HEADING = { margin: 0, fontSize: 15, fontWeight: 700 } as const;

/**
 * Code entry for a companion found in the network: the code the phone shows. The sixth digit
 * pairs, with nothing to press; Enter tries a full code again.
 */
function PairForm({
  companion,
  onPair,
}: {
  readonly companion: Companion;
  readonly onPair: (address: string, code: string) => void;
}) {
  const [code, setCode] = useState('');
  const pair = (full: string) => {
    if (full.length === CODE_LENGTH) {
      onPair(companion.address, full);
    }
  };
  const change = (value: string) => {
    const next = value.replace(/\D/g, '').slice(0, CODE_LENGTH);
    setCode(next);
    if (next !== code) {
      pair(next);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    pair(code);
  };
  return (
    <form onSubmit={submit} style={{ width: '100%', display: 'grid', gap: 6 }}>
      <span
        style={{
          color: COLORS.muted,
          fontSize: 13,
          textAlign: 'center',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {companion.name}
      </span>
      <input
        aria-label={`Pairing code for ${companion.name}`}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern={`[0-9]{${CODE_LENGTH}}`}
        maxLength={CODE_LENGTH}
        placeholder={'0'.repeat(CODE_LENGTH)}
        value={code}
        onChange={(e) => change(e.target.value)}
        style={{
          boxSizing: 'border-box',
          width: '100%',
          padding: '8px 0',
          textAlign: 'center',
          font: '700 20px ui-monospace, monospace',
          letterSpacing: 4,
          color: '#fff',
          background: COLORS.field,
          border: `1.5px solid ${COLORS.line}`,
          borderRadius: 10,
        }}
      />
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
      style={{ width: 132, height: 132, background: '#fff', borderRadius: 8 }}
    />
  );
}

/**
 * Pairing with a companion phone, in the companion's details of the device setup: two ways side
 * by side, the QR code the phone scans or the code the phone shows, for each companion found.
 * Nothing once a companion is paired; the setup shows its status and its buttons.
 */
function BridgePairingView({ ctx }: { readonly ctx: UiContext }) {
  const [companions, setCompanions] = useState<readonly Companion[]>([]);
  const [offer, setOffer] = useState<string | null>(null);
  useEffect(
    () =>
      ctx.events.subscribe(bridgeCompanionsChangedEvent, ({ payload }) =>
        setCompanions(payload.companions),
      ),
    [ctx],
  );
  useEffect(
    () => ctx.events.subscribe(bridgePairingOfferEvent, ({ payload }) => setOffer(payload.uri)),
    [ctx],
  );

  if (!offer) {
    return null;
  }
  const pair = (address: string, code: string) =>
    ctx.events.publish(bridgePairRequestedEvent, { address, code });
  return (
    <section
      data-testid="bridge-pairing"
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 10 }}
    >
      <div role="group" aria-label="Scan the QR code" style={TILE}>
        <h4 style={HEADING}>Scan the QR code</h4>
        <PairingQr uri={offer} />
      </div>
      <span
        aria-hidden
        style={{ alignSelf: 'center', color: COLORS.muted, fontSize: 13, fontStyle: 'normal' }}
      >
        or
      </span>
      <div role="group" aria-label="Enter the code" style={TILE}>
        <h4 style={HEADING}>Enter the code</h4>
        {companions.map((c) => (
          <PairForm key={c.address} companion={c} onPair={pair} />
        ))}
        {companions.length === 0 && (
          <span style={{ color: COLORS.muted, fontSize: 13, textAlign: 'center' }}>
            Looking for phones on this Wi-Fi…
          </span>
        )}
      </div>
    </section>
  );
}

export const BridgePairing: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<BridgePairingView ctx={ctx} />);
  return () => root.unmount();
};
