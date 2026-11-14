// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  carries,
  DRAG_ROUTE,
  DRAG_WORKOUT,
  type DragData,
  draggedRouteSchema,
  draggedWorkoutSchema,
  NEXT_RIDE_KEY,
  type NextRide,
  nextRideSetService,
  nextRideState,
  type RideBriefing,
  readDragged,
  routeOfferState,
  trainingCalendarState,
  trainingLibraryState,
} from '@ridrs/contracts';
import { iconStyle, reactComponent } from '@ridrs/ui-preview';
import type { UiContext } from '@ridrs/ui-sdk';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { useEffect, useState } from 'react';
import { openBriefing } from './briefing.ts';
import { type Messages, messages } from './i18n/index.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as masks in the text colour. */
const WORKOUT = new URL('./assets/icons/dumbbell.svg', import.meta.url).href;
const ROUTE = new URL('./assets/icons/route.svg', import.meta.url).href;
const REMOVE = new URL('./assets/icons/x.svg', import.meta.url).href;
const PLAY = new URL('./assets/icons/play.svg', import.meta.url).href;

/**
 * Under the menu's entries (ADR 0096): two places to drop a workout and a route onto, and the
 * button that starts the ride through the briefing. Narrow (medium) the places are icons; on the
 * bottom bar (compact) the next ride is not shown.
 */
const CSS = `
.nr { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--ridrs-line, #24324d);
  border-radius: 14px; background: var(--ridrs-surface, #131c2e); color: var(--ridrs-text, #f2f5fa);
  font: 14px system-ui, sans-serif; }
.nr[data-armed] { border: 2px dashed var(--ridrs-info, #2aa8ff); padding: 11px; }
.nr[data-over] { border-style: solid; background: rgb(18 48 78 / .96); }
.nr-title { margin: 0; color: var(--ridrs-muted, #9aa8bf); font: 600 12px system-ui, sans-serif;
  letter-spacing: .08em; text-transform: uppercase; }
.nr-slot { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 6px 8px; border-radius: 10px;
  background: var(--ridrs-surface-2, #1c2840); }
.nr-slot[data-empty] { border: 1px dashed var(--ridrs-line, #24324d); background: transparent;
  color: var(--ridrs-muted, #9aa8bf); }
.nr-glyph { flex: none; width: 18px; height: 18px; background: currentColor;
  mask: var(--icon) center / contain no-repeat; -webkit-mask: var(--icon) center / contain no-repeat; }
.nr-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.nr-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.nr-fact { color: var(--ridrs-muted, #9aa8bf); font-size: 12px; }
.nr-fact[data-gone] { color: var(--ridrs-warn, #ffb020); }
.nr-remove { flex: none; display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0;
  border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }
.nr-remove:hover { background: var(--ridrs-surface, #131c2e); }
.nr-start { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 8px 12px;
  border: 0; border-radius: 10px; background: var(--ridrs-volt, #c8ff2e); color: #0b1220;
  font: 600 14px system-ui, sans-serif; cursor: pointer; }
.nr-start:disabled { background: var(--ridrs-surface-2, #1c2840); color: var(--ridrs-muted, #9aa8bf); cursor: default; }
.nr button:focus-visible { outline: 3px solid var(--ridrs-focus, #fff); outline-offset: 2px; }
.nr-hidden, [data-breakpoint="medium"] .nr-title, [data-breakpoint="medium"] .nr-text,
[data-breakpoint="medium"] .nr-start-label { position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; }
[data-breakpoint="medium"] .nr { align-items: center; padding: 8px 4px; }
[data-breakpoint="medium"] .nr-slot { justify-content: center; width: 44px; padding: 6px 0; }
[data-breakpoint="medium"] .nr-remove { display: none; }
[data-breakpoint="medium"] .nr-start { width: 44px; padding: 8px 0; }
[data-breakpoint="compact"] [data-next-ride] { display: none; }
`;

/** What the next ride holds after a drop of `data`: the dropped workout or route in its place. */
function dropped(current: NextRide, data: DragData | null): NextRide | undefined {
  const workout = readDragged(data, DRAG_WORKOUT, draggedWorkoutSchema);
  const route = readDragged(data, DRAG_ROUTE, draggedRouteSchema);
  if (!workout && !route) return undefined;
  return { ...current, ...(workout ? { workout } : {}), ...(route ? { route } : {}) };
}

/** Whether a drag carries something the next ride takes: all a target sees while it hovers. */
const takes = (data: DragData | null) => carries(data, DRAG_WORKOUT) || carries(data, DRAG_ROUTE);

/** What "Start next ride" fixes in the briefing: the workout the briefing finds, and the route. */
function fixedOf(next: NextRide): RideBriefing {
  const { workout, route } = next;
  return {
    ...(route ? { world: route.world } : {}),
    ...(workout?.kind === 'library'
      ? { workout: { kind: 'library' as const, from: workout.from, workoutId: workout.workoutId } }
      : workout?.kind === 'planned'
        ? { workout: { kind: 'planned' as const, from: workout.from, id: workout.id } }
        : {}),
  };
}

function Slot({
  icon,
  name,
  fact,
  gone,
  empty,
  removeLabel,
  onRemove,
  text,
  attribute,
}: {
  readonly icon: string;
  readonly name: string | undefined;
  readonly fact: string | undefined;
  readonly gone: boolean;
  readonly empty: string;
  readonly removeLabel: string;
  readonly onRemove: () => void;
  readonly text: Messages;
  readonly attribute: string;
}) {
  const marker = { [attribute]: '' };
  if (name === undefined) {
    return (
      <div className="nr-slot" data-empty {...marker}>
        <span className="nr-glyph" aria-hidden="true" style={iconStyle(icon)} />
        <span className="nr-text">{empty}</span>
      </div>
    );
  }
  return (
    <div className="nr-slot" {...marker} title={name}>
      <span className="nr-glyph" aria-hidden="true" style={iconStyle(icon)} />
      <span className="nr-text">
        <span className="nr-name" data-next-ride-name>
          {name}
        </span>
        {gone ? (
          <span className="nr-fact" data-gone>
            {text.gone}
          </span>
        ) : fact ? (
          <span className="nr-fact">{fact}</span>
        ) : null}
      </span>
      <button type="button" className="nr-remove" aria-label={removeLabel} onClick={onRemove}>
        <span className="nr-glyph" aria-hidden="true" style={iconStyle(REMOVE)} />
      </button>
    </div>
  );
}

function NextRideView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const next = useStateEntries(ctx, nextRideState).get(NEXT_RIDE_KEY) ?? {};
  const libraries = useStateEntries(ctx, trainingLibraryState);
  const calendars = useStateEntries(ctx, trainingCalendarState);
  const offers = useStateEntries(ctx, routeOfferState);
  // Marked while something it takes is dragged anywhere in the window, and while it hovers.
  const [armed, setArmed] = useState(false);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const start = (event: DragEvent) => setArmed(takes(event.dataTransfer));
    const end = () => {
      setArmed(false);
      setOver(false);
    };
    document.addEventListener('dragstart', start);
    document.addEventListener('dragend', end);
    document.addEventListener('drop', end);
    return () => {
      document.removeEventListener('dragstart', start);
      document.removeEventListener('dragend', end);
      document.removeEventListener('drop', end);
    };
  }, []);

  const set = (ride: NextRide) => {
    ctx
      .call(nextRideSetService, { key: NEXT_RIDE_KEY, ride })
      .catch((error: unknown) => ctx.logger.warn(`Could not keep the next ride: ${String(error)}`));
  };

  // What the providers say of the workout and the route now; gone once a loaded list lacks it.
  const { workout, route } = next;
  const library = workout?.kind === 'library' ? libraries.get(workout.from) : undefined;
  const calendar = workout?.kind === 'planned' ? calendars.get(workout.from) : undefined;
  const listed =
    workout?.kind === 'library'
      ? library?.data?.workouts.find((each) => each.id === workout.workoutId)
      : workout?.kind === 'planned'
        ? calendar?.data?.workouts.find((each) => each.id === workout.id)
        : undefined;
  const workoutGone = workout !== undefined && listed === undefined && (library ?? calendar)?.data !== undefined;
  const seconds = listed?.durationSeconds;
  const offer = route ? offers.get(route.offer) : undefined;
  const routeGone = route !== undefined && offers.size > 0 && offer === undefined;
  const km = offer
    ? new Intl.NumberFormat(text.numberLocale, { maximumFractionDigits: 1 }).format(offer.distance / 1000)
    : undefined;

  return (
    <section
      className="nr"
      data-next-ride
      aria-label={text.nextRide}
      data-armed={armed || undefined}
      data-over={(armed && over) || undefined}
      onDragOver={(event) => {
        if (!takes(event.dataTransfer)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        const ride = dropped(next, event.dataTransfer);
        if (!ride) return;
        event.preventDefault();
        setOver(false);
        set(ride);
      }}
    >
      <style>{CSS}</style>
      <h2 className="nr-title">{text.nextRide}</h2>
      <Slot
        icon={WORKOUT}
        name={workout?.name}
        fact={seconds === undefined ? undefined : text.minutes(Math.round(seconds / 60))}
        gone={workoutGone}
        empty={text.dropWorkout}
        removeLabel={text.removeWorkout}
        onRemove={() => set({ ...(route ? { route } : {}) })}
        text={text}
        attribute="data-next-ride-workout"
      />
      <Slot
        icon={ROUTE}
        name={route?.title}
        fact={km === undefined ? undefined : text.kilometres(km)}
        gone={routeGone}
        empty={text.dropRoute}
        removeLabel={text.removeRoute}
        onRemove={() => set({ ...(workout ? { workout } : {}) })}
        text={text}
        attribute="data-next-ride-route"
      />
      <button
        type="button"
        className="nr-start"
        data-next-ride-start
        aria-label={text.start}
        disabled={!workout && !route}
        onClick={() => openBriefing(ctx, fixedOf(next))}
      >
        <span className="nr-glyph" aria-hidden="true" style={iconStyle(PLAY)} />
        <span className="nr-start-label">{text.start}</span>
      </button>
    </section>
  );
}

export const NextRideSection = reactComponent((ctx) => <NextRideView ctx={ctx} />);
