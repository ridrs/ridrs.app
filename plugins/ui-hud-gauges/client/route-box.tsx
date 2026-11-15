// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  type PhysicsState,
  physicsStateEvent,
  type RouteOffer,
  routeOfferState,
  type WorldPosition,
  worldPositionEvent,
} from '@ridrs/contracts';
import { besideControl, entryNamed, findControl, parseTrackPositions, type TrackPosition } from '@ridrs/ride';
import { formatDecimal, localizeNumber, type UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { useEffect, useMemo, useState } from 'react';
import { messages } from './i18n/index.ts';
import { fitPlaces, gradeColour, nearestIndex, polyline, profileOf, thin } from './route.ts';

const EN_DASH = '–';
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

/** The route of the ride: the offer whose world route the running ride rides; none for a free ride. */
function useRideRoute(ctx: UiContext): RouteOffer | undefined {
  const [route, setRoute] = useState<string>();
  useEffect(
    () =>
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) =>
        setRoute(payload.state === 'idle' ? undefined : payload.world?.route),
      ),
    [ctx],
  );
  const offers = useStateEntries(ctx, routeOfferState);
  return route === undefined ? undefined : [...offers.values()].find((offer) => offer.world?.route === route);
}

/**
 * Where the route's GPX track runs, read from its ride package (ADR 0094) as the video world
 * reads it: the control file names the track. None while it loads, and none when the route is not
 * on the device or its package has no track.
 */
function useTrack(offer: RouteOffer | undefined): TrackPosition[] | undefined {
  const files = offer?.availability.state === 'ready' ? offer.availability.files : undefined;
  const [track, setTrack] = useState<TrackPosition[]>();
  useEffect(() => {
    setTrack(undefined);
    if (!files) return undefined;
    let current = true;
    const paths = Object.keys(files);
    const read = async (path: string) => new Uint8Array(await (await fetch(files[path] ?? '')).arrayBuffer());
    (async () => {
      const found = await findControl(paths, read);
      const gpx = found ? entryNamed(paths, besideControl(found.path, found.control.gpx)) : undefined;
      if (!gpx) return;
      const positions = parseTrackPositions(new TextDecoder().decode(await read(gpx)));
      if (current && positions.length > 1) setTrack(positions);
    })().catch(() => {
      // A track that cannot be read leaves the map out; the rest of the box stays.
    });
    return () => {
      current = false;
    };
  }, [files]);
  return track;
}

/** The map: the whole track, the part ridden over it and the rider, on a plane leaning back. */
function RouteMap({ track, position }: { readonly track: TrackPosition[]; readonly position?: WorldPosition }) {
  const shown = useMemo(() => thin(track, MAX_POINTS), [track]);
  const project = useMemo(() => fitPlaces(shown, MAP.width, MAP.height, MAP.pad), [shown]);
  const points = useMemo(() => shown.map(project), [shown, project]);
  const here = position ? nearestIndex(shown, position) : undefined;
  const rider = position ? project(position) : undefined;

  return (
    <div
      data-testid="route-map"
      style={{
        height: MAP_VIEW,
        overflow: 'hidden',
        borderRadius: 10,
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
              stroke="#b8f53b"
              strokeWidth={3.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
          {rider ? (
            <g data-testid="route-rider">
              <circle cx={rider.x} cy={rider.y} r={9} fill="rgb(184 245 59 / .25)" />
              <circle cx={rider.x} cy={rider.y} r={5} fill="#b8f53b" stroke="#0d1626" strokeWidth={2} />
            </g>
          ) : null}
        </svg>
      </div>
    </div>
  );
}

/** The elevation profile, coloured by gradient, the part ridden full and the rest faint. */
function RouteProfile({ offer, distance }: { readonly offer: RouteOffer; readonly distance?: number }) {
  const { stretches, line } = useMemo(
    () => profileOf(offer.sparkline ?? [], offer.distance, PROFILE.width, PROFILE.height),
    [offer],
  );
  const at = distance === undefined || offer.distance <= 0 ? undefined : Math.min(Math.max(distance / offer.distance, 0), 1);
  const x = at === undefined ? undefined : at * PROFILE.width;
  return (
    <svg
      data-testid="route-profile"
      {...(at === undefined ? {} : { 'data-at': String(at) })}
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
          <line x1={x} y1={0} x2={x} y2={PROFILE.height} stroke="#b8f53b" strokeWidth={1.5} />
          <circle cx={x} cy={4} r={3.5} fill="#b8f53b" />
        </g>
      )}
    </svg>
  );
}

/**
 * The route at the top right, a HUD element drawn like a ride card: first the map of the route,
 * tilted, then its elevation profile, then the current gradient. A ride without a route shows the
 * gradient only; the map needs the route's track, the profile its elevations.
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

  const percent = state ? state.road.gradient * 100 : undefined;
  const hasProfile = (offer?.sparkline?.length ?? 0) > 1;

  return (
    <section
      data-testid="route-box"
      aria-label={offer?.title ?? text.gradient}
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
        borderRadius: 16,
        background:
          'radial-gradient(120% 90% at 85% 0%, #2a4a78 0%, transparent 60%), linear-gradient(160deg, #1b2d4d, #0d1626)',
        boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / .12), 0 10px 28px rgb(0 0 0 / .38)',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'none',
      }}
    >
      {track ? <RouteMap track={track} {...(position ? { position } : {})} /> : null}
      {offer && hasProfile ? <RouteProfile offer={offer} {...(state ? { distance: state.distance } : {})} /> : null}
      <div data-testid="route-gradient" style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span
          style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', opacity: 0.82 }}
        >
          {text.gradient}
        </span>
        <span
          data-testid="value"
          style={{
            marginLeft: 'auto',
            fontSize: 26,
            fontWeight: 800,
            fontVariantNumeric: 'tabular-nums',
            color: percent === undefined ? '#fff' : gradeColour(percent),
          }}
        >
          {percent === undefined ? EN_DASH : localizeNumber(formatDecimal(percent, 1), language)}
        </span>
        <span data-testid="unit" style={{ fontSize: 13, fontWeight: 600, opacity: 0.82 }}>
          %
        </span>
      </div>
    </section>
  );
}
