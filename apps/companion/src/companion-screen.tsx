// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode, useEffect, useState } from 'react';
import type { Companion, CompanionView } from './companion.ts';
import { saveCompanionName, scanQrCode } from './platform.ts';

const card = {
  padding: 16,
  borderRadius: 14,
  background: 'rgba(255, 255, 255, 0.06)',
  marginBottom: 12,
} as const;

const muted = { opacity: 0.7, fontSize: 14 } as const;

function useCompanionView(companion: Companion): CompanionView {
  const [view, setView] = useState(() => companion.view());
  useEffect(() => companion.onChange(() => setView(companion.view())), [companion]);
  return view;
}

/** Notifications forwarded per second, from the running counter. */
/**
 * Notifications forwarded per second. Sampled from the companion every second: the counter
 * grows with every notification, while the status only announces changes of the connection.
 */
function useRate(companion: Companion): number {
  const [rate, setRate] = useState(0);
  useEffect(() => {
    let last = { total: companion.view().status.notificationsForwarded, at: Date.now() };
    const timer = setInterval(() => {
      const now = { total: companion.view().status.notificationsForwarded, at: Date.now() };
      setRate(Math.round(((now.total - last.total) * 1000) / Math.max(1, now.at - last.at)));
      last = now;
    }, 1000);
    return () => clearInterval(timer);
  }, [companion]);
  return rate;
}

function NameEditor({ name }: { readonly name: string }) {
  const [value, setValue] = useState(name);
  const changed = value.trim() !== '' && value.trim() !== name;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        saveCompanionName(value.trim());
        // The name is part of the mDNS announcement: restart the page to announce it again.
        window.location.reload();
      }}
      style={{ display: 'flex', gap: 8 }}
    >
      <input
        aria-label="Companion name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        style={{ flex: 1 }}
      />
      <button type="submit" disabled={!changed}>
        Rename
      </button>
    </form>
  );
}

export function CompanionScreen({
  companion,
  dummyPanel,
}: {
  readonly companion: Companion;
  /** Developer build only. */
  readonly dummyPanel?: ReactNode;
}) {
  const view = useCompanionView(companion);
  const rate = useRate(companion);
  const connected = view.status.client !== undefined;
  const [scanError, setScanError] = useState<string>();
  const scan = async () => {
    setScanError(undefined);
    try {
      if (!companion.acceptPairingQr(await scanQrCode())) {
        setScanError('That is not a ridrs pairing code. Scan the QR code ridrs shows.');
      }
    } catch (error) {
      setScanError(`Scanning failed: ${String(error)}`);
    }
  };
  const scanMessage =
    scanError ??
    (view.scannedFor ? `Scanned. Waiting for “${view.scannedFor}” to connect…` : undefined);

  return (
    <main style={{ maxWidth: 520, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, margin: '0 0 12px' }}>
        ridrs companion
        {dummyPanel && (
          <span style={{ ...muted, marginLeft: 8, color: '#f5b942' }}>developer build</span>
        )}
      </h1>

      {view.status.pairings.length > 0 && (
        <section style={card} data-testid="pairings">
          {view.status.pairings.map((p) => (
            <div key={p.token} data-testid="paired-ridrs" data-state={p.state}>
              <div>
                {p.clientName}:{' '}
                {p.state === 'connected'
                  ? 'connected'
                  : p.state === 'disconnected'
                    ? `disconnected ${p.pausedBy === 'companion' ? 'here' : 'in ridrs'}`
                    : 'not connected, waiting for it'}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                {p.state === 'connected' && (
                  <button type="button" onClick={() => companion.disconnect(p.token)}>
                    Disconnect
                  </button>
                )}
                {p.state === 'disconnected' && (
                  <button type="button" onClick={() => companion.connect(p.token)}>
                    Connect
                  </button>
                )}
                <button type="button" onClick={() => companion.forget(p.token)}>
                  Forget
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section style={card} data-testid="pairing">
        {connected ? (
          <div style={muted}>Paired and connected</div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void scan()}
              style={{ fontSize: 20, padding: '14px 18px', width: '100%', borderRadius: 12 }}
            >
              Scan ridrs QR code
            </button>
            {scanMessage && (
              <div data-testid="scan-message" style={{ marginTop: 8 }}>
                {scanMessage}
              </div>
            )}
            <div style={{ ...muted, marginTop: 12 }}>Or enter this code in ridrs:</div>
            <div
              data-testid="pairing-code"
              style={{ fontSize: 40, fontWeight: 700, letterSpacing: '0.15em' }}
            >
              {view.code}
            </div>
          </>
        )}
        {view.serve.addresses.length > 0 ? (
          <div style={muted}>
            ridrs finds “{view.name}” in the same Wi-Fi ({view.serve.addresses.join(', ')}).
          </div>
        ) : (
          <div style={{ color: '#f5b942' }}>No Wi-Fi address: connect the phone to Wi-Fi.</div>
        )}
      </section>

      <section style={card} data-testid="status">
        <div data-testid="client">
          {connected ? `Forwarding to ${view.status.client}` : 'Not forwarding'}
        </div>
        <div style={muted}>
          {view.status.connectedPeripherals.length} device(s) connected ·{' '}
          {view.status.subscriptions} subscription(s) · {rate} notifications/s
        </div>
      </section>

      {dummyPanel && <section style={card}>{dummyPanel}</section>}

      <section style={card}>
        <NameEditor name={view.name} />
        <div style={{ ...muted, marginTop: 12 }}>
          Keep this app open: the phone forwards Bluetooth only while its screen is on.
        </div>
      </section>
    </main>
  );
}
