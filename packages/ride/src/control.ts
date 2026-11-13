// SPDX-License-Identifier: AGPL-3.0-or-later

import type { VideoRoute } from '@ridrs/contracts';
import { decodeHTML } from 'entities';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';

/** Text by its byte order mark: some control files are UTF-16; without a mark UTF-8. */
export function decodeText(bytes: Uint8Array): string {
  const encoding =
    bytes[0] === 0xfe && bytes[1] === 0xff
      ? 'utf-16be'
      : bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}

/** A note along the route: m from the start, its text by language (`en`, `de`, …). */
export interface ControlNote {
  readonly distance: number;
  readonly text: Readonly<Record<string, string>>;
}

/** A named part of the route, m from the start. */
export interface ControlSegment {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/** What ridrs reads of a `gpx-import` control file (ADR 0094), as Incyclist reads it. */
export interface Control {
  /** The video, relative to the control file. */
  readonly video: string;
  /** The GPX track, relative to the control file; its times are the video's. */
  readonly gpx: string;
  /** `<name>` without the country Incyclist takes from its start (`FR_`), `_` as spaces. */
  readonly name?: string;
  /** `<title>`, or its first language where it has one per language, as Incyclist shows it. */
  readonly title?: string;
  /** `<preview>`: the route's picture, relative to the control file. */
  readonly preview?: string;
  readonly framerate: number;
  /** The video frame of the track's first point, from 1. */
  readonly startFrame: number;
  readonly notes: readonly ControlNote[];
  readonly segments: readonly ControlSegment[];
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

const textOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A title as a string, or one element per language: Incyclist shows the first language. */
function titleOf(value: unknown): string {
  if (value && typeof value === 'object') {
    return textOf(Object.values(value as Record<string, unknown>)[0]);
  }
  return textOf(value);
}

/** `FR_Col_de_Pennes` is `Col de Pennes`: Incyclist reads the first two letters as the country. */
function nameOf(value: unknown): string {
  return textOf(value)
    .replace(/^[A-Za-z]{2}[-_]/, '')
    .replace(/_+/g, ' ')
    .trim();
}

/** The control file's video, track, names, picture, timing, notes along the route and segments. */
export function parseControl(text: string): Control {
  const root = (
    parser.parse(withoutHtmlEntities(text)) as { 'gpx-import'?: Record<string, unknown> }
  )['gpx-import'];
  const video = textOf(root?.['video-file-path']);
  const gpx = textOf(root?.['gpx-file-path']);
  if (!video || !gpx) {
    throw new Error('The control file names no video or no GPX track');
  }
  const notes = list(
    (root?.informations as { information?: unknown } | undefined)?.information,
  ).map(({ distance, ...text }) => ({
    distance: Number(distance),
    text: Object.fromEntries(
      Object.entries(text).map(([language, value]) => [language, value.replaceAll('\\n', '\n')]),
    ),
  }));
  const segments = list((root?.segments as { segment?: unknown } | undefined)?.segment).map(
    (segment) => ({
      name: segment.name ?? '',
      start: Number(segment.start),
      end: Number(segment.end),
    }),
  );
  const name = nameOf(root?.name);
  const title = titleOf(root?.title);
  const preview = textOf(root?.preview);
  return {
    video,
    gpx,
    ...(name ? { name } : {}),
    ...(title ? { title } : {}),
    ...(preview ? { preview } : {}),
    framerate: Number(root?.framerate) || 30,
    startFrame: Number(root?.['start-frame']) || 1,
    notes: notes.filter((note) => Number.isFinite(note.distance) && note.distance >= 0),
    segments: segments.filter((s) => s.name && Number.isFinite(s.start) && Number.isFinite(s.end)),
  };
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
});

/**
 * A `gpx-import` control file of `control`, in UTF-8: what Incyclist and ridrs read. Line breaks
 * in notes are written as `\n`, as the control files of the sources write them.
 */
export function writeControl(control: Control): string {
  const root = {
    ...(control.name ? { name: control.name } : {}),
    ...(control.title ? { title: control.title } : {}),
    'video-file-path': control.video,
    'gpx-file-path': control.gpx,
    framerate: String(control.framerate),
    'start-frame': String(control.startFrame),
    ...(control.preview ? { preview: control.preview } : {}),
    informations: {
      information: control.notes.map((note) => ({
        '@distance': String(note.distance),
        ...Object.fromEntries(
          Object.entries(note.text).map(([language, text]) => [
            `@${language}`,
            text.replaceAll('\n', '\\n'),
          ]),
        ),
      })),
    },
    segments: {
      segment: control.segments.map((segment) => ({
        '@name': segment.name,
        '@start': String(segment.start),
        '@end': String(segment.end),
      })),
    },
  };
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n${builder.build({ 'gpx-import': root })}`;
}

/**
 * The control file of a route stored in the unified format (`route.json`, before ADR 0094): its
 * files keep their names, the picture is `<preview>`. Its source stays with the catalog.
 */
export function controlFromRoute(route: VideoRoute): Control {
  return {
    video: route.video.file,
    gpx: route.track.file,
    title: route.title,
    ...(route.thumbnail ? { preview: route.thumbnail.file } : {}),
    framerate: route.video.framerate,
    startFrame: route.video.startFrame,
    notes: route.notes,
    segments: route.segments,
  };
}
