// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode, useEffect, useState } from 'react';
import type { Companion, CompanionView } from './companion.ts';
import type { Messages } from './i18n/index.ts';
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

function NameEditor({ name, text }: { readonly name: string; readonly text: Messages }) {
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
        aria-label={text.companionName}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        style={{ flex: 1 }}
      />
      <button type="submit" disabled={!changed}>
        {text.rename}
      </button>
    </form>
  );
}

export function CompanionScreen({
  companion,
  text,
  dummyPanel,
}: {
  readonly companion: Companion;
  /** The texts in the phone's language. */
  readonly text: Messages;
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
        setScanError(text.notAPairingCode);
      }
    } catch (error) {
      setScanError(text.scanFailed(String(error)));
    }
  };
  const scanMessage = scanError ?? (view.scannedFor ? text.scanned(view.scannedFor) : undefined);

  return (
    <main style={{ maxWidth: 520, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, margin: '0 0 12px' }}>
        {text.title}
        {dummyPanel && (
          <span style={{ ...muted, marginLeft: 8, color: '#f5b942' }}>{text.developerBuild}</span>
        )}
      </h1>

      {view.status.pairings.length > 0 && (
        <section style={card} data-testid="pairings">
          {view.status.pairings.map((p) => (
            <div key={p.token} data-testid="paired-ridrs" data-state={p.state}>
              <div>
                {p.clientName}:{' '}
                {p.state === 'connected'
                  ? text.connected
                  : p.state === 'disconnected'
                    ? p.pausedBy === 'companion'
                      ? text.disconnectedHere
                      : text.disconnectedInRidrs
                    : text.waiting}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                {p.state === 'connected' && (
                  <button type="button" onClick={() => companion.disconnect(p.token)}>
                    {text.disconnect}
                  </button>
                )}
                {p.state === 'disconnected' && (
                  <button type="button" onClick={() => companion.connect(p.token)}>
                    {text.connect}
                  </button>
                )}
                <button type="button" onClick={() => companion.forget(p.token)}>
                  {text.forget}
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section style={card} data-testid="pairing">
        {connected ? (
          <div style={muted}>{text.pairedAndConnected}</div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void scan()}
              style={{ fontSize: 20, padding: '14px 18px', width: '100%', borderRadius: 12 }}
            >
              {text.scan}
            </button>
            {scanMessage && (
              <div data-testid="scan-message" style={{ marginTop: 8 }}>
                {scanMessage}
              </div>
            )}
            <div style={{ ...muted, marginTop: 12 }}>{text.orEnter}</div>
            <div
              data-testid="pairing-code"
              style={{ fontSize: 40, fontWeight: 700, letterSpacing: '0.15em' }}
            >
              {view.code}
            </div>
          </>
        )}
        {view.serve.addresses.length > 0 ? (
          <div style={muted}>{text.findsIn(view.name, view.serve.addresses.join(', '))}</div>
        ) : (
          <div style={{ color: '#f5b942' }}>{text.noWifi}</div>
        )}
      </section>

      <section style={card} data-testid="status">
        <div data-testid="client">
          {connected ? text.forwardingTo(view.status.client ?? '') : text.notForwarding}
        </div>
        <div style={muted}>
          {text.counts(view.status.connectedPeripherals.length, view.status.subscriptions, rate)}
        </div>
      </section>

      {dummyPanel && <section style={card}>{dummyPanel}</section>}

      <section style={card}>
        <NameEditor name={view.name} text={text} />
        <div style={{ ...muted, marginTop: 12 }}>{text.keepOpen}</div>
      </section>
    </main>
  );
}
