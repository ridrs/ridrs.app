// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStartRequestedEvent,
  type RouteOffer,
  routeCancelService,
  routeFetchService,
  routeOfferState,
  routeRemoveService,
} from '@ridrs/contracts';
import {
  AreaPage,
  Badge,
  Card,
  type CardFact,
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
import {
  describeRoute,
  FILTERS,
  type Filter,
  FIRST_ROUTE,
  filterRoutes,
  formatAscent,
  formatDistance,
  formatSize,
  orderOffers,
} from './routes.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as masks in the text colour. */
const BIKE = new URL('./assets/icons/bike.svg', import.meta.url).href;
const STAR = new URL('./assets/icons/star.svg', import.meta.url).href;
const STAR_FILLED = new URL('./assets/icons/star-filled.svg', import.meta.url).href;
const DISTANCE = new URL('./assets/icons/route.svg', import.meta.url).href;
const ASCENT = new URL('./assets/icons/trending-up.svg', import.meta.url).href;
const MOUNTAIN = new URL('./assets/icons/mountain.svg', import.meta.url).href;
const VIDEO = new URL('./assets/icons/video.svg', import.meta.url).href;
const DOWNLOAD = new URL('./assets/icons/download.svg', import.meta.url).href;
const CANCEL = new URL('./assets/icons/x.svg', import.meta.url).href;

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
  { favourites: [], filters: [], showOnToday: true, lastRoute: FIRST_ROUTE },
);

/** Every route the plugins offer: the app state `route.offer` (ADR 0068), in the page's order. */
function useOffers(ctx: UiContext): readonly RouteOffer[] {
  const [offers, setOffers] = useState<readonly RouteOffer[]>([]);
  useEffect(
    () => ctx.state.watch(routeOfferState, ({ entries }) => setOffers(orderOffers(entries.values()))),
    [ctx],
  );
  return offers;
}

/** What a refused call says to the rider: the reason of the plugin that refused. */
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Starts a ride in the offer's world; only an offer on this device can be ridden. */
function useGo(ctx: UiContext) {
  const [, change] = useRide(ctx);
  return (offer: RouteOffer) => {
    change((state) => ({ ...state, lastRoute: offer.id }));
    ctx.events.publish(activityStartRequestedEvent, { world: offer.world });
  };
}

const PICTURE = { width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 8 } as const;

/**
 * The climb that fills the profile's height: 3 % over the route's whole length, so a gentle route
 * looks gentle and a mountain pass steep; a steeper route fills it with its own range.
 */
const FULL_HEIGHT_GRADE = 0.03;

/**
 * The route's elevations as a hill: a filled area from start to end under a line, from its lowest
 * point up. On a card it rises behind the title.
 */
function Profile({ offer, height }: { readonly offer: RouteOffer; readonly height?: number }) {
  const elevations = offer.sparkline;
  if (!elevations || elevations.length < 2) {
    return null;
  }
  const low = Math.min(...elevations);
  const range = Math.max(Math.max(...elevations) - low, offer.distance * FULL_HEIGHT_GRADE, 1);
  const line = elevations
    .map((elevation, i) => `${(i / (elevations.length - 1)) * 100},${(1 - (elevation - low) / range) * 30 + 2}`)
    .join(' ');
  const fill = `area-${offer.id.replace(/[^A-Za-z0-9-]/g, '-')}`;
  return (
    <svg
      role="img"
      aria-label={`Elevation profile of ${offer.title}`}
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      style={{ width: '100%', height: height ?? '100%', color: 'var(--ridrs-accent, #b8f53b)' }}
    >
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity={0.35} />
          <stop offset="1" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={`0,32 ${line} 100,32`} fill={`url(#${fill})`} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.85}
        strokeWidth={1.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function FavouriteToggle({ ctx, offer, label }: { readonly ctx: UiContext; readonly offer: RouteOffer; readonly label?: string }) {
  const [state, change] = useRide(ctx);
  const favourite = state.favourites.includes(offer.id);
  return (
    <Toggle
      className={label ? 'pv-chip pv-favourite' : 'pv-icon pv-favourite'}
      label={label ?? `Favourite ${offer.title}`}
      on={favourite}
      onChange={(on) =>
        change((s) => ({
          ...s,
          favourites: on ? [...s.favourites, offer.id] : s.favourites.filter((id) => id !== offer.id),
        }))
      }
    >
      {/* A favourite's star is filled; the toggle's look stays the same, so it never looks focused. */}
      <span className="pv-glyph" aria-hidden="true" style={iconStyle(favourite ? STAR_FILLED : STAR)} />
      {label}
    </Toggle>
  );
}

/** How far a download is, for a route that is not ready: e.g. `Downloading: 45 %`. */
function downloadState(offer: RouteOffer): string | undefined {
  const { availability } = offer;
  switch (availability.state) {
    case 'fetchable':
      return `Not on this device yet: ${formatSize(availability.size)} to download`;
    case 'fetching':
      return `Downloading: ${Math.floor((availability.received / availability.size) * 100)} %`;
    case 'failed':
      return `Download failed: ${availability.reason}`;
    case 'ready':
      return undefined;
  }
}

const minutes = (offer: RouteOffer) =>
  offer.duration === undefined ? undefined : `about ${Math.round(offer.duration / 60)} min`;

/** What a card says under the title: the route's length and climb, each by its icon. */
const facts = (offer: RouteOffer): CardFact[] => [
  { icon: DISTANCE, text: formatDistance(offer) },
  { icon: ASCENT, text: formatAscent(offer) },
];

/** A corner badge for a route that is not ready: its size, the download's progress, a failure. */
function DownloadBadge({ offer }: { readonly offer: RouteOffer }) {
  const { availability } = offer;
  switch (availability.state) {
    case 'fetchable':
      return <Badge>{formatSize(availability.size)}</Badge>;
    case 'fetching':
      return <Badge tone="busy">{Math.floor((availability.received / availability.size) * 100)} %</Badge>;
    case 'failed':
      return <Badge tone="warn">Download failed</Badge>;
    case 'ready':
      return null;
  }
}

/**
 * Download or Cancel on a card, beside its badge: a route that is not ready downloads from the list
 * as from its details. A refused call says why in the badge's place until the offer changes.
 */
function DownloadTool({ ctx, offer }: { readonly ctx: UiContext; readonly offer: RouteOffer }) {
  const { availability } = offer;
  const [refusal, setRefusal] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new state replaces the refusal.
  useEffect(() => setRefusal(undefined), [availability.state]);
  const call = (run: () => Promise<unknown>) => {
    setRefusal(undefined);
    run().catch((error: unknown) => setRefusal(reasonOf(error)));
  };
  if (availability.state === 'ready') return null;
  const fetching = availability.state === 'fetching';
  return (
    <>
      {refusal ? <Badge tone="warn">{refusal}</Badge> : <DownloadBadge offer={offer} />}
      <button
        type="button"
        className="pv-icon"
        aria-label={fetching ? `Cancel download of ${offer.title}` : `Download ${offer.title}`}
        onClick={() =>
          call(() => ctx.call(fetching ? routeCancelService : routeFetchService, { key: offer.id }))
        }
      >
        <span className="pv-glyph" aria-hidden="true" style={iconStyle(fetching ? CANCEL : DOWNLOAD)} />
      </button>
    </>
  );
}

/** A route in a list: its picture fills the card, the profile rises behind its title. */
function RouteCard({
  ctx,
  offer,
  onOpen,
}: {
  readonly ctx: UiContext;
  readonly offer: RouteOffer;
  readonly onOpen: () => void;
}) {
  return (
    <Card
      label={offer.title}
      classifier={offer.kind === 'video' ? 'Video' : 'Route'}
      icon={offer.kind === 'video' ? VIDEO : MOUNTAIN}
      title={offer.title}
      details={facts(offer)}
      image={offer.thumbnail}
      backdrop={<Profile offer={offer} />}
      tools={
        <>
          <DownloadTool ctx={ctx} offer={offer} />
          <FavouriteToggle ctx={ctx} offer={offer} />
        </>
      }
      onOpen={onOpen}
    />
  );
}

/**
 * One route up close: two clicks from the list to the ride (tap the route, then Go). A route that
 * is not on this device yet says what it takes and downloads on Download, a download on its way
 * stops on Cancel download; a downloaded one can be removed again.
 */
function RouteDetails({
  ctx,
  offer,
  onClose,
}: {
  readonly ctx: UiContext;
  readonly offer: RouteOffer;
  readonly onClose: () => void;
}) {
  const go = useGo(ctx);
  const first = useRef<HTMLButtonElement>(null);
  const { availability, credits } = offer;
  // The first action of the current state, also when a download changes it under the rider.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the state decides which button is first.
  useEffect(() => first.current?.focus(), [availability.state]);
  const fetchable = availability.state === 'fetchable' || availability.state === 'failed';
  // Why the last Download, Cancel or Remove was refused, until the offer's state changes.
  const [refusal, setRefusal] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new state replaces the refusal.
  useEffect(() => setRefusal(undefined), [availability.state]);
  const call = (run: () => Promise<unknown>) => {
    setRefusal(undefined);
    run().catch((error: unknown) => setRefusal(reasonOf(error)));
  };
  const state = refusal ?? downloadState(offer);
  return (
    <section className="pv-section" aria-label={`${offer.title} details`}>
      <h2>{offer.title}</h2>
      {offer.thumbnail ? <img src={offer.thumbnail} alt="" style={{ ...PICTURE, maxWidth: 640 }} /> : null}
      <Profile offer={offer} height={64} />
      <p className="pv-muted">{[describeRoute(offer), minutes(offer)].filter(Boolean).join(' · ')}</p>
      {credits ? (
        <p className="pv-muted">
          By {credits.author}, {credits.source}, {credits.license}. {credits.url}
        </p>
      ) : null}
      {state ? <p role="status">{state}</p> : null}
      <div className="pv-row">
        {availability.state === 'ready' ? (
          <button ref={first} type="button" className="pv-button pv-primary" onClick={() => go(offer)}>
            <span className="pv-glyph" aria-hidden="true" style={iconStyle(BIKE)} />
            Go
          </button>
        ) : null}
        {fetchable ? (
          <button
            ref={first}
            type="button"
            className="pv-button pv-primary"
            onClick={() => call(() => ctx.call(routeFetchService, { key: offer.id }))}
          >
            Download
          </button>
        ) : null}
        {availability.state === 'fetching' ? (
          <button
            ref={first}
            type="button"
            className="pv-button"
            onClick={() => call(() => ctx.call(routeCancelService, { key: offer.id }))}
          >
            <span className="pv-glyph" aria-hidden="true" style={iconStyle(CANCEL)} />
            Cancel download
          </button>
        ) : null}
        <FavouriteToggle ctx={ctx} offer={offer} label="Favourite" />
        {availability.state === 'ready' && availability.removable ? (
          <button
            type="button"
            className="pv-button"
            onClick={() => call(() => ctx.call(routeRemoveService, { key: offer.id }))}
          >
            Remove from this device
          </button>
        ) : null}
        <button type="button" className="pv-button" onClick={onClose}>
          All routes
        </button>
      </div>
    </section>
  );
}

function RideAreaView({ ctx }: { readonly ctx: UiContext }) {
  const [state, change] = useRide(ctx);
  const offers = useOffers(ctx);
  const [openId, setOpenId] = useState<string>();
  const open = offers.find((offer) => offer.id === openId);
  useBack(ctx, () => {
    if (!open) return false;
    setOpenId(undefined);
    return true;
  });
  const shown = filterRoutes(offers, state.filters, state.favourites);
  const toggleFilter = (filter: Filter, on: boolean) =>
    change((s) => ({ ...s, filters: on ? [...s.filters, filter] : s.filters.filter((f) => f !== filter) }));
  const section = (title: string, kind: RouteOffer['kind'], none: string) => {
    const routes = shown.filter((offer) => offer.kind === kind);
    return (
      <section className="pv-section" aria-label={title}>
        <h2>{title}</h2>
        {routes.length === 0 ? (
          <p className="pv-muted">
            {offers.some((offer) => offer.kind === kind) ? 'No route matches the filters.' : none}
          </p>
        ) : (
          <div className="pv-cards" data-wide>
            {routes.map((offer) => (
              <RouteCard key={offer.id} ctx={ctx} offer={offer} onOpen={() => setOpenId(offer.id)} />
            ))}
          </div>
        )}
      </section>
    );
  };

  return (
    <AreaPage title="Ride" intro="Ride freely: worlds, routes and real video. Pick a route, then Go.">
      {open ? (
        <RouteDetails ctx={ctx} offer={open} onClose={() => setOpenId(undefined)} />
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
          {section('Worlds and routes', 'world', 'No world offers a route.')}
          {section('Real video', 'video', 'No video source offers a route.')}
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

/** The card on Today: the route ridden last, one click to ride it again while it is on the device. */
function RideAgainView({ ctx }: { readonly ctx: UiContext }) {
  const [state, change] = useRide(ctx);
  const offers = useOffers(ctx);
  const go = useGo(ctx);
  if (!state.showOnToday) return null;
  const offer = offers.find((o) => o.id === state.lastRoute) ?? offers.find((o) => o.id === FIRST_ROUTE);
  if (!offer || offer.availability.state !== 'ready') return null;
  return (
    <TodayCard
      classifier="Ride again"
      icon={BIKE}
      title={offer.title}
      details={facts(offer)}
      image={offer.thumbnail}
      backdrop={offer.thumbnail ? undefined : <Profile offer={offer} />}
      onHide={() => change((s) => ({ ...s, showOnToday: false }))}
    >
      <div className="pv-row">
        <button type="button" className="pv-button pv-primary" onClick={() => go(offer)}>
          <span className="pv-glyph" aria-hidden="true" style={iconStyle(BIKE)} />
          Ride {offer.title} again
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
