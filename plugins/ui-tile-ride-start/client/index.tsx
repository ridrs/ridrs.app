// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStartRequestedEvent,
  athleteProfileState,
  type Bicycle,
  DEFAULT_PROVIDER,
  dataSourceState,
  equipmentBicycleChangedEvent,
} from '@ridrs/contracts';
import { localizeNumber, type UiComponent, type UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { messages } from './i18n/index.ts';
import { RideSaved } from './ride-saved.tsx';

/** From Lucide (ISC, see the folder's LICENSE), painted as a mask in the text colour. */
const PLAY = new URL('./assets/icons/play.svg', import.meta.url).href;

/** Drawn with the main screen's tokens (ADR 0058); the fallbacks keep it readable without them. */
const CSS = `
.rs-tile { display: flex; flex-direction: column; justify-content: flex-end; gap: 20px; height: 100%;
  min-height: 240px; padding: 28px 32px; border: 1px solid var(--ridrs-line, #24324d);
  border-radius: var(--ridrs-radius, 16px); color: var(--ridrs-text, #f2f5fa);
  background: radial-gradient(120% 140% at 85% 0%, #2b3f74 0%, transparent 60%),
    linear-gradient(160deg, var(--ridrs-surface-raised, #1a2540), var(--ridrs-surface, #131c2e)); }
.rs-eyebrow { margin: 0; color: var(--ridrs-text-muted, #93a1b8); font-size: 14px; font-weight: 600;
  letter-spacing: .08em; text-transform: uppercase; }
.rs-title { margin: 4px 0 0; font-size: 32px; font-weight: 800; line-height: 1.15; }
.rs-text { margin: 8px 0 0; color: var(--ridrs-text-muted, #93a1b8); font-size: 16px; }
.rs-start { display: inline-flex; align-items: center; gap: 12px; align-self: flex-start;
  padding: 16px 36px; border: 0; border-radius: 999px; cursor: pointer;
  background: var(--ridrs-accent, #b8f53b); color: var(--ridrs-accent-text, #0b1220);
  font: 700 22px system-ui, sans-serif; }
.rs-start:hover { filter: brightness(1.08); }
.rs-start:focus-visible { outline: 3px solid var(--ridrs-focus, #fff); outline-offset: 3px; }
.rs-play { width: 22px; height: 22px; background: currentColor;
  mask: url("${PLAY}") center / contain no-repeat; -webkit-mask: url("${PLAY}") center / contain no-repeat; }
.rs-tile [data-testid="ride-saved"], .rs-tile [data-testid="ride-not-saved"] { padding-top: 16px;
  border-top: 1px solid var(--ridrs-line, #24324d); text-align: left !important; font-size: 15px !important; }
.rs-tile code { color: var(--ridrs-text-muted, #93a1b8); }
.rs-riding { margin: 6px 0 0; color: var(--ridrs-text, #f2f5fa); font-size: 15px; font-weight: 600; }
`;

/**
 * Whether the athlete profile in use cannot be read and has no values to fall back on: the next
 * ride then uses the defaults (ADR 0073). Not so while there is no provider at all.
 */
function useProfileUnavailable(ctx: UiContext): boolean {
  const providers = useStateEntries(ctx, athleteProfileState);
  const chosen = useStateEntries(ctx, dataSourceState).get('athlete.profile')?.provider;
  const source = providers.get(chosen ?? DEFAULT_PROVIDER);
  return source?.status === 'unavailable' && source.data === undefined;
}

/** Start ride, the main action of the main screen, and what became of the last ride. */
function RideStartView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  // The bicycle the next ride is ridden with, from the garage (ADR 0060); none without one.
  const [bicycle, setBicycle] = useState<Bicycle>();
  useEffect(
    () => ctx.events.subscribe(equipmentBicycleChangedEvent, ({ payload }) => setBicycle(payload)),
    [ctx],
  );
  const profileUnavailable = useProfileUnavailable(ctx);
  return (
    <section className="rs-tile" aria-label={text.ride}>
      <style>{CSS}</style>
      <div>
        <p className="rs-eyebrow">{text.freeRide}</p>
        <h2 className="rs-title">{text.ready}</h2>
        <p className="rs-text">{text.about}</p>
        {bicycle ? (
          <p className="rs-riding" data-testid="riding">
            {text.riding(bicycle.name, localizeNumber(bicycle.mass.toFixed(1), language))}
          </p>
        ) : null}
        {profileUnavailable ? (
          <p className="rs-riding" data-testid="athlete-note">
            {text.profileUnavailable}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        className="rs-start"
        data-testid="start-ride"
        onClick={() => ctx.events.publish(activityStartRequestedEvent, {})}
      >
        <span className="rs-play" aria-hidden="true" />
        {text.start}
      </button>
      <RideSaved ctx={ctx} />
    </section>
  );
}

export const RideStartTile: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<RideStartView ctx={ctx} />);
  return () => root.unmount();
};
