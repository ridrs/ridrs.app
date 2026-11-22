// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorldPosition } from '@ridrs/contracts';
import type { TrackPosition } from '@ridrs/ride';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { headingAt, indexAtDistance, type MeasuredPlace, measureTrack, type Place, thin } from './route.ts';

/**
 * OpenFreeMap's dark blue style (ADR 0097), in the colours of the ride cards: free, no key, from
 * OpenStreetMap through OpenMapTiles.
 */
const STYLE = 'https://tiles.openfreemap.org/styles/fiord';
/** What the style asks to be shown with the map. */
export const MAP_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap';
/** How far the map leans back, in degrees from straight down. */
const PITCH = 52;
/** How close the camera follows the rider: a few hundred metres of road ahead. */
const ZOOM = 14.5;
/** Points of the track the map draws at most. */
const MAX_POINTS = 2000;
/** ms between two camera moves: the position comes often, the map glides between them. */
const CAMERA_EVERY = 1000;

const LIME = '#ccff00';

/** Whether this page can draw a WebGL map at all; the headless scenarios cannot. */
export function canDrawMap(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/** The rules MapLibre's own stylesheet would give the map; the box does without the whole file. */
const MAP_CSS = `
.rb-live.maplibregl-map { overflow: hidden; }
.rb-live .maplibregl-canvas-container, .rb-live .maplibregl-canvas { position: absolute; inset: 0; }
.rb-live .maplibregl-canvas { outline: none; }
`;

/** A GeoJSON line, as MapLibre takes it. */
interface Line {
  readonly type: 'Feature';
  readonly properties: Record<string, never>;
  readonly geometry: { readonly type: 'LineString'; readonly coordinates: number[][] };
}

/** A GeoJSON point, as MapLibre takes it. */
interface Spot {
  readonly type: 'Feature';
  readonly properties: Record<string, never>;
  readonly geometry: { readonly type: 'Point'; readonly coordinates: number[] };
}

const line = (places: readonly Place[]): Line => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: places.map((p) => [p.longitude, p.latitude]) },
});

const spot = (place: Place): Spot => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'Point', coordinates: [place.longitude, place.latitude] },
});

/**
 * Shows the rider and the part ridden on `target`, and moves its camera at most once per
 * `CAMERA_EVERY` (`now` moves it at once, without a glide): centred low on the rider, turned to the
 * direction of travel. `lastCamera` keeps the time of the last move.
 */
function follow(
  target: MapLibreMap,
  places: readonly MeasuredPlace[],
  at: WorldPosition | undefined,
  height: number,
  lastCamera: { current: number },
  now = false,
): void {
  // Before the first position the rider is at the start: the map faces the way the route begins.
  const start = places[0];
  const known = at ?? (start ? { distance: 0, latitude: start.latitude, longitude: start.longitude } : undefined);
  if (!known) return;
  const here = indexAtDistance(places, known.distance);
  const ridden = at ? [...places.slice(0, here + 1), at] : places.slice(0, here + 1);
  (target.getSource('ridden') as GeoJSONSource | undefined)?.setData(line(ridden));
  if (at) (target.getSource('rider') as GeoJSONSource | undefined)?.setData(spot(at));
  const time = performance.now();
  if (!now && time - lastCamera.current < CAMERA_EVERY) return;
  lastCamera.current = time;
  target.easeTo({
    center: [known.longitude, known.latitude],
    bearing: headingAt(places, here),
    pitch: PITCH,
    zoom: ZOOM,
    // The rider sits low in the view, with the road ahead above.
    offset: [0, height * 0.22],
    duration: now ? 0 : CAMERA_EVERY,
    easing: (t) => t,
  });
}

/**
 * The route on a real map (ADR 0097): OpenFreeMap's tiles under the track, the part ridden and the
 * rider, leaning back, always turned to the direction of travel: at the start before the first
 * position, then following the rider. `onFail` hands over to the track alone
 * when the map cannot be drawn: no style (offline), or the library does not load.
 */
export function LiveMap({
  track,
  position,
  height,
  onFail,
}: {
  readonly track: TrackPosition[];
  readonly position?: WorldPosition;
  readonly height: number;
  readonly onFail: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap>(undefined);
  const ready = useRef(false);
  const shown = useRef<MeasuredPlace[]>([]);
  const lastCamera = useRef(0);
  const latest = useRef(position);
  latest.current = position;
  const fail = useRef(onFail);
  fail.current = onFail;

  // One map per track: it loads its style and the layers once.
  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    let cancelled = false;
    shown.current = thin(measureTrack(track), MAX_POINTS);
    // MapLibre finds its worker beside its own file only on an http page; the native app is not
    // one. The bundler builds the worker and names its URL (ADR 0097).
    Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url')])
      .then(([{ Map, setWorkerUrl }, { default: workerUrl }]) => {
        if (cancelled) return;
        setWorkerUrl(workerUrl);
        const created = new Map({
          container: element,
          style: STYLE,
          attributionControl: false,
          interactive: false,
          pitch: PITCH,
          center: [shown.current[0]?.longitude ?? 0, shown.current[0]?.latitude ?? 0],
          zoom: ZOOM,
        });
        map.current = created;
        let styled = false;
        created.on('error', () => {
          // A missing tile is no reason to give up the map; a missing style is.
          if (!styled && !cancelled) fail.current();
        });
        created.on('load', () => {
          styled = true;
          created.addSource('track', { type: 'geojson', data: line(shown.current) });
          created.addSource('ridden', { type: 'geojson', data: line([]) });
          created.addSource('rider', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          created.addLayer({
            id: 'track-casing',
            type: 'line',
            source: 'track',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#0d1626', 'line-width': 9, 'line-opacity': 0.85 },
          });
          created.addLayer({
            id: 'track',
            type: 'line',
            source: 'track',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            // Wider than any road and edged dark, so the route stands out from the roads beside it.
            paint: { 'line-color': '#f2f5fa', 'line-width': 5 },
          });
          created.addLayer({
            id: 'ridden',
            type: 'line',
            source: 'ridden',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': LIME, 'line-width': 5.5 },
          });
          created.addLayer({
            id: 'rider-halo',
            type: 'circle',
            source: 'rider',
            paint: { 'circle-radius': 12, 'circle-color': LIME, 'circle-opacity': 0.25 },
          });
          created.addLayer({
            id: 'rider',
            type: 'circle',
            source: 'rider',
            paint: {
              'circle-radius': 6,
              'circle-color': LIME,
              'circle-stroke-color': '#0d1626',
              'circle-stroke-width': 2,
            },
          });
          ready.current = true;
          follow(created, shown.current, latest.current, height, lastCamera, true);
        });
      })
      .catch(() => {
        if (!cancelled) fail.current();
      });
    return () => {
      cancelled = true;
      ready.current = false;
      map.current?.remove();
      map.current = undefined;
    };
  }, [track, height]);

  useEffect(() => {
    if (map.current && ready.current) follow(map.current, shown.current, position, height, lastCamera);
  }, [position, height]);

  return (
    <>
      <style>{MAP_CSS}</style>
      <div ref={container} className="rb-live" style={{ position: 'absolute', inset: 0 }} />
    </>
  );
}
