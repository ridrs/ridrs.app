// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type Language,
  type PhysicsState,
  physicsStateEvent,
  type RouteOffer,
  type WorldPosition,
  worldPositionEvent,
} from '@ridrs/contracts';
import type { TrackPosition } from '@ridrs/ride';
import { formatDecimal, localizeNumber, type UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages } from '@ridrs/ui-sdk/react';
import { useEffect, useMemo, useState } from 'react';
import { messages } from './i18n/index.ts';
import { canDrawMap, LiveMap, MAP_ATTRIBUTION } from './live-map.tsx';
import { useRideRoute, useTrack, useTrackOffset } from './ride-route.ts';
import { distanceLabelAlign, fitPlaces, indexAtDistance, measureTrack, polyline, profileOf, thin } from './route.ts';

const WIDTH = 300;
const MAP = { width: WIDTH - 24, height: 190, pad: 16 } as const;
/** What shows of the map once it leans back: the plane's foot stays, its top recedes. */
const MAP_VIEW = 118;
const PROFILE = { width: WIDTH - 24, height: 52 } as const;
/** Points of the track the map draws at most: enough for its size, cheap to redraw. */
const MAX_POINTS = 400;
/** The lines of the map's ground grid. */
const GRID_X = [0, 1, 2, 3, 4, 5, 6].map((i) => (i * MAP.width) / 6);
const GRID_Y = [0, 1, 2, 3, 4].map((i) => (i * MAP.height) / 4);
/** How much the map leans back, as if seen from above and behind. */
const TILT = 'perspective(420px) rotateX(38deg)';

const SINGLE_LINE_TITLE = {
  display: 'block',
  width: '100%',
  fontSize: 'var(--ridrs-size-small)',
  fontWeight: 500,
  lineHeight: 1.3,
  color: 'var(--ridrs-text)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const;

/** A single-line route title laid onto a subtle top scrim inside the map container. */
function MapTitleScrim({ title }: { readonly title: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: '0 0 auto 0',
        padding: '6px 10px 16px',
        background:
          'linear-gradient(180deg, rgb(11 18 32 / .86) 0%, rgb(11 18 32 / .48) 65%, transparent 100%)',
        pointerEvents: 'none',
      }}
    >
      <span data-testid="route-title" style={SINGLE_LINE_TITLE}>
        {title}
      </span>
    </div>
  );
}

/**
 * The track alone, without a map: the whole track, the part ridden over it and the rider, on a
 * plane leaning back. Where no map can be drawn (no WebGL, offline).
 */
function TrackMap({
  track,
  title,
  position,
}: {
  readonly track: TrackPosition[];
  readonly title: string;
  readonly position?: WorldPosition;
}) {
  const shown = useMemo(() => thin(measureTrack(track), MAX_POINTS), [track]);
  const project = useMemo(() => fitPlaces(shown, MAP.width, MAP.height, MAP.pad), [shown]);
  const points = useMemo(() => shown.map(project), [shown, project]);
  const here = position ? indexAtDistance(shown, position.distance) : undefined;
  const rider = position ? project(position) : undefined;

  return (
    <div
      data-testid="route-map"
      data-map="track"
      style={{
        position: 'relative',
        height: MAP_VIEW,
        overflow: 'hidden',
        borderRadius: 'var(--ridrs-radius)',
        background: 'radial-gradient(90% 80% at 50% 100%, rgb(42 74 120 / .45), rgb(6 10 20 / .55))',
      }}
    >
      <div data-tilt="" style={{ transform: TILT, transformOrigin: '50% 100%', marginTop: MAP_VIEW - MAP.height }}>
        <svg viewBox={`0 0 ${MAP.width} ${MAP.height}`} width="100%" height={MAP.height} aria-hidden="true">
          {/* A faint grid, so the plane reads as ground. */}
          {GRID_X.map((x) => (
            <line key={`x${x}`} x1={x} y1={0} x2={x} y2={MAP.height} stroke="rgb(255 255 255 / .07)" />
          ))}
          {GRID_Y.map((y) => (
            <line key={`y${y}`} x1={0} y1={y} x2={MAP.width} y2={y} stroke="rgb(255 255 255 / .07)" />
          ))}
          <polyline
            data-testid="route-track"
            points={polyline(points)}
            fill="none"
            stroke="rgb(255 255 255 / .55)"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {here !== undefined && here > 0 ? (
            <polyline
              data-testid="route-ridden"
              points={polyline(points.slice(0, here + 1))}
              fill="none"
              stroke="var(--ridrs-accent)"
              strokeWidth={3.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
          {rider ? (
            <g data-testid="route-rider">
              <circle cx={rider.x} cy={rider.y} r={9} fill="rgb(204 255 0 / .25)" />
              <circle cx={rider.x} cy={rider.y} r={5} fill="var(--ridrs-accent)" stroke="var(--ridrs-surface)" strokeWidth={2} />
            </g>
          ) : null}
        </svg>
      </div>
      <MapTitleScrim title={title} />
    </div>
  );
}

/** The live map's height in the box: a little taller than the track alone. */
const LIVE_HEIGHT = 150;

/**
 * The map of the route: a real map leaning back where the page can draw one (ADR 0097), else the
 * track alone. A map that fails to load hands over to the track for the rest of the ride.
 */
function RouteMap({
  track,
  title,
  position,
}: {
  readonly track: TrackPosition[];
  readonly title: string;
  readonly position?: WorldPosition;
}) {
  const [failed, setFailed] = useState(false);
  const live = useMemo(() => canDrawMap(), []);
  if (!live || failed) return <TrackMap track={track} title={title} {...(position ? { position } : {})} />;
  return (
    <div
      data-testid="route-map"
      data-map="live"
      style={{ position: 'relative', height: LIVE_HEIGHT, overflow: 'hidden', borderRadius: 'var(--ridrs-radius)', background: 'var(--ridrs-surface)' }}
    >
      <LiveMap
        track={track}
        {...(position ? { position } : {})}
        height={LIVE_HEIGHT}
        onFail={() => setFailed(true)}
      />
      <MapTitleScrim title={title} />
      <span
        style={{
          position: 'absolute',
          right: 4,
          bottom: 2,
          fontSize: 8,
          lineHeight: 1.2,
          color: 'rgb(255 255 255 / .7)',
          textShadow: '0 1px 2px rgb(0 0 0 / .8)',
        }}
      >
        {MAP_ATTRIBUTION}
      </span>
    </div>
  );
}

/**
 * The elevation profile, coloured by gradient, the part ridden full and the rest faint, with the
 * remaining and total distance tucked into its upper or lower right corner so it avoids the line.
 */
function RouteProfile({
  offer,
  distance,
  language,
}: {
  readonly offer: RouteOffer;
  readonly distance?: number;
  readonly language: Language;
}) {
  const { stretches, line } = useMemo(
    () => profileOf(offer.sparkline ?? [], offer.distance, PROFILE.width, PROFILE.height),
    [offer],
  );
  const at =
    distance === undefined || offer.distance <= 0 ? undefined : Math.min(Math.max(distance / offer.distance, 0), 1);
  const x = at === undefined ? undefined : at * PROFILE.width;
  const align = useMemo(() => distanceLabelAlign(line, PROFILE.width, PROFILE.height), [line]);
  const distanceLabel =
    offer.distance > 0
      ? `${localizeNumber(formatDecimal(Math.max(0, offer.distance - (distance ?? 0)) / 1000, 1), language)} / ${localizeNumber(formatDecimal(offer.distance / 1000, 1), language)} km`
      : undefined;

  return (
    <div
      data-testid="route-profile"
      {...(at === undefined ? {} : { 'data-at': String(at) })}
      style={{ position: 'relative', height: PROFILE.height }}
    >
      <svg
        viewBox={`0 0 ${PROFILE.width} ${PROFILE.height}`}
        width="100%"
        height={PROFILE.height}
        aria-hidden="true"
        style={{ display: 'block' }}
      >
        {stretches.map((stretch) => (
          <polygon
            key={stretch.from}
            points={stretch.polygon}
            fill={stretch.colour}
            // Its own colour round the edge closes the hairline seams between neighbours.
            stroke={stretch.colour}
            strokeWidth={0.6}
            opacity={at !== undefined && stretch.to <= at ? 0.95 : 0.55}
          />
        ))}
        <polyline points={polyline(line)} fill="none" stroke="rgb(255 255 255 / .8)" strokeWidth={1.5} />
        {x === undefined ? null : (
          <g>
            <line x1={x} y1={0} x2={x} y2={PROFILE.height} stroke="var(--ridrs-accent)" strokeWidth={1.5} />
            <circle cx={x} cy={4} r={3.5} fill="var(--ridrs-accent)" />
          </g>
        )}
      </svg>
      {distanceLabel ? (
        <span
          data-testid="route-distance"
          data-align={align}
          style={{
            position: 'absolute',
            right: 2,
            ...(align === 'top' ? { top: 1 } : { bottom: 1 }),
            fontFamily: 'var(--ridrs-font-mono)',
            fontSize: 'var(--ridrs-size-label)',
            fontWeight: 500,
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--ridrs-text)',
            textShadow: '0 1px 3px rgb(7 9 14 / .95)',
          }}
        >
          {distanceLabel}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The route at the top right, a HUD element drawn like a ride card: the tilted map with the
 * route's single-line title along its top edge, and below it the whole-route elevation profile
 * with the remaining / total distance tucked inside. Hidden on a free ride without a route.
 */
export function RouteBoxView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  const offer = useRideRoute(ctx);
  const track = useTrack(offer);
  const [state, setState] = useState<PhysicsState>();
  const [position, setPosition] = useState<WorldPosition>();
  useEffect(() => ctx.events.subscribe(physicsStateEvent, ({ payload }) => setState(payload)), [ctx]);
  useEffect(() => ctx.events.subscribe(worldPositionEvent, ({ payload }) => setPosition(payload)), [ctx]);

  const measured = useMemo(() => (track ? measureTrack(track) : undefined), [track]);
  const offset = useTrackOffset(measured, position);
  // The maps and the profile measure along the track, cuts of the video included.
  const placed = useMemo(
    () => (position ? { ...position, distance: position.distance + offset } : undefined),
    [position, offset],
  );

  if (!offer) return null;

  const hasProfile = (offer.sparkline?.length ?? 0) > 1;
  const trackDistance = state ? state.distance + offset : undefined;
  const fallbackDistance =
    !hasProfile && offer.distance > 0
      ? `${localizeNumber(formatDecimal(Math.max(0, offer.distance - (trackDistance ?? 0)) / 1000, 1), language)} / ${localizeNumber(formatDecimal(offer.distance / 1000, 1), language)} km`
      : undefined;

  return (
    <section
      data-testid="route-box"
      aria-label={offer.title ?? text.gradient}
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        width: WIDTH,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        borderRadius: 'var(--ridrs-radius-lg)',
        background: 'var(--ridrs-card)',
        boxShadow: 'var(--ridrs-edge), var(--ridrs-shadow)',
        color: 'var(--ridrs-text)',
        fontFamily: 'var(--ridrs-font-text)',
        pointerEvents: 'none',
      }}
    >
      {track ? (
        <RouteMap track={track} title={offer.title} {...(placed ? { position: placed } : {})} />
      ) : (
        <span data-testid="route-title" style={SINGLE_LINE_TITLE}>
          {offer.title}
        </span>
      )}
      {hasProfile ? (
        <RouteProfile offer={offer} language={language} {...(trackDistance !== undefined ? { distance: trackDistance } : {})} />
      ) : fallbackDistance ? (
        <span
          data-testid="route-distance"
          style={{
            alignSelf: 'flex-end',
            fontFamily: 'var(--ridrs-font-mono)',
            fontSize: 'var(--ridrs-size-label)',
            fontWeight: 500,
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--ridrs-text-muted)',
          }}
        >
          {fallbackDistance}
        </span>
      ) : null}
    </section>
  );
}
