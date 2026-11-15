// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  carries,
  DRAG_REMOVABLE,
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
  setDragged,
  trainingCalendarState,
  trainingLibraryState,
} from '@ridrs/contracts';
import { iconStyle, reactComponent } from '@ridrs/ui-preview';
import type { UiContext } from '@ridrs/ui-sdk';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { type DragEvent, useEffect, useId, useRef, useState } from 'react';
import { openBriefing } from './briefing.ts';
import { type Messages, messages } from './i18n/index.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as masks in the text colour. */
const WORKOUT = new URL('./assets/icons/dumbbell.svg', import.meta.url).href;
const ROUTE = new URL('./assets/icons/route.svg', import.meta.url).href;
const PLAY = new URL('./assets/icons/play.svg', import.meta.url).href;

/**
 * Under the menu's entries (ADR 0096), without a frame of its own: a head with the play arrow and
 * two places to drop a workout and a route onto, each a large icon with its text under it. The
 * whole of it is one control that starts the
 * ride through the briefing. A filled place is dragged onto the bin to take it out. Narrow
 * (medium) the places are icons; on the bottom bar (compact) the next ride is not shown.
 */
const CSS = `
.nr { display: flex; flex-direction: column; gap: 8px; padding: 10px 8px; border-radius: var(--ridrs-radius-lg); cursor: pointer;
  color: var(--ridrs-text); font: var(--ridrs-size-small) var(--ridrs-font-text); outline: none;
  transition: background var(--ridrs-ease); }
.nr:hover:not([aria-disabled="true"]) { background: var(--ridrs-surface-raised); }
.nr:focus-visible { outline: var(--ridrs-focus-ring); outline-offset: 2px; }
.nr[aria-disabled="true"] { cursor: default; }
.nr-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 4px; }
.nr-title { margin: 0; color: var(--ridrs-text-muted); font: 500 var(--ridrs-size-label) var(--ridrs-font-mono);
  letter-spacing: .12em; text-transform: uppercase; }
.nr-play { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%;
  background: var(--ridrs-accent); color: var(--ridrs-accent-text); }
.nr[aria-disabled="true"] .nr-play { background: var(--ridrs-surface-raised); color: var(--ridrs-text-muted); }
.nr-glyph { flex: none; width: 16px; height: 16px; background: currentColor;
  mask: var(--icon) center / contain no-repeat; -webkit-mask: var(--icon) center / contain no-repeat; }
.nr-play .nr-glyph { width: 14px; height: 14px; margin-left: 2px; }

.nr-slot { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; min-height: 92px; padding: 12px 10px; text-align: center;
  border-radius: var(--ridrs-radius); overflow: hidden; }
.nr-badge { flex: none; display: grid; place-items: center; width: 44px; height: 44px; border-radius: var(--ridrs-radius-sm); }
.nr-badge .nr-glyph { width: 24px; height: 24px; }
.nr-text { display: flex; flex-direction: column; align-items: center; max-width: 100%; min-width: 0; line-height: 1.25; }
.nr-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.nr-fact { color: var(--ridrs-text); opacity: .78; font-size: var(--ridrs-size-label); }
.nr-fact[data-gone] { color: var(--ridrs-warn); }

/* An empty place is the one dashed shape of the app: a place to drop onto. */
.nr-slot[data-empty] { color: var(--ridrs-text-muted); font-size: var(--ridrs-size-label);
  border: 1px dashed var(--ridrs-line); }
.nr-slot[data-empty] .nr-badge { opacity: .7; }

/* A filled place is a card like the route cards: the navy gradient and its light edge. */
.nr-slot:not([data-empty]) { background: var(--ridrs-card); box-shadow: var(--ridrs-edge); cursor: grab; }
.nr-slot:not([data-empty]) .nr-badge { background: rgb(204 255 0 / .14); color: var(--ridrs-accent); }

/* While a workout or a route is dragged, the places show their edge in cyan; over one, in volt. */
.nr[data-armed] .nr-slot { border: 1px dashed var(--ridrs-accent); }
.nr[data-over] .nr-slot { border: 2px solid var(--ridrs-accent); }
@media (prefers-reduced-motion: reduce) { .nr { transition: none; } }

[data-breakpoint="medium"] .nr { align-items: center; padding: 8px 4px; }
[data-breakpoint="medium"] .nr-head { justify-content: center; }
[data-breakpoint="medium"] .nr-title, [data-breakpoint="medium"] .nr-text { position: absolute; width: 1px; height: 1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
[data-breakpoint="medium"] .nr-slot { width: 52px; min-height: 52px; padding: 4px 0; }
[data-breakpoint="medium"] .nr-badge { width: 40px; height: 40px; }
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

/** What starting the next ride fixes in the briefing: the workout the briefing finds, and the route. */
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
  id,
  icon,
  name,
  fact,
  gone,
  empty,
  text,
  attribute,
  onTakenOut,
}: {
  readonly id: string;
  readonly icon: string;
  readonly name: string | undefined;
  readonly fact: string | undefined;
  readonly gone: boolean;
  readonly empty: string;
  readonly text: Messages;
  readonly attribute: string;
  readonly onTakenOut: () => void;
}) {
  const marker = { [attribute]: '' };
  if (name === undefined) {
    return (
      <span className="nr-slot" data-empty {...marker}>
        <span className="nr-badge">
          <span className="nr-glyph" aria-hidden="true" style={iconStyle(icon)} />
        </span>
        <span className="nr-text" id={id}>
          {empty}
        </span>
      </span>
    );
  }
  return (
    <span
      className="nr-slot"
      {...marker}
      title={`${name} · ${text.dragToBin}`}
      draggable
      onDragStart={(event: DragEvent<HTMLElement>) => {
        // The bin takes it as a move and keeps nothing: this place takes it out on `dragend`.
        event.dataTransfer?.setData('text/plain', name);
        setDragged(event.dataTransfer, DRAG_REMOVABLE, { kind: 'dismissed', title: name });
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={(event: DragEvent<HTMLElement>) => {
        if (event.dataTransfer?.dropEffect === 'move') onTakenOut();
      }}
    >
      <span className="nr-badge">
        <span className="nr-glyph" aria-hidden="true" style={iconStyle(icon)} />
      </span>
      <span className="nr-text" id={id}>
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
    </span>
  );
}

function NextRideView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const ids = useId();
  const next = useStateEntries(ctx, nextRideState).get(NEXT_RIDE_KEY) ?? {};
  // A drag outlives the render it started in: taking a part out goes by the next ride of now.
  const latest = useRef(next);
  latest.current = next;
  const libraries = useStateEntries(ctx, trainingLibraryState);
  const calendars = useStateEntries(ctx, trainingCalendarState);
  const offers = useStateEntries(ctx, routeOfferState);
  // Marked while something it takes is dragged anywhere in the window, and while it hovers.
  const [armed, setArmed] = useState(false);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const start = (event: globalThis.DragEvent) => setArmed(takes(event.dataTransfer));
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
  const startable = workout !== undefined || route !== undefined;
  const start = () => {
    if (startable) openBriefing(ctx, fixedOf(next));
  };

  return (
    <div
      className="nr"
      role="button"
      tabIndex={0}
      data-next-ride
      aria-label={text.start}
      aria-describedby={`${ids}-workout ${ids}-route`}
      aria-disabled={!startable}
      data-armed={armed || undefined}
      data-over={(armed && over) || undefined}
      onClick={start}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        start();
      }}
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
      <span className="nr-head">
        <span className="nr-title">{text.nextRide}</span>
        <span className="nr-play" aria-hidden="true">
          <span className="nr-glyph" style={iconStyle(PLAY)} />
        </span>
      </span>
      <Slot
        id={`${ids}-workout`}
        icon={WORKOUT}
        name={workout?.name}
        fact={seconds === undefined ? undefined : text.minutes(Math.round(seconds / 60))}
        gone={workoutGone}
        empty={text.dropWorkout}
        text={text}
        attribute="data-next-ride-workout"
        onTakenOut={() => {
          const { route: now } = latest.current;
          set(now ? { route: now } : {});
        }}
      />
      <Slot
        id={`${ids}-route`}
        icon={ROUTE}
        name={route?.title}
        fact={km === undefined ? undefined : text.kilometres(km)}
        gone={routeGone}
        empty={text.dropRoute}
        text={text}
        attribute="data-next-ride-route"
        onTakenOut={() => {
          const { workout: now } = latest.current;
          set(now ? { workout: now } : {});
        }}
      />
    </div>
  );
}

export const NextRideSection = reactComponent((ctx) => <NextRideView ctx={ctx} />);
