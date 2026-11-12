// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DataArchive,
  type MediaFiles,
  type PeekedEntry,
  VIDEO_ROUTE_FILE,
  type VideoImporter,
  type VideoPackageInspection,
  type VideoRoute,
  videoRouteSchema,
} from '@ridrs/contracts';
import { decodeHTML } from 'entities';
import { XMLParser } from 'fast-xml-parser';

/** Incyclist's video package: a control file (`gpx-import`), the video and its GPX track. */
export const INCYCLIST_FORMAT = 'incyclist-gpx-import';

/** Counts up when the import makes different routes from the same package. */
export const IMPORT_VERSION = '1';

/** Text by its byte order mark: some control files are UTF-16; without a mark UTF-8. */
export function decodeText(bytes: Uint8Array): string {
  const encoding =
    bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}

/** What the import takes from a control file. */
export interface Control {
  readonly video: string;
  readonly gpx: string;
  readonly framerate: number;
  readonly startFrame: number;
  readonly notes: VideoRoute['notes'];
  readonly segments: VideoRoute['segments'];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'information' || name === 'segment',
});

const list = (value: unknown): Record<string, string>[] =>
  Array.isArray(value) ? (value as Record<string, string>[]) : [];

/** The entities XML knows itself; the control files also use HTML's, such as `&auml;`. */
const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

/** HTML's named entities as their characters, kept XML where a character would break it. */
const withoutHtmlEntities = (text: string) =>
  text.replace(/&([A-Za-z][A-Za-z0-9]*);/g, (entity, name: string) =>
    XML_ENTITIES.has(name) ? entity : decodeHTML(entity).replace('&', '&amp;'),
  );

/** The control file's video, track, timing, notes along the route and segments. */
export function parseControl(text: string): Control {
  const root = (parser.parse(withoutHtmlEntities(text)) as { 'gpx-import'?: Record<string, unknown> })['gpx-import'];
  const video = String(root?.['video-file-path'] ?? '').trim();
  const gpx = String(root?.['gpx-file-path'] ?? '').trim();
  if (!video || !gpx) {
    throw new Error('The control file names no video or no GPX track');
  }
  const notes = list((root?.informations as { information?: unknown } | undefined)?.information).map(
    ({ distance, ...text }) => ({
      distance: Number(distance),
      text: Object.fromEntries(Object.entries(text).map(([language, value]) => [language, value.replaceAll('\\n', '\n')])),
    }),
  );
  const segments = list((root?.segments as { segment?: unknown } | undefined)?.segment).map((segment) => ({
    name: segment.name ?? '',
    start: Number(segment.start),
    end: Number(segment.end),
  }));
  return {
    video,
    gpx,
    framerate: Number(root?.framerate) || 30,
    startFrame: Number(root?.['start-frame']) || 1,
    notes: notes.filter((note) => Number.isFinite(note.distance) && note.distance >= 0),
    segments: segments.filter((s) => s.name && Number.isFinite(s.start) && Number.isFinite(s.end)),
  };
}

const nameOf = (path: string) => path.split('/').at(-1) ?? path;

/**
 * Whether the entries of a ZIP make an Incyclist package, without unpacking it (ADR 0093): a
 * control file that names a video and a track the ZIP holds. Other entries are fine; video2gpx
 * adds its own. The reasons are the ones the import gives.
 */
export function inspectIncyclist(entries: readonly PeekedEntry[]): VideoPackageInspection {
  const controls = entries.filter((entry) => entry.name.toLowerCase().endsWith('.xml') && entry.bytes);
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
    return { ok: true, track: named(control.gpx)?.name ?? control.gpx };
  }
  return { ok: false, reason };
}

/**
 * Turns an Incyclist ZIP into a ridrs video route: unpacked into the folder, the video and the
 * track renamed (`video.mp4`, `track.gpx`), everything else removed, `route.json` written.
 */
export function createIncyclistImporter(media: MediaFiles, archive: DataArchive): VideoImporter {
  return {
    format: INCYCLIST_FORMAT,
    inspect: inspectIncyclist,
    async import(pack, directory, facts) {
      const files = await archive.extract(pack, `${directory}/package`);
      const controlFile = files.find((file) => file.toLowerCase().endsWith('.xml'));
      if (!controlFile) {
        throw new Error('The package has no control file');
      }
      const control = parseControl(decodeText(await media.read(controlFile)));
      const fileNamed = (name: string) => {
        const file = files.find((candidate) => nameOf(candidate) === name);
        if (!file) {
          throw new Error(`The package has no file "${name}"`);
        }
        return file;
      };
      await media.move(fileNamed(control.video), `${directory}/video.mp4`);
      await media.move(fileNamed(control.gpx), `${directory}/track.gpx`);
      await media.remove(`${directory}/package`);
      const route = videoRouteSchema.parse({
        format: 'ridrs-video-route',
        version: 1,
        title: facts.title,
        ...(facts.source ? { source: facts.source } : {}),
        notes: control.notes,
        segments: control.segments,
        video: { file: 'video.mp4', framerate: control.framerate, startFrame: control.startFrame },
        track: { file: 'track.gpx' },
        imported: { by: 'video-import-incyclist', version: IMPORT_VERSION },
      } satisfies VideoRoute);
      await media.write(`${directory}/${VIDEO_ROUTE_FILE}`, new TextEncoder().encode(`${JSON.stringify(route, null, 2)}\n`));
      return route;
    },
  };
}
