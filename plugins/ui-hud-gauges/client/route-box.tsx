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
import { HUD_CHART_WELL, HUD_LABEL, HUD_PANEL_GLASS } from './hud-style.ts';
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

const WIDTH = 300;
const MAP = { width: WIDTH - 20, height: 190, pad: 16 } as const;
/** What shows of the map once it leans back: the plane's foot stays, its top recedes. */
const MAP_VIEW = 120;
const PROFILE = { width: WIDTH - 32, height: 48 } as const;
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

/** A cockpit header scrim inside the map container: `ROUTE` micro-label + single-line route title. */
function MapTitleScrim({ label, title }: { readonly label: string; readonly title: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: '0 0 auto 0',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '7px 10px 18px',
        background:
          'linear-gradient(180deg, rgb(6 10 18 / .92) 0%, rgb(6 10 18 / .64) 64%, transparent 100%)',
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
 * The track alone, without a map: the whole track, the part ridden over it and the rider, on a
 * plane leaning back. Where no map can be drawn (no WebGL, offline).
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
        borderRadius: 10,
        background: 'radial-gradient(95% 85% at 50% 100%, rgb(36 62 102 / .5), rgb(5 9 18 / .72))',
        boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / .1)',
      }}
    >
      <div data-tilt="" style={{ transform: TILT, transformOrigin: '50% 100%', marginTop: MAP_VIEW - MAP.height }}>
        <svg viewBox={`0 0 ${MAP.width} ${MAP.height}`} width="100%" height={MAP.height} aria-hidden="true">
          {/* A faint radar grid, so the plane reads as ground. */}
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
            stroke="rgb(255 255 255 / .58)"
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
              <circle cx={rider.x} cy={rider.y} r={9} fill="rgb(204 255 0 / .26)" />
              <circle cx={rider.x} cy={rider.y} r={5} fill="var(--ridrs-accent)" stroke="#07090e" strokeWidth={2} />
            </g>
          ) : null}
        </svg>
      </div>
      <MapTitleScrim label={label} title={title} />
    </div>
  );
}

/** The live map's height in the box: a little taller than the track alone. */
const LIVE_HEIGHT = 148;

/**
 * The map of the route: a real map leaning back where the page can draw one (ADR 0097), else the
 * track alone. A map that fails to load hands over to the track for the rest of the ride.
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
        borderRadius: 10,
        background: 'var(--ridrs-surface)',
        boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / .1)',
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
          right: 5,
          bottom: 4,
          padding: '1px 5px',
          borderRadius: 4,
          backgroundColor: 'rgb(5 9 18 / .58)',
          fontSize: 8,
          lineHeight: 1.25,
          color: 'rgb(255 255 255 / .68)',
        }}
      >
        {MAP_ATTRIBUTION}
      </span>
    </div>
  );
}

/**
 * The elevation profile inside a recessed dark well, shaded vertically like the central segment
 * profile, with the rider beacon riding directly on the elevation curve and the remaining/total
 * distance inside a dark frosted capsule so it never collides visually with the terrain line.
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
  const shadeId = `route-shade-${useId().replace(/[^A-Za-z0-9-]/g, '')}`;
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
  const firstX = line[0]?.x ?? 0;
  const lastX = line.at(-1)?.x ?? PROFILE.width;
  const areaPoints = polyline([{ x: firstX, y: PROFILE.height }, ...line, { x: lastX, y: PROFILE.height }]);

  return (
    <div
      data-testid="route-profile"
      {...(at === undefined ? {} : { 'data-at': String(at) })}
      style={{
        ...HUD_CHART_WELL,
        position: 'relative',
        padding: '5px 6px',
        overflow: 'hidden',
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
          <linearGradient id={shadeId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#050912" stopOpacity={0} />
            <stop offset="100%" stopColor="#050912" stopOpacity={0.68} />
          </linearGradient>
        </defs>
        <line
          x1={0}
          y1={PROFILE.height * 0.5}
          x2={PROFILE.width}
          y2={PROFILE.height * 0.5}
          stroke="rgb(255 255 255 / .07)"
          strokeDasharray="2 4"
        />
        {stretches.map((stretch) => (
          <polygon
            key={stretch.from}
            points={stretch.polygon}
            fill={stretch.colour}
            stroke={stretch.colour}
            strokeWidth={0.6}
            opacity={at !== undefined && stretch.to <= at ? 0.94 : 0.56}
          />
        ))}
        <polygon points={areaPoints} fill={`url(#${shadeId})`} />
        <polyline
          points={polyline(line)}
          fill="none"
          stroke="rgb(255 255 255 / .88)"
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
        {x === undefined || riderY === undefined ? null : (
          <g>
            <line x1={x} y1={0} x2={x} y2={PROFILE.height} stroke="var(--ridrs-accent)" strokeWidth={1.5} />
            <circle cx={x} cy={riderY} r={6} fill="rgb(204 255 0 / .24)" />
            <circle
              data-testid="route-profile-rider"
              cx={x}
              cy={riderY}
              r={3.5}
              fill="var(--ridrs-accent)"
              stroke="#07090e"
              strokeWidth={1.6}
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
            right: 6,
            ...(align === 'top' ? { top: 5 } : { bottom: 5 }),
            padding: '2px 8px',
            borderRadius: 'var(--ridrs-radius-pill)',
            backgroundColor: 'rgb(7 11 20 / .84)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / .14)',
            fontFamily: 'var(--ridrs-font-mono)',
            fontSize: 'var(--ridrs-size-label)',
            fontWeight: 500,
            lineHeight: 1.25,
            fontVariantNumeric: 'tabular-nums',
            color: '#f1f5f9',
          }}
        >
          {distanceLabel}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The route navigator at the top right, drawn in the same frosted dark HUD glass as the gauges and
 * central telemetry: the tilted map with its labelled single-line route title along the top edge,
 * and below it the recessed shaded elevation profile with the remaining / total distance capsule.
 * Hidden on a free ride without a route.
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
        width: 'clamp(284px, 22vw, 312px)',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 10,
        pointerEvents: 'none',
      }}
    >
      {track ? (
        <RouteMap track={track} label={text.route} title={offer.title} {...(placed ? { position: placed } : {})} />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 4px' }}>
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
            padding: '2px 8px',
            borderRadius: 'var(--ridrs-radius-pill)',
            backgroundColor: 'rgb(7 11 20 / .84)',
            boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / .14)',
            fontFamily: 'var(--ridrs-font-mono)',
            fontSize: 'var(--ridrs-size-label)',
            fontWeight: 500,
            fontVariantNumeric: 'tabular-nums',
            color: '#f1f5f9',
          }}
        >
          {fallbackDistance}
        </span>
      ) : null}
    </section>
  );
}
