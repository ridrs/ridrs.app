// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The video library: one folder per route, each with an Incyclist control file (`gpx-import`),
 * the video and the GPX track it names. The app serves the library under `LIBRARY_URL`; its
 * index lists the folders and their control files.
 */

import { VIDEO_ROUTE_FILE, videoRouteSchema } from '@ridrs/contracts';

/** Where the app serves the library; `index.json` lists it. */
export const LIBRARY_URL = '/videos/';

export interface LibraryIndex {
  readonly routes: readonly { readonly folder: string; readonly control: string }[];
}

/** A route of the library, as its control file describes it. */
export interface VideoRoute {
  /** The folder: the route's id in a ride's world. */
  readonly id: string;
  readonly title: string;
  /** The first of its notes: length, ascent and difficulty, by the route's authors. */
  readonly summary?: string;
  readonly videoUrl: string;
  readonly gpxUrl: string;
  /** Video frames per second; with `startFrame`, where the track's time 0 lies in the video. */
  readonly framerate: number;
  /** The video frame of the track's first point, from 1. */
  readonly startFrame: number;
}

/** A point of the GPX track: degrees, m above sea level and s since the track's first point. */
export interface TrackPoint {
  readonly latitude: number;
  readonly longitude: number;
  readonly elevation: number;
  readonly time: number;
}

/** The entities XML knows itself; the control files also use HTML's, such as `&auml;`. */
const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

/** An HTML entity as its character, as the HTML parser reads it; unknown ones stay as they are. */
function decodeEntity(entity: string): string {
  const decoded = new DOMParser().parseFromString(`<p>${entity}</p>`, 'text/html').body.textContent;
  return decoded && decoded !== entity ? decoded : entity;
}

/** An XML document that may use HTML's entities, as the control files do. */
export function xml(text: string): Document {
  const plain = text.replace(/&([A-Za-z][A-Za-z0-9]*);/g, (entity, name: string) =>
    XML_ENTITIES.has(name) ? entity : decodeEntity(entity).replace('&', '&amp;'),
  );
  const document = new DOMParser().parseFromString(plain, 'application/xml');
  if (document.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Not well-formed XML');
  }
  return document;
}

const textOf = (parent: Document | Element, tag: string) =>
  parent.getElementsByTagName(tag)[0]?.textContent?.trim() ?? undefined;

/** The route of a control file in `folder`, its files resolved against the library's URL. */
export function parseControlFile(text: string, folder: string, base = LIBRARY_URL): VideoRoute {
  const control = xml(text);
  const video = textOf(control, 'video-file-path');
  const gpx = textOf(control, 'gpx-file-path');
  if (!video || !gpx) {
    throw new Error(`The control file of "${folder}" names no video or no GPX file`);
  }
  const at = (file: string) => `${base}${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
  const summary = control.getElementsByTagName('information')[0]?.getAttribute('en') ?? undefined;
  return {
    id: folder,
    title: textOf(control, 'title') ?? textOf(control, 'name') ?? folder,
    summary: summary?.replaceAll('\\n', ' · '),
    videoUrl: at(video),
    gpxUrl: at(gpx),
    framerate: Number(textOf(control, 'framerate') ?? 30) || 30,
    startFrame: Number(textOf(control, 'start-frame') ?? 1) || 1,
  };
}

/**
 * The points of a GPX track in order, each with its time since the first point: the time of the
 * video at that point. Points without a position, an elevation or a time are left out.
 */
export function parseGpx(text: string): TrackPoint[] {
  const points: TrackPoint[] = [];
  let start: number | undefined;
  for (const point of xml(text).getElementsByTagName('trkpt')) {
    const latitude = Number(point.getAttribute('lat'));
    const longitude = Number(point.getAttribute('lon'));
    const elevation = Number(textOf(point, 'ele'));
    const at = Date.parse(textOf(point, 'time') ?? '');
    if (![latitude, longitude, elevation, at].every(Number.isFinite)) {
      continue;
    }
    start ??= at;
    points.push({ latitude, longitude, elevation, time: (at - start) / 1000 });
  }
  return points;
}

/**
 * A downloaded route in the unified format (`route.json`, docs/ideas/video-sources.md), from the
 * URLs of its files that its offer names. Never built from each other: the native app's asset
 * URLs hold the whole path as one encoded segment, so nothing lies "next to" another URL.
 */
export async function loadDownloadedRoute(id: string, files: Readonly<Record<string, string>>): Promise<VideoRoute> {
  const url = (name: string) => {
    const found = files[name];
    if (!found) {
      throw new Error(`The downloaded route "${id}" has no file "${name}"`);
    }
    return found;
  };
  const route = videoRouteSchema.parse(await (await fetch(url(VIDEO_ROUTE_FILE))).json());
  return {
    id,
    title: route.title,
    videoUrl: url(route.video.file),
    gpxUrl: url(route.track.file),
    framerate: route.video.framerate,
    startFrame: route.video.startFrame,
  };
}

/** Fetches the library's index and every control file in it; a broken route is left out. */
export async function loadLibrary(base = LIBRARY_URL): Promise<VideoRoute[]> {
  const index = (await (await fetch(`${base}index.json`)).json()) as LibraryIndex;
  const routes = await Promise.all(
    index.routes.map(async ({ folder, control }) => {
      try {
        const response = await fetch(`${base}${encodeURIComponent(folder)}/${encodeURIComponent(control)}`);
        return parseControlFile(await response.text(), folder, base);
      } catch {
        return undefined;
      }
    }),
  );
  return routes.filter((route): route is VideoRoute => route !== undefined);
}
