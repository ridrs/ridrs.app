// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type Language,
  type RecoverableRide,
  recordingContinueService,
  recordingFinishService,
  recordingRecoverableState,
} from '@ridrs/contracts';
import { localizeNumber, type UiComponent, type UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages } from '@ridrs/ui-sdk/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type Messages, messages } from './i18n/index.ts';

const CSS = `
.rr-card { display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
  padding: 18px 24px; border: 0; border-radius: var(--ridrs-radius-lg); box-shadow: inset 0 0 0 1px var(--ridrs-warn);
  background: var(--ridrs-card-quiet);
  color: var(--ridrs-text); font: 500 14px var(--ridrs-font-text); }
.rr-title { font-size: 18px; font-weight: 500; }
.rr-facts { color: var(--ridrs-text-muted); }
.rr-actions { display: flex; gap: 12px; }
.rr-button { padding: 10px 20px; border: 0; border-radius: var(--ridrs-radius); box-shadow: var(--ridrs-edge);
  background: var(--ridrs-surface-raised); color: var(--ridrs-text); font: 500 var(--ridrs-size-body) var(--ridrs-font-text); cursor: pointer; }
.rr-button.rr-primary { background: var(--ridrs-accent); box-shadow: none; color: var(--ridrs-accent-text); }
`;

function facts(ride: RecoverableRide, text: Messages, language: Language): string {
  const minutes = Math.max(0, Math.round((ride.lastRecordAt - ride.startedAt) / 60_000));
  const km = ride.distance === undefined ? undefined : localizeNumber((ride.distance / 1000).toFixed(2), language);
  return text.facts(minutes, km);
}

/**
 * The interrupted ride on offer (ADR 0057): Continue ride or Finish ride, Continue focused first,
 * so Enter continues. The composition root continues it; the recorder finishes it.
 */
function InterruptedRideView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
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
    <section className="rr-card" aria-label={text.title}>
      <style>{CSS}</style>
      <div className="rr-title">{text.interrupted}</div>
      <div className="rr-facts">{facts(ride, text, language)}</div>
      <div className="rr-actions">
        <button
          ref={continueButton}
          type="button"
          className="rr-button rr-primary"
          disabled={asked}
          onClick={() => ask(() => ctx.call(recordingContinueService, { sessionId: ride.sessionId }))}
        >
          {text.continue}
        </button>
        <button
          type="button"
          className="rr-button"
          disabled={asked}
          onClick={() => ask(() => ctx.call(recordingFinishService, { key: ride.sessionId }))}
        >
          {text.finish}
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
