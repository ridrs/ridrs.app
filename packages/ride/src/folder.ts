// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DataPicture,
  type MediaEntry,
  type MediaFiles,
  VIDEO_ROUTE_FILE,
  videoRouteSchema,
} from '@ridrs/contracts';
import {
  type Control,
  controlFromRoute,
  decodeText,
  parseControl,
  writeControl,
} from './control.ts';
import { pictureOf } from './package.ts';

/** The control file the migration writes into a route's folder. */
export const CONTROL_FILE = 'route.xml';

/** A route's package in its folder, kept as it came where its video is stored (ADR 0094). */
export const RIDE_PACKAGE = 'route.ride';

/** A route's control file: its path among the route's entries and what it says. */
export interface RouteControl {
  readonly path: string;
  readonly control: Control;
}

/** The entry of `path` among `paths`, letters compared without case, as the folder's entries are. */
export const entryNamed = (paths: readonly string[], path: string): string | undefined =>
  paths.find((candidate) => candidate.toLowerCase() === path.toLowerCase());

/** The entry `relative` names, relative to the control file at `control`. */
export const besideControl = (control: string, relative: string): string =>
  `${control.slice(0, control.lastIndexOf('/') + 1)}${relative}`;

/**
 * The control file of a route (ADR 0094): the first `*.xml` among its entries that is a
 * `gpx-import` control file naming a video and a track the route holds; none when no entry is.
 */
export async function findControl(
  paths: readonly string[],
  read: (path: string) => Promise<Uint8Array>,
): Promise<RouteControl | undefined> {
  for (const path of paths.filter((candidate) => candidate.toLowerCase().endsWith('.xml'))) {
    let control: Control;
    try {
      control = parseControl(decodeText(await read(path)));
    } catch {
      continue;
    }
    const holds = (relative: string) =>
      entryNamed(paths, besideControl(path, relative)) !== undefined;
    if (holds(control.video) && holds(control.gpx)) return { path, control };
  }
  return undefined;
}

/** The URLs of a route's entries by their paths, as its offer names them for the video world. */
export function entryUrls(
  media: MediaFiles,
  folder: string,
  entries: readonly MediaEntry[],
): Record<string, string> {
  return Object.fromEntries(
    entries.map((entry) => [entry.path, media.url(`${folder}/${entry.path}`)]),
  );
}

/**
 * Moves a route stored in the unified format (`route.json`, before ADR 0094) to a control file in
 * place: writes `route.xml` from `route.json` and removes it. Video, track and picture stay as
 * they are. Resolves to whether it moved the route; a `route.json` that does not parse stays.
 */
export async function moveToControlFile(media: MediaFiles, folder: string): Promise<boolean> {
  const file = `${folder}/${VIDEO_ROUTE_FILE}`;
  if (!(await media.exists(file))) return false;
  let json: unknown;
  try {
    json = JSON.parse(decodeText(await media.read(file)));
  } catch {
    return false;
  }
  const stored = videoRouteSchema.safeParse(json);
  if (!stored.success) return false;
  await media.write(
    `${folder}/${CONTROL_FILE}`,
    new TextEncoder().encode(writeControl(controlFromRoute(stored.data))),
  );
  await media.remove(file);
  return true;
}

/**
 * A route's small picture for its card (ADR 0094), made from its picture: hidden, so it is no
 * entry and Incyclist never sees it.
 */
export const TILE_FILE = '.tile.jpg';

/** The width of a card's picture, twice that of the widest card, for sharp pictures on Retina. */
export const TILE_WIDTH = 800;

/** The picture of the route in `folder` among its entries; none where it has no control file or no picture. */
export async function routePicture(media: MediaFiles, folder: string): Promise<string | undefined> {
  const paths = (await media.entries(folder)).map((entry) => entry.path);
  const found = await findControl(paths, (path) => media.read(`${folder}/${path}`));
  if (!found) return undefined;
  const video =
    entryNamed(paths, besideControl(found.path, found.control.video)) ?? found.control.video;
  return pictureOf(found.control, paths, video);
}

/**
 * Makes the small picture of the route in `folder` from its picture `entry`, where `picture` can
 * draw one: once, or `again` after its picture changed. Resolves to whether the route has one.
 */
export async function makeTile(
  media: MediaFiles,
  picture: DataPicture | undefined,
  folder: string,
  entry: string,
  again = false,
): Promise<boolean> {
  const tile = `${folder}/${TILE_FILE}`;
  if (!again && (await media.exists(tile))) return true;
  if (!picture) return false;
  await media.write(tile, await picture.shrink(await media.read(`${folder}/${entry}`), TILE_WIDTH));
  return true;
}
