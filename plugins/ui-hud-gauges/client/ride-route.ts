// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  type RouteOffer,
  routeOfferState,
  type WorldPosition,
} from '@ridrs/contracts';
import { besideControl, entryNamed, findControl, parseTrackPositions, type TrackPosition } from '@ridrs/ride';
import type { UiContext } from '@ridrs/ui-sdk';
import { useStateEntries } from '@ridrs/ui-sdk/react';
import { useEffect, useRef, useState } from 'react';
import { locateOnTrack, type MeasuredPlace, trackOffset } from './route.ts';

/** The route of the ride: the offer whose world route the running ride rides; none for a free ride. */
export function useRideRoute(ctx: UiContext): RouteOffer | undefined {
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
export function useTrack(offer: RouteOffer | undefined): TrackPosition[] | undefined {
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

/**
 * m the route's track runs ahead of the odometer, from where the world puts the rider: a cut of
 * the video skips road the track runs along and the odometer never counts. 0 before the first
 * position, on a new track and when a new ride starts its odometer again.
 */
export function useTrackOffset(
  track: readonly MeasuredPlace[] | undefined,
  position: WorldPosition | undefined,
): number {
  const [offset, setOffset] = useState(0);
  const last = useRef<{ track: readonly MeasuredPlace[]; distance: number }>(undefined);
  useEffect(() => {
    if (!track || !position) return;
    const before = last.current;
    const same = before?.track === track && position.distance >= before.distance;
    const switched = before !== undefined && before.track !== track;
    setOffset((previous) => {
      if (same) {
        return trackOffset(track, position, previous);
      }
      if (!switched && locateOnTrack(track, position, position.distance) !== undefined) {
        return trackOffset(track, position, 0);
      }
      return trackOffset(track, position, -position.distance);
    });
    last.current = { track, distance: position.distance };
  }, [track, position]);
  return track && position ? offset : 0;
}
