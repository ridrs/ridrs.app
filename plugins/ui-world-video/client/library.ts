// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Video routes on the device: a folder with an Incyclist control file (`gpx-import`), the video
 * and the GPX track it names (ADR 0094).
 */

import type { TrackPoint } from '@ridrs/ride';
import { besideControl, entryNamed, findControl, parseRefinement, REFINE_FILE, REFINE_FOLDER } from '@ridrs/ride';

export type { TrackPoint } from '@ridrs/ride';

/** A video route. */
export interface VideoRoute {
  /** The folder: the route's id in a ride's world. */
  readonly id: string;
  readonly title: string;
  readonly videoUrl: string;
  readonly gpxUrl: string;
  /** Video frames per second; with `startFrame`, where the track's time 0 lies in the video. */
  readonly framerate: number;
  /** The video frame of the track's first point, from 1. */
  readonly startFrame: number;
  /** The stretches of the video refined with in-between frames (ADR 0109), in the order of their time. */
  readonly refined: readonly RefinedPart[];
  /** Why the route's refinement was left out, where it has one that was. */
  readonly refinementProblem?: string;
}

/** A refined stretch of a route's video: from `from` s to `to` s of the video, its file's URL. */
export interface RefinedPart {
  readonly from: number;
  readonly to: number;
  readonly factor: number;
  readonly url: string;
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
 * A route on the device from the URLs of its files that its offer names (ADR 0094): its control
 * file among them, and the video and the track that file names. Never built from each other: the
 * native app's asset URLs hold the whole path as one encoded segment, so nothing lies "next to"
 * another URL.
 */
export async function loadDownloadedRoute(id: string, files: Readonly<Record<string, string>>): Promise<VideoRoute> {
  const paths = Object.keys(files);
  const read = async (path: string) => new Uint8Array(await (await fetch(files[path] ?? '')).arrayBuffer());
  const found = await findControl(paths, read);
  if (!found) {
    throw new Error(`The downloaded route "${id}" has no control file that names its video and track`);
  }
  const { control } = found;
  const url = (relative: string) => files[entryNamed(paths, besideControl(found.path, relative)) ?? ''] ?? '';
  const refinement = entryNamed(paths, REFINE_FILE);
  const { refined, problem } =
    refinement === undefined
      ? { refined: [], problem: undefined }
      : refinedParts(new TextDecoder().decode(await read(refinement)), control.video, files);
  return {
    id,
    title: control.title ?? control.name ?? id,
    videoUrl: url(control.video),
    gpxUrl: url(control.gpx),
    framerate: control.framerate,
    startFrame: control.startFrame,
    refined,
    ...(problem ? { refinementProblem: problem } : {}),
  };
}

/**
 * The refined stretches of a route from its `refine/refine.json` (ADR 0109): none, with the reason,
 * where it does not parse, names another video than `video` (the control file's) or a file the
 * route's `files` lack. A refinement is all or nothing: one that is wrong in part is left out whole.
 */
export function refinedParts(
  text: string,
  video: string,
  files: Readonly<Record<string, string>>,
): { readonly refined: readonly RefinedPart[]; readonly problem?: string } {
  const paths = Object.keys(files);
  try {
    const refinement = parseRefinement(text);
    const same = (path: string) => path.replace(/^\.\//, '').toLowerCase();
    if (same(refinement.video) !== same(video)) {
      return { refined: [], problem: `${REFINE_FILE} names the video "${refinement.video}", not "${video}"` };
    }
    const refined: RefinedPart[] = [];
    for (const segment of refinement.segments) {
      const path = `${REFINE_FOLDER}/${segment.file}`;
      const entry = entryNamed(paths, path);
      if (entry === undefined) {
        return { refined: [], problem: `${path} is not in the route` };
      }
      refined.push({ from: segment.from, to: segment.to, factor: segment.factor, url: files[entry] ?? '' });
    }
    return { refined };
  } catch (error) {
    return { refined: [], problem: error instanceof Error ? error.message : String(error) };
  }
}
