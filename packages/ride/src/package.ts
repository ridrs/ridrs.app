// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PeekedEntry, VideoPackageInspection } from '@ridrs/contracts';
import { type Control, decodeText, parseControl } from './control.ts';

const nameOf = (path: string) => path.split('/').at(-1) ?? path;
const folderOf = (path: string) => path.slice(0, path.length - nameOf(path).length);

/**
 * The route's picture among the `paths` of a package or a route's folder: the one the control file
 * names (`<preview>`), else the first of the names Incyclist looks for next to the video
 * (`preview.png`, `preview.jpg`, `<video>_preview.png`, `<video>_preview.jpg`), whatever their
 * case. `video` is the video's path among `paths` where it lies in a folder.
 */
export function pictureOf(
  control: Control,
  paths: readonly string[],
  video = control.video,
): string | undefined {
  const named = (wanted: string) =>
    paths.find((path) => path.toLowerCase() === wanted.toLowerCase());
  const folder = folderOf(video);
  if (control.preview) {
    const preview = named(`${folder}${control.preview}`);
    if (preview) return preview;
  }
  const stem = nameOf(video).replace(/\.[^.]*$/, '');
  return ['preview.png', 'preview.jpg', `${stem}_preview.png`, `${stem}_preview.jpg`]
    .map((name) => named(`${folder}${name}`))
    .find((path) => path !== undefined);
}

/**
 * Whether the entries of a ZIP make a ride package, without unpacking it (ADR 0093): a control file
 * that names a video and a track the ZIP holds. Other entries are fine; video2gpx adds its own. The
 * reasons are the ones the import gives.
 */
export function inspectPackage(entries: readonly PeekedEntry[]): VideoPackageInspection {
  const controls = entries.filter(
    (entry) => entry.name.toLowerCase().endsWith('.xml') && entry.bytes,
  );
  if (controls.length === 0) return { ok: false, reason: 'The package has no control file' };
  let reason = 'The control file names no video or no GPX track';
  for (const entry of controls) {
    let control: Control;
    try {
      control = parseControl(decodeText(entry.bytes ?? new Uint8Array()));
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      continue;
    }
    const named = (name: string) => entries.find((candidate) => nameOf(candidate.name) === name);
    const missing = [control.video, control.gpx].find((name) => !named(name));
    if (missing) return { ok: false, reason: `The package has no file "${missing}"` };
    const video = named(control.video)?.name ?? control.video;
    const thumbnail = pictureOf(
      control,
      entries.map((candidate) => candidate.name),
      video,
    );
    return {
      ok: true,
      track: named(control.gpx)?.name ?? control.gpx,
      ...(control.title || control.name ? { title: control.title ?? control.name } : {}),
      ...(thumbnail ? { thumbnail } : {}),
    };
  }
  return { ok: false, reason };
}
