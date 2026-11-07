// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type RecoverableRide,
  recordingContinueService,
  recordingFinishService,
  recordingRecoverableState,
} from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

const CSS = `
.rr-card { display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
  padding: 18px 24px; border: 1.5px solid var(--ridrs-warn, #ffb62e); border-radius: var(--ridrs-radius, 16px);
  background: var(--ridrs-surface, #0a1520);
  color: #fff; font: 500 14px system-ui, sans-serif; }
.rr-title { font-size: 18px; font-weight: 700; }
.rr-facts { color: #8b9db2; }
.rr-actions { display: flex; gap: 12px; }
.rr-button { padding: 10px 20px; border: 1.5px solid #1f3447; border-radius: 999px;
  background: #0a1520; color: #fff; font: 600 15px system-ui, sans-serif; cursor: pointer; }
.rr-button.rr-primary { border-color: #27c8ff; }
.rr-button:hover { border-color: #27c8ff; }
.rr-button:focus-visible { outline: 2px solid #8dff2a; outline-offset: 2px; }
`;

function facts(ride: RecoverableRide): string {
  const minutes = Math.max(0, Math.round((ride.lastRecordAt - ride.startedAt) / 60_000));
  const distance = ride.distance === undefined ? '' : ` · ${(ride.distance / 1000).toFixed(2)} km`;
  return `${minutes} min${distance}`;
}

/**
 * The interrupted ride on offer (ADR 0057): Continue ride or Finish ride, Continue focused first,
 * so Enter continues. The composition root continues it; the recorder finishes it.
 */
function InterruptedRideView({ ctx }: { readonly ctx: UiContext }) {
  const [ride, setRide] = useState<RecoverableRide>();
  const [asked, setAsked] = useState(false);
  const continueButton = useRef<HTMLButtonElement>(null);

  // App state (ADR 0069): the ride on offer, if any.
  useLayoutEffect(
    () =>
      ctx.state.watch(recordingRecoverableState, ({ entries }) => {
        setRide([...entries.values()][0]);
        setAsked(false);
      }),
    [ctx],
  );
  const ask = (call: () => Promise<unknown>) => {
    setAsked(true);
    call().catch((error: unknown) => {
      ctx.logger.warn('The interrupted ride could not be handled', error);
      setAsked(false);
    });
  };
  useLayoutEffect(() => {
    if (ride) {
      continueButton.current?.focus();
    }
  }, [ride]);

  if (!ride) {
    return null;
  }
  return (
    <section className="rr-card" aria-label="Interrupted ride">
      <style>{CSS}</style>
      <div className="rr-title">Your last ride was interrupted</div>
      <div className="rr-facts">{facts(ride)}</div>
      <div className="rr-actions">
        <button
          ref={continueButton}
          type="button"
          className="rr-button rr-primary"
          disabled={asked}
          onClick={() => ask(() => ctx.call(recordingContinueService, { sessionId: ride.sessionId }))}
        >
          Continue ride
        </button>
        <button
          type="button"
          className="rr-button"
          disabled={asked}
          onClick={() => ask(() => ctx.call(recordingFinishService, { key: ride.sessionId }))}
        >
          Finish ride
        </button>
      </div>
    </section>
  );
}

export const InterruptedRide: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<InterruptedRideView ctx={ctx} />);
  return () => root.unmount();
};
