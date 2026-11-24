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
import { useEffect, useId, useMemo, useState } from 'react';
import { HUD_LABEL, HUD_PANEL_GLASS } from './hud-style.ts';
import { messages } from './i18n/index.ts';
import { canDrawMap, LiveMap, MAP_ATTRIBUTION } from './live-map.tsx';
import { useRideRoute, useTrack, useTrackOffset } from './ride-route.ts';
import {
  distanceLabelAlign,
  fitPlaces,
  indexAtDistance,
  measureTrack,
  polyline,
  profileOf,
  profileYAt,
  thin,
} from './route.ts';

const WIDTH = 296;
const MAP = { width: WIDTH, height: 186, pad: 16 } as const;
/** What shows of the map once it leans back: the plane's foot stays, its top recedes. */
const MAP_VIEW = 116;
const PROFILE = { width: WIDTH, height: 48 } as const;
/** Points of the track the map draws at most: enough for its size, cheap to redraw. */
const MAX_POINTS = 400;
/** The lines of the map's ground grid. */
const GRID_X = [0, 1, 2, 3, 4, 5, 6].map((i) => (i * MAP.width) / 6);
const GRID_Y = [0, 1, 2, 3, 4].map((i) => (i * MAP.height) / 4);
/** How much the map leans back, as if seen from above and behind. */
const TILT = 'perspective(420px) rotateX(38deg)';

const SINGLE_LINE_TITLE = {
  display: 'block',
  minWidth: 0,
  flex: 1,
  fontSize: 'var(--ridrs-size-small)',
  fontWeight: 500,
  lineHeight: 1.3,
  color: '#f1f5f9',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const;

/** A top scrim flush along the full-bleed map: `ROUTE` micro-label + single-line route title. */
function MapTitleScrim({ label, title }: { readonly label: string; readonly title: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: '0 0 auto 0',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '8px 12px 18px',
        background:
          'linear-gradient(180deg, rgb(8 13 22 / .88) 0%, rgb(8 13 22 / .54) 62%, transparent 100%)',
        pointerEvents: 'none',
      }}
    >
      <span data-testid="label" style={{ ...HUD_LABEL, flexShrink: 0 }}>
        {label}
      </span>
      <span data-testid="route-title" style={SINGLE_LINE_TITLE}>
        {title}
      </span>
    </div>
  );
}

/**
 * The track alone, without a map: full-bleed across the top of `route-box`, on a plane leaning
 * back. Where no map can be drawn (no WebGL, offline).
 */
function TrackMap({
  track,
  label,
  title,
  position,
}: {
  readonly track: TrackPosition[];
  readonly label: string;
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
        background: 'radial-gradient(95% 85% at 50% 100%, rgb(30 52 88 / .34), transparent)',
      }}
    >
      <div data-tilt="" style={{ transform: TILT, transformOrigin: '50% 100%', marginTop: MAP_VIEW - MAP.height }}>
        <svg viewBox={`0 0 ${MAP.width} ${MAP.height}`} width="100%" height={MAP.height} aria-hidden="true">
          {GRID_X.map((x) => (
            <line key={`x${x}`} x1={x} y1={0} x2={x} y2={MAP.height} stroke="rgb(255 255 255 / .06)" />
          ))}
          {GRID_Y.map((y) => (
            <line key={`y${y}`} x1={0} y1={y} x2={MAP.width} y2={y} stroke="rgb(255 255 255 / .06)" />
          ))}
          <polyline
            data-testid="route-track"
            points={polyline(points)}
            fill="none"
            stroke="rgb(255 255 255 / .56)"
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
              <circle cx={rider.x} cy={rider.y} r={8.5} fill="rgb(204 255 0 / .24)" />
              <circle cx={rider.x} cy={rider.y} r={4.8} fill="var(--ridrs-accent)" stroke="#080d16" strokeWidth={2} />
            </g>
          ) : null}
        </svg>
      </div>
      <MapTitleScrim label={label} title={title} />
    </div>
  );
}

/** The live map's height in the box: full-bleed to the outer edges. */
const LIVE_HEIGHT = 140;

/**
 * The map of the route: a real map leaning back where the page can draw one (ADR 0097), else the
 * track alone, bleeding flush to the top, left and right edges of `route-box`.
 */
function RouteMap({
  track,
  label,
  title,
  position,
}: {
  readonly track: TrackPosition[];
  readonly label: string;
  readonly title: string;
  readonly position?: WorldPosition;
}) {
  const [failed, setFailed] = useState(false);
  const live = useMemo(() => canDrawMap(), []);
  if (!live || failed) return <TrackMap track={track} label={label} title={title} {...(position ? { position } : {})} />;
  return (
    <div
      data-testid="route-map"
      data-map="live"
      style={{
        position: 'relative',
        height: LIVE_HEIGHT,
        overflow: 'hidden',
      }}
    >
      <LiveMap
        track={track}
        {...(position ? { position } : {})}
        height={LIVE_HEIGHT}
        onFail={() => setFailed(true)}
      />
      <MapTitleScrim label={label} title={title} />
      <span
        style={{
          position: 'absolute',
          right: 8,
          bottom: 4,
          fontSize: 8,
          lineHeight: 1.2,
          color: 'rgb(255 255 255 / .62)',
          textShadow: '0 1px 2px rgb(0 0 0 / .85)',
        }}
      >
        {MAP_ATTRIBUTION}
      </span>
    </div>
  );
}

/**
 * Full-bleed elevation profile separated from the map by a single 1 px hairline: its grade-coloured
 * terrain fades cleanly to transparent via an SVG mask, the rider dot rides on the elevation curve,
 * and the remaining/total distance sits as flat text without a nested capsule.
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
  const id = useId().replace(/[^A-Za-z0-9-]/g, '');
  const fadeId = `route-fade-${id}`;
  const maskId = `route-mask-${id}`;
  const { stretches, line } = useMemo(
    () => profileOf(offer.sparkline ?? [], offer.distance, PROFILE.width, PROFILE.height),
    [offer],
  );
  const at =
    distance === undefined || offer.distance <= 0 ? undefined : Math.min(Math.max(distance / offer.distance, 0), 1);
  const x = at === undefined ? undefined : at * PROFILE.width;
  const riderY = x === undefined ? undefined : (profileYAt(line, x) ?? 4);
  const align = useMemo(() => distanceLabelAlign(line, PROFILE.width, PROFILE.height), [line]);
  const distanceLabel =
    offer.distance > 0
      ? `${localizeNumber(formatDecimal(Math.max(0, offer.distance - (distance ?? 0)) / 1000, 1), language)} / ${localizeNumber(formatDecimal(offer.distance / 1000, 1), language)} km`
      : undefined;

  return (
    <div
      data-testid="route-profile"
      {...(at === undefined ? {} : { 'data-at': String(at) })}
      style={{
        position: 'relative',
        height: PROFILE.height,
        borderTop: '1px solid rgb(255 255 255 / .08)',
      }}
    >
      <svg
        viewBox={`0 0 ${PROFILE.width} ${PROFILE.height}`}
        width="100%"
        height={PROFILE.height}
        aria-hidden="true"
        style={{ display: 'block' }}
      >
        <defs>
          <linearGradient id={fadeId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={0.72} />
            <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
          </linearGradient>
          <mask id={maskId}>
            <rect x={0} y={0} width={PROFILE.width} height={PROFILE.height} fill={`url(#${fadeId})`} />
          </mask>
        </defs>
        <g mask={`url(#${maskId})`}>
          {stretches.map((stretch) => (
            <polygon
              key={stretch.from}
              points={stretch.polygon}
              fill={stretch.colour}
              stroke={stretch.colour}
              strokeWidth={0.6}
              opacity={at !== undefined && stretch.to <= at ? 0.95 : 0.56}
            />
          ))}
        </g>
        <polyline
          points={polyline(line)}
          fill="none"
          stroke="rgb(255 255 255 / .88)"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        {x === undefined || riderY === undefined ? null : (
          <g>
            <line x1={x} y1={0} x2={x} y2={PROFILE.height} stroke="var(--ridrs-accent)" strokeWidth={1.4} />
            <circle
              data-testid="route-profile-rider"
              cx={x}
              cy={riderY}
              r={3.2}
              fill="var(--ridrs-accent)"
              stroke="#080d16"
              strokeWidth={1.5}
            />
          </g>
        )}
      </svg>
      {distanceLabel ? (
        <span
          data-testid="route-distance"
          data-align={align}
          style={{
            position: 'absolute',
            right: 10,
            ...(align === 'top' ? { top: 5 } : { bottom: 5 }),
            fontFamily: 'var(--ridrs-font-mono)',
            fontSize: 'var(--ridrs-size-label)',
            fontWeight: 500,
            lineHeight: 1.2,
            fontVariantNumeric: 'tabular-nums',
            color: '#f1f5f9',
            textShadow: '0 1px 4px rgb(8 13 22 / .95), 0 0 8px rgb(8 13 22 / .9)',
          }}
        >
          {distanceLabel}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The route navigator at the top right, a flat full-bleed frosted sheet (`padding: 0`): the map
 * bleeds to the top and side edges, and the elevation profile bleeds to the side and bottom edges
 * beneath a 1 px hairline. Hidden on a free ride without a route.
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
        ...HUD_PANEL_GLASS,
        position: 'absolute',
        top: 16,
        right: 16,
        width: WIDTH,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        padding: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      {track ? (
        <RouteMap track={track} label={text.route} title={offer.title} {...(placed ? { position: placed } : {})} />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 12px' }}>
          <span style={{ ...HUD_LABEL, flexShrink: 0 }}>{text.route}</span>
          <span data-testid="route-title" style={SINGLE_LINE_TITLE}>
            {offer.title}
          </span>
        </div>
      )}
      {hasProfile ? (
        <RouteProfile offer={offer} language={language} {...(trackDistance !== undefined ? { distance: trackDistance } : {})} />
      ) : fallbackDistance ? (
        <span
          data-testid="route-distance"
          style={{
            alignSelf: 'flex-end',
            padding: '0 12px 9px',
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
