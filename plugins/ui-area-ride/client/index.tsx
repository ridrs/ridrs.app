// SPDX-License-Identifier: AGPL-3.0-or-later

import { activityStartRequestedEvent } from '@ridrs/contracts';
import {
  AreaPage,
  iconStyle,
  MenuEntry,
  reactComponent,
  TodayCard,
  Toggle,
  useBack,
  userDocument,
} from '@ridrs/ui-preview';
import type { UiContext } from '@ridrs/ui-sdk';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { FILTERS, type Filter, filterRoutes, ROUTES, type Route } from './routes.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as masks in the text colour. */
const BIKE = new URL('./assets/icons/bike.svg', import.meta.url).href;
const STAR = new URL('./assets/icons/star.svg', import.meta.url).href;
const MOUNTAIN = new URL('./assets/icons/mountain.svg', import.meta.url).href;

/** What the rider changed in this area, kept at once (ADR 0059). */
const useRide = userDocument(
  {
    name: 'preview',
    version: 1,
    schema: z
      .object({
        favourites: z.array(z.string()),
        filters: z.array(z.enum(['flat', 'hilly', 'short', 'favourites'])),
        showOnToday: z.boolean(),
        lastRoute: z.string(),
      })
      .strict(),
  },
  { favourites: [], filters: [], showOnToday: true, lastRoute: 'coastal-flats' },
);

const describe = (route: Route) => `${route.world} · ${route.km} km · ${route.climb} m`;

/** Starts a ride; the route is a placeholder, so every route rides the demo landscape for now. */
function useGo(ctx: UiContext) {
  const [, change] = useRide(ctx);
  return (route: Route) => {
    change((state) => ({ ...state, lastRoute: route.id }));
    ctx.events.publish(activityStartRequestedEvent, {});
  };
}

function RouteCard({
  ctx,
  route,
  onOpen,
}: {
  readonly ctx: UiContext;
  readonly route: Route;
  readonly onOpen: () => void;
}) {
  const [state, change] = useRide(ctx);
  const favourite = state.favourites.includes(route.id);
  return (
    <article className="pv-card">
      <button type="button" className="pv-open" aria-label={route.name} onClick={onOpen}>
        <strong>{route.name}</strong>
        <span className="pv-muted">{describe(route)}</span>
      </button>
      <div className="pv-row">
        <Toggle
          className="pv-icon"
          label={`Favourite ${route.name}`}
          on={favourite}
          onChange={(on) =>
            change((s) => ({
              ...s,
              favourites: on ? [...s.favourites, route.id] : s.favourites.filter((id) => id !== route.id),
            }))
          }
        >
          <span className="pv-glyph" aria-hidden="true" style={iconStyle(STAR)} />
        </Toggle>
        <span className="pv-muted">about {route.minutes} min</span>
      </div>
    </article>
  );
}

/** One route up close: two clicks from the list to the ride (tap the route, then Go). */
function RouteDetails({
  ctx,
  route,
  onClose,
}: {
  readonly ctx: UiContext;
  readonly route: Route;
  readonly onClose: () => void;
}) {
  const [state, change] = useRide(ctx);
  const go = useGo(ctx);
  const goButton = useRef<HTMLButtonElement>(null);
  useEffect(() => goButton.current?.focus(), []);
  const favourite = state.favourites.includes(route.id);
  return (
    <section className="pv-section" aria-label={`${route.name} details`}>
      <h2>{route.name}</h2>
      <p className="pv-muted">
        {describe(route)} · about {route.minutes} min. Every route rides the demo landscape in
        this preview.
      </p>
      <div className="pv-row">
        <button ref={goButton} type="button" className="pv-button pv-primary" onClick={() => go(route)}>
          <span className="pv-glyph" aria-hidden="true" style={iconStyle(BIKE)} />
          Go
        </button>
        <Toggle
          label={favourite ? 'Favourite' : 'Add to favourites'}
          on={favourite}
          onChange={(on) =>
            change((s) => ({
              ...s,
              favourites: on ? [...s.favourites, route.id] : s.favourites.filter((id) => id !== route.id),
            }))
          }
        />
        <button type="button" className="pv-button" onClick={onClose}>
          All routes
        </button>
      </div>
    </section>
  );
}

function RideAreaView({ ctx }: { readonly ctx: UiContext }) {
  const [state, change] = useRide(ctx);
  const [open, setOpen] = useState<Route>();
  useBack(ctx, () => {
    if (!open) return false;
    setOpen(undefined);
    return true;
  });
  const shown = filterRoutes(ROUTES, state.filters, state.favourites);
  const toggleFilter = (filter: Filter, on: boolean) =>
    change((s) => ({ ...s, filters: on ? [...s.filters, filter] : s.filters.filter((f) => f !== filter) }));
  const cards = (kind: Route['kind']) => {
    const routes = shown.filter((route) => route.kind === kind);
    return routes.length === 0 ? (
      <p className="pv-muted">No route matches the filters.</p>
    ) : (
      <div className="pv-cards">
        {routes.map((route) => (
          <RouteCard key={route.id} ctx={ctx} route={route} onOpen={() => setOpen(route)} />
        ))}
      </div>
    );
  };

  return (
    <AreaPage title="Ride" intro="Ride freely: worlds, routes and real video. Pick a route, then Go.">
      {open ? (
        <RouteDetails ctx={ctx} route={open} onClose={() => setOpen(undefined)} />
      ) : (
        <>
          <section className="pv-section" aria-label="Filters">
            <div className="pv-row">
              {FILTERS.map((filter) => (
                <Toggle
                  key={filter.id}
                  label={filter.label}
                  on={state.filters.includes(filter.id)}
                  onChange={(on) => toggleFilter(filter.id, on)}
                />
              ))}
            </div>
          </section>
          <section className="pv-section">
            <h2>Worlds and routes</h2>
            {cards('world')}
          </section>
          <section className="pv-section">
            <h2>Real video</h2>
            {cards('video')}
          </section>
          <section className="pv-section">
            <h2>Map, pacers and groups</h2>
            <div className="pv-card">
              <div className="pv-row">
                <span className="pv-glyph" aria-hidden="true" style={iconStyle(MOUNTAIN)} />
                <span className="pv-muted">A map of every world, pacer bots and group rides come later.</span>
              </div>
            </div>
          </section>
          <section className="pv-section">
            <h2>On Today</h2>
            <div className="pv-row">
              <Toggle
                label="Show Ride again on Today"
                on={state.showOnToday}
                onChange={(on) => change((s) => ({ ...s, showOnToday: on }))}
              />
            </div>
          </section>
        </>
      )}
    </AreaPage>
  );
}

/** The card on Today: the route ridden last, one click to ride it again. */
function RideAgainView({ ctx }: { readonly ctx: UiContext }) {
  const [state, change] = useRide(ctx);
  const go = useGo(ctx);
  if (!state.showOnToday) return null;
  const route = ROUTES.find((r) => r.id === state.lastRoute) ?? ROUTES[0];
  if (!route) return null;
  return (
    <TodayCard title="Ride again" onHide={() => change((s) => ({ ...s, showOnToday: false }))}>
      <strong>{route.name}</strong>
      <span className="pv-muted">{describe(route)}</span>
      <div className="pv-row">
        <button type="button" className="pv-button" onClick={() => go(route)}>
          <span className="pv-glyph" aria-hidden="true" style={iconStyle(BIKE)} />
          Ride {route.name} again
        </button>
      </div>
    </TodayCard>
  );
}

export const RideArea = reactComponent((ctx) => <RideAreaView ctx={ctx} />);
export const RideAgainTile = reactComponent((ctx) => <RideAgainView ctx={ctx} />);
export const RideMenuEntry = reactComponent((ctx) => (
  <MenuEntry ctx={ctx} screen="ride" label="Ride" icon={BIKE} />
));
