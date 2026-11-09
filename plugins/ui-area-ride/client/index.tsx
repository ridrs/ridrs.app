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
  DetailPage,
  iconStyle,
  MenuEntry,
  reactComponent,
  TodayCard,
  Toggle,
  useBack,
  userDocument,
} from '@ridrs/ui-preview';
import type { UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { type Messages, messages } from './i18n/index.ts';
import { RouteProfile } from './profile.tsx';
import {
  climbCategory,
  describeClimb,
  describeRoute,
  FILTERS,
  type Filter,
  FIRST_ROUTE,
  filterRoutes,
  formatAscent,
  formatDistance,
  formatDuration,
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
const ON_DEVICE = new URL('./assets/icons/check.svg', import.meta.url).href;
const DURATION = new URL('./assets/icons/clock.svg', import.meta.url).href;

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

/** Over the route's picture: what it is, in small capitals. */
const KICKER = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  color: 'rgb(255 255 255 / .85)',
  font: '700 12px/1.2 system-ui, sans-serif',
  letterSpacing: '.08em',
  textTransform: 'uppercase',
} as const;
/** The route's numbers in a row of large figures, its actions beside them. */
const SUMMARY = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px 32px',
} as const;
const STATS = { display: 'flex', flexWrap: 'wrap', gap: '12px 32px', margin: 0 } as const;
const STAT = { display: 'grid', gap: 2 } as const;
const STAT_LABEL = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  color: 'var(--ridrs-text-muted, #93a1b8)',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
} as const;
const STAT_VALUE = { margin: 0, font: '800 24px/1.2 system-ui, sans-serif' } as const;
const CLIMBS = { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 } as const;
const CLIMB = { display: 'flex', alignItems: 'center', gap: 12 } as const;
/** A climb's category in a red disc. */
const CATEGORY_BADGE = {
  display: 'inline-grid',
  placeItems: 'center',
  width: 30,
  height: 30,
  borderRadius: '50%',
  background: '#d4202c',
  color: '#fff',
  fontSize: 12,
  fontWeight: 800,
  flex: 'none',
} as const;

/**
 * How high a card's profile rises, as a share of the card: by the route's rise from its lowest to
 * its highest point alone, 30 % for 1000 m and by the square root of that below, so 500 m still
 * rise 21 % and a flat route stays visible. It stops at the top of its area, 42 % of the card
 * (`.pv-teaser-backdrop` in ui-preview), from about 1960 m.
 */
const FULL_RISE = 1000;
const FULL_RISE_SHARE = 0.3;
const BACKDROP_SHARE = 0.42;
const riseShare = (rise: number) => Math.min(FULL_RISE_SHARE * Math.sqrt(Math.max(rise, 0) / FULL_RISE), BACKDROP_SHARE);

/**
 * How far above the card's lower edge the profile's lowest point sits, in the 32 units of its
 * area (about 7 px on a card): clear of the card's rounded corners, so a route that starts at its
 * lowest point still shows its first metres. The fill below still reaches the edge.
 */
const PROFILE_LIFT = 2.5;

/** How long the glowing dot takes to ride a card's profile from start to end. */
const TRACE_MS = 1600;

const TRACE_DOT = {
  position: 'absolute',
  width: 7,
  height: 7,
  margin: '-3.5px 0 0 -3.5px',
  borderRadius: '50%',
  background: '#fff',
  boxShadow: '0 0 6px 2px var(--ridrs-accent, #b8f53b), 0 0 16px 5px rgb(184 245 59 / .55)',
  opacity: 0,
  pointerEvents: 'none',
  // Keeps the dot on its own layer at all times. Otherwise the browser layers it (and the title
  // over it) only while it rides, and redraws the title a pixel off once the ride ends.
  willChange: 'opacity, left, top',
} as const;

/**
 * Rides a glowing dot once along the profile, from start to end, when the pointer enters the card
 * (or the keyboard focuses it); it is gone at once when the pointer or the focus leaves. The
 * profile is stretched to the card, so the dot moves over the points in percent of the box instead
 * of inside the SVG, where it would be stretched too.
 */
function useTrace(points: readonly (readonly [number, number])[]) {
  const box = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the points follow the offer, which keys the card.
  useEffect(() => {
    const card = box.current?.closest('.pv-teaser');
    const element = dot.current;
    if (!card || !element || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    let running: Animation | undefined;
    const ride = () => {
      if (running?.playState === 'running') return;
      running = element.animate?.(
        points.map(([x, y], i) => ({
          left: `${x}%`,
          top: `${(y / 32) * 100}%`,
          opacity: i === 0 || i === points.length - 1 ? 0 : 1,
        })),
        { duration: TRACE_MS, easing: 'ease-in-out' },
      );
    };
    const stop = () => running?.cancel();
    card.addEventListener('mouseenter', ride);
    card.addEventListener('focusin', ride);
    card.addEventListener('mouseleave', stop);
    card.addEventListener('focusout', stop);
    return () => {
      card.removeEventListener('mouseenter', ride);
      card.removeEventListener('focusin', ride);
      card.removeEventListener('mouseleave', stop);
      card.removeEventListener('focusout', stop);
      stop();
    };
  }, []);
  return { box, dot };
}

/**
 * The route's elevations as a hill: a filled area from start to end under a line, from its lowest
 * point up. On a card it rises behind the title, and a glowing dot rides it once on hover.
 */
function Profile({
  offer,
  text,
  height,
  trace,
}: {
  readonly offer: RouteOffer;
  readonly text: Messages;
  readonly height?: number;
  readonly trace?: boolean;
}) {
  const elevations = offer.sparkline ?? [];
  const low = Math.min(...elevations);
  const rise = Math.max(...elevations) - low;
  // The hill's height in the 32 units of the profile's area, which is the card's lowest 42 %.
  const hill = (riseShare(rise) / BACKDROP_SHARE) * (32 - PROFILE_LIFT);
  const points = elevations.map(
    (elevation, i) =>
      [(i / (elevations.length - 1)) * 100, 32 - PROFILE_LIFT - (rise > 0 ? ((elevation - low) / rise) * hill : 0)] as const,
  );
  const { box, dot } = useTrace(points);
  if (points.length < 2) {
    return null;
  }
  const line = points.map(([x, y]) => `${x},${y}`).join(' ');
  const fill = `area-${offer.id.replace(/[^A-Za-z0-9-]/g, '-')}`;
  const svg = (
    <svg
      role="img"
      aria-label={text.profileOf(offer.title)}
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
  return trace ? (
    <div ref={box} style={{ position: 'relative' }}>
      {svg}
      <span ref={dot} style={TRACE_DOT} />
    </div>
  ) : (
    svg
  );
}

function FavouriteToggle({ ctx, offer, label }: { readonly ctx: UiContext; readonly offer: RouteOffer; readonly label?: string }) {
  const text = useMessages(ctx, messages);
  const [state, change] = useRide(ctx);
  const favourite = state.favourites.includes(offer.id);
  return (
    <Toggle
      className={label ? 'pv-chip pv-favourite' : 'pv-icon pv-favourite'}
      label={label ?? text.favouriteOf(offer.title)}
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
function downloadState(offer: RouteOffer, text: Messages): string | undefined {
  const { availability } = offer;
  switch (availability.state) {
    case 'fetchable':
      return text.notHere(formatSize(availability.size, text));
    case 'fetching':
      return text.downloading(Math.floor((availability.received / availability.size) * 100));
    case 'failed':
      return text.failedBecause(availability.reason);
    case 'ready':
      return undefined;
  }
}

const minutes = (offer: RouteOffer, text: Messages) =>
  offer.duration === undefined ? undefined : formatDuration(offer.duration, text);

/** What a card says under the title: the route's length and climb, each by its icon. */
const facts = (offer: RouteOffer, text: Messages): CardFact[] => [
  { icon: DISTANCE, text: formatDistance(offer, text) },
  { icon: ASCENT, text: formatAscent(offer, text) },
];

/**
 * A corner badge for a route that needs a download: the download's progress, a failure, or an icon
 * once it is on this device. A route still to download shows only its Download button.
 */
function DownloadBadge({ offer, text }: { readonly offer: RouteOffer; readonly text: Messages }) {
  const { availability } = offer;
  switch (availability.state) {
    case 'fetchable':
      return null;
    case 'fetching':
      return <Badge tone="busy">{Math.floor((availability.received / availability.size) * 100)} %</Badge>;
    case 'failed':
      return <Badge tone="warn">{text.failed}</Badge>;
    case 'ready':
      // Only a downloaded route can be removed; a world's route is always here and needs no icon.
      return availability.removable ? (
        <Badge tone="done" label={text.onDevice}>
          <span className="pv-glyph" aria-hidden="true" style={iconStyle(ON_DEVICE)} />
        </Badge>
      ) : null;
  }
}

/**
 * Download or Cancel on a card, beside its badge: a route that is not ready downloads from the list
 * as from its details. A refused call says why in the badge's place until the offer changes.
 */
function DownloadTool({ ctx, offer }: { readonly ctx: UiContext; readonly offer: RouteOffer }) {
  const text = useMessages(ctx, messages);
  const { availability } = offer;
  const [refusal, setRefusal] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new state replaces the refusal.
  useEffect(() => setRefusal(undefined), [availability.state]);
  const call = (run: () => Promise<unknown>) => {
    setRefusal(undefined);
    run().catch((error: unknown) => setRefusal(reasonOf(error)));
  };
  if (availability.state === 'ready') return <DownloadBadge offer={offer} text={text} />;
  const fetching = availability.state === 'fetching';
  return (
    <>
      {refusal ? <Badge tone="warn">{refusal}</Badge> : <DownloadBadge offer={offer} text={text} />}
      <button
        type="button"
        className="pv-icon"
        aria-label={fetching ? text.cancelDownloadOf(offer.title) : text.downloadOf(offer.title)}
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
  const text = useMessages(ctx, messages);
  return (
    <Card
      label={offer.title}
      classifier={offer.kind === 'video' ? text.video : text.route}
      icon={offer.kind === 'video' ? VIDEO : MOUNTAIN}
      title={offer.title}
      details={facts(offer, text)}
      image={offer.thumbnail}
      backdrop={<Profile offer={offer} text={text} trace />}
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

/** One of the route's numbers in the details: a small label with its icon over a large figure. */
function Stat({ icon, label, value }: { readonly icon: string; readonly label: string; readonly value: string }) {
  return (
    <div style={STAT}>
      <dt style={STAT_LABEL}>
        <span className="pv-glyph" aria-hidden="true" style={{ ...iconStyle(icon), width: 14, height: 14 }} />
        {label}
      </dt>
      <dd style={STAT_VALUE}>{value}</dd>
    </div>
  );
}

/**
 * One route up close, two clicks from the list to the ride (tap the route, then Go): its picture
 * across the top with Back and its title, then its numbers and actions, its profile and its
 * climbs. A route that is not on this device yet says what it takes and downloads on Download, a
 * download on its way stops on Cancel download; a downloaded one can be removed again.
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
  const text = useMessages(ctx, messages);
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
  const state = refusal ?? downloadState(offer, text);
  const duration = minutes(offer, text);
  const level = offer.tags.level;
  return (
    <DetailPage
      label={text.details(offer.title)}
      image={offer.thumbnail}
      onBack={onClose}
      hero={
        <>
          <span style={KICKER}>
            <span className="pv-glyph" aria-hidden="true" style={{ ...iconStyle(offer.kind === 'video' ? VIDEO : MOUNTAIN), width: 15, height: 15 }} />
            {describeRoute(offer, text)}
          </span>
          <h2>{offer.title}</h2>
        </>
      }
    >
      <div style={SUMMARY}>
        <dl style={STATS}>
          <Stat icon={DISTANCE} label={text.distance} value={formatDistance(offer, text)} />
          <Stat icon={ASCENT} label={text.climb} value={formatAscent(offer, text)} />
          {duration ? <Stat icon={DURATION} label={text.duration} value={duration} /> : null}
          {level ? <Stat icon={MOUNTAIN} label={text.level} value={text.levels[level] ?? level} /> : null}
        </dl>
        <div className="pv-row">
          {availability.state === 'ready' ? (
            <button ref={first} type="button" className="pv-button pv-primary" onClick={() => go(offer)}>
              <span className="pv-glyph" aria-hidden="true" style={iconStyle(BIKE)} />
              {text.go}
            </button>
          ) : null}
          {fetchable ? (
            <button
              ref={first}
              type="button"
              className="pv-button pv-primary"
              onClick={() => call(() => ctx.call(routeFetchService, { key: offer.id }))}
            >
              <span className="pv-glyph" aria-hidden="true" style={iconStyle(DOWNLOAD)} />
              {text.download}
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
              {text.cancelDownload}
            </button>
          ) : null}
          <FavouriteToggle ctx={ctx} offer={offer} label={text.favourite} />
          {availability.state === 'ready' && availability.removable ? (
            <button
              type="button"
              className="pv-button"
              onClick={() => call(() => ctx.call(routeRemoveService, { key: offer.id }))}
            >
              {text.remove}
            </button>
          ) : null}
        </div>
      </div>
      {state ? (
        <p role="status" className="pv-muted">
          {state}
        </p>
      ) : null}
      {offer.sparkline ? (
        <section className="pv-section" aria-label={text.profile}>
          <h2>{text.profile}</h2>
          <RouteProfile offer={offer} text={text} />
        </section>
      ) : null}
      {offer.climbs?.length ? (
        <section className="pv-section" aria-label={text.climbs}>
          <h2>{text.climbs}</h2>
          <ul aria-label={text.climbs} style={CLIMBS}>
            {offer.climbs.map((climb) => (
              <li key={climb.end} style={CLIMB}>
                <span role="img" aria-label={climbCategory(climb, text)} style={CATEGORY_BADGE}>
                  {climb.category}
                </span>
                <span style={{ display: 'grid' }}>
                  {climb.name ? <strong>{climb.name}</strong> : null}
                  <span className={climb.name ? 'pv-muted' : undefined}>{describeClimb(climb, text)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {credits ? (
        <p className="pv-muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>
          {text.credits(credits.author, credits.source, credits.license, credits.url)}
        </p>
      ) : null}
    </DetailPage>
  );
}

function RideAreaView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
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
            {offers.some((offer) => offer.kind === kind) ? text.noMatch : none}
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

  if (open) {
    return <RouteDetails ctx={ctx} offer={open} onClose={() => setOpenId(undefined)} />;
  }
  return (
    <AreaPage title={text.title} intro={text.intro}>
          <section className="pv-section" aria-label={text.filters}>
            <div className="pv-row">
              {FILTERS.map((filter) => (
                <Toggle
                  key={filter}
                  label={text.filter[filter]}
                  on={state.filters.includes(filter)}
                  onChange={(on) => toggleFilter(filter, on)}
                />
              ))}
            </div>
          </section>
          {section(text.worlds, 'world', text.noWorld)}
          {section(text.videos, 'video', text.noVideo)}
          <section className="pv-section">
            <h2>{text.later}</h2>
            <div className="pv-card">
              <div className="pv-row">
                <span className="pv-glyph" aria-hidden="true" style={iconStyle(MOUNTAIN)} />
                <span className="pv-muted">{text.laterAbout}</span>
              </div>
            </div>
          </section>
          <section className="pv-section">
            <h2>{text.onToday}</h2>
            <div className="pv-row">
              <Toggle
                label={text.showOnToday}
                on={state.showOnToday}
                onChange={(on) => change((s) => ({ ...s, showOnToday: on }))}
              />
            </div>
          </section>
    </AreaPage>
  );
}

/** The card on Today: the route ridden last, one click to ride it again while it is on the device. */
function RideAgainView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const [state, change] = useRide(ctx);
  const offers = useOffers(ctx);
  const go = useGo(ctx);
  if (!state.showOnToday) return null;
  const offer = offers.find((o) => o.id === state.lastRoute) ?? offers.find((o) => o.id === FIRST_ROUTE);
  if (!offer || offer.availability.state !== 'ready') return null;
  return (
    <TodayCard
      classifier={text.rideAgain}
      icon={BIKE}
      title={offer.title}
      details={facts(offer, text)}
      image={offer.thumbnail}
      backdrop={offer.thumbnail ? undefined : <Profile offer={offer} text={text} />}
      onHide={() => change((s) => ({ ...s, showOnToday: false }))}
    >
      <div className="pv-row">
        <button type="button" className="pv-button pv-primary" onClick={() => go(offer)}>
          <span className="pv-glyph" aria-hidden="true" style={iconStyle(BIKE)} />
          {text.rideAgainButton(offer.title)}
        </button>
      </div>
    </TodayCard>
  );
}

export const RideArea = reactComponent((ctx) => <RideAreaView ctx={ctx} />);
export const RideAgainTile = reactComponent((ctx) => <RideAgainView ctx={ctx} />);
function RideMenuEntryView({ ctx }: { readonly ctx: UiContext }) {
  return <MenuEntry ctx={ctx} screen="ride" label={useMessages(ctx, messages).title} icon={BIKE} />;
}

export const RideMenuEntry = reactComponent((ctx) => <RideMenuEntryView ctx={ctx} />);
