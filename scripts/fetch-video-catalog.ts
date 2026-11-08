// SPDX-License-Identifier: AGPL-3.0-or-later

// Builds the catalog of the video rides of cycling.vangestel.online, shipped with the video
// source plugin: what the site lists for each video, the route from its Incyclist control file
// and GPX track with its categorised climbs, a thumbnail and a picture of the elevation profile.
// No video is downloaded: each ZIP's central directory and its small entries are read with HTTP
// range requests, about 40 kB per route.
//
//   pnpm fetch:video-catalog [--out <folder>] [--only <route id> …]
//
// The folder defaults to `plugins/video-source-vangestel/catalog`. It gets `index.json` (every
// route, light enough for a list) and per route `<id>/route.json` (profile, path, notes,
// segments, climbs with their summit names), `<id>/peaks.txt` (the names of the summits along the
// route), `<id>/thumbnail.jpg` and `<id>/profile.svg` (ADR 0070). Running it again rewrites the
// files; unchanged sources give the same files. A thumbnail or peaks file that is already there
// stays: the routes get thumbnails and summit names of their own, the site's picture is only a start.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configure, type Entry, HttpRangeReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { Window } from 'happy-dom';
import { categoriseClimbs, nameClimbs } from '../plugins/video-source-vangestel/climbs.ts';
import { drawProfile } from '../plugins/video-source-vangestel/profile-picture.ts';
import { parseControlFile, parseGpx, xml } from '../plugins/ui-world-video/client/library.ts';
import { plausibleTrack } from '../plugins/ui-world-video/client/plausible-track.ts';
import { placeAt, type Track } from '../plugins/ui-world-video/client/track.ts';

const SITE = 'https://cycling.vangestel.online';
const LIST = `${SITE}/indoor/videos/`;

/** Who made the videos and under which terms; every route carries it. */
const SOURCE = {
  id: 'vangestel',
  name: 'Van Gestel – Cycling pages',
  url: LIST,
  author: 'Fred Van Gestel',
  license: { id: 'CC-BY-NC-SA-4.0', name: 'CC BY-NC-SA 4.0', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' },
} as const;

/** m between two samples of a route's profile and path in `route.json`. */
const SPACING = 100;
/**
 * Samples of the profile in `index.json`, evenly spaced from start to end: enough for the route
 * details' large profile with its gradients (about 70 m apart on a 46 km route), and for the
 * sparkline of a card.
 */
const SPARKLINE = 640;
/** ms between two requests to the site, to stay a polite visitor. */
const PAUSE = 250;
const HEADERS = { 'User-Agent': 'ridrs-video-catalog (+https://ridrs.app)' };

const window = new Window();
globalThis.DOMParser = window.DOMParser as unknown as typeof DOMParser;
configure({ useWebWorkers: false });

const pause = () => new Promise((done) => setTimeout(done, PAUSE));

async function get(url: string): Promise<Response> {
  await pause();
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response;
}

const page = async (url: string) =>
  new DOMParser().parseFromString(await (await get(url)).text(), 'text/html') as unknown as Document;

const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const absolute = (href: string, base: string) => new URL(href, base).href;
const round = (value: number, digits: number) => Number(value.toFixed(digits));

/** A row of the site's list of videos, as it shows it. */
interface Listed {
  readonly id: string;
  readonly page: string;
  readonly title: string;
  readonly stated: { readonly distance: number; readonly ascent: number; readonly duration: number; readonly size: number };
  readonly level: string;
  readonly trackType: string;
  readonly bikeType: string;
  readonly country: string;
  /** As the list shows it, e.g. `Dec 23`. */
  readonly added: string;
  readonly codec: string;
}

/** `1.177 m` or `46.2 km` in m; the site writes thousands with a dot. */
function metres(cell: string): number {
  const [number = '', unit] = cell.split(' ');
  return unit === 'km' ? Number(number) * 1000 : Number(number.replaceAll('.', ''));
}

/** `01:26 hr` in s. */
function seconds(cell: string): number {
  const [hours = 0, minutes = 0] = cell.split(' ')[0]?.split(':').map(Number) ?? [];
  return hours * 3600 + minutes * 60;
}

/** The videos and the tour names, from the list page's two tables. */
async function readList(): Promise<{ videos: Listed[]; tours: string[] }> {
  const document = await page(LIST);
  const [videoTable, tourTable] = [...document.querySelectorAll('#content table')];
  const rows = (table: Element | undefined) => [...(table?.querySelectorAll('tbody tr') ?? [])];
  const videos = rows(videoTable).map((row): Listed => {
    const cells = [...row.querySelectorAll('td')].map(text);
    const link = row.querySelector('a');
    const href = absolute(link?.getAttribute('href') ?? '', LIST);
    const [title = '', , distance = '', ascent = '', level = '', trackType = '', bikeType = '', country = '', added = '', duration = '', size = '', codec = ''] =
      cells;
    return {
      id: new URL(href).pathname.split('/').filter(Boolean).at(-1) ?? href,
      page: href,
      title,
      stated: {
        distance: metres(distance),
        ascent: metres(ascent),
        duration: seconds(duration),
        size: Math.round(Number(size.split(' ')[0]) * 1e9),
      },
      level,
      trackType,
      bikeType,
      country,
      added,
      codec,
    };
  });
  return { videos, tours: rows(tourTable).map((row) => text(row.querySelector('a'))) };
}

/** What a video's own page adds: the download, a thumbnail, the trailer and the description. */
async function readDetails(url: string) {
  const document = await page(url);
  const content = document.querySelector('#content');
  const download = content?.querySelector('a[href$=".zip"]')?.getAttribute('href');
  if (!download) {
    throw new Error(`${url}: no download`);
  }
  const thumbnail = content?.querySelector('img[src$="_tn.jpg"]')?.getAttribute('src');
  const trailer = content?.querySelector('video source')?.getAttribute('src');
  // The text of the paragraph with the download, up to its link; above it an optional highlight.
  const words = [];
  for (const node of content?.querySelector('a[href$=".zip"]')?.parentElement?.childNodes ?? []) {
    if (node.nodeName === 'A') {
      break;
    }
    words.push(node.textContent ?? '');
  }
  const highlight = text(content?.querySelector('.summary_box'));
  return {
    title: text(content?.querySelector('h1')),
    highlight: highlight || undefined,
    description: words.join(' ').replace(/\s+/g, ' ').trim(),
    download: absolute(download, url),
    thumbnail: thumbnail ? absolute(thumbnail, url) : undefined,
    trailer: trailer ? absolute(trailer, url) : undefined,
  };
}

/** Text by its byte order mark: some control files are UTF-16; without a mark UTF-8. */
function decode(bytes: Uint8Array): string {
  const encoding = bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}

/** The ZIP's entries and its small files, read by range; the video itself is never fetched. */
async function readArchive(url: string) {
  await pause();
  const head = await fetch(url, { method: 'HEAD', headers: HEADERS });
  const reader = new ZipReader(new HttpRangeReader(url, { headers: Object.entries(HEADERS), forceRangeRequests: true }));
  try {
    const entries = (await reader.getEntries()).filter((entry): entry is Entry & { directory: false } => !entry.directory);
    const read = async (extension: string) => {
      const entry = entries.find((e) => e.filename.toLowerCase().endsWith(extension));
      if (!entry) {
        throw new Error(`${url}: no ${extension} file`);
      }
      return { name: entry.filename, text: decode(await entry.getData(new Uint8ArrayWriter())) };
    };
    return {
      size: Number(head.headers.get('content-length') ?? 0),
      etag: head.headers.get('etag') ?? undefined,
      lastModified: head.headers.get('last-modified') ?? undefined,
      files: entries.map((entry) => ({ name: entry.filename, size: entry.uncompressedSize })),
      control: await read('.xml'),
      gpx: await read('.gpx'),
    };
  } finally {
    await reader.close();
  }
}

/** The control file's notes along the route and its segments, which `parseControlFile` leaves out. */
function routeExtras(control: string) {
  const document = xml(control);
  const numberOf = (element: Element, name: string) => Number(element.getAttribute(name));
  const notes = [...document.getElementsByTagName('information')].map((note) => ({
    distance: numberOf(note, 'distance'),
    text: Object.fromEntries(
      [...note.attributes]
        .filter((attribute) => attribute.name !== 'distance')
        .map((attribute) => [attribute.name, attribute.value.replaceAll('\\n', '\n')]),
    ),
  }));
  const segments = [...document.getElementsByTagName('segment')].map((segment) => ({
    name: segment.getAttribute('name') ?? '',
    start: numberOf(segment, 'start'),
    end: numberOf(segment, 'end'),
  }));
  const endFrame = Number(document.getElementsByTagName('end-frame')[0]?.textContent);
  const tag = (name: string) => document.getElementsByTagName(name)[0]?.textContent?.trim() || undefined;
  return {
    /** Incyclist's id of the video, and of the video that follows it in a tour. */
    incyclistId: tag('id'),
    nextVideo: tag('next-video'),
    videoFile: tag('video-file-path'),
    notes,
    segments,
    endFrame: Number.isFinite(endFrame) && endFrame > 0 ? endFrame : undefined,
  };
}

/** Samples of the route every `spacing` m, the last one at its end. */
function along(track: Track, spacing: number) {
  const places = [];
  for (let distance = 0; distance < track.length; distance += spacing) {
    places.push(placeAt(track, distance));
  }
  places.push(placeAt(track, track.length));
  return places;
}

/** What the GPX track says about the route, after making it plausible (ADR 0063). */
function describeTrack(gpx: string) {
  const { track } = plausibleTrack(parseGpx(gpx));
  const samples = along(track, SPACING);
  const elevations = samples.map((place) => place.elevation);
  // The ascent of the profile every SPACING m: GPS elevation jitter between fixes does not count.
  const ascent = elevations.slice(1).reduce((sum, elevation, i) => sum + Math.max(0, elevation - (elevations[i] ?? 0)), 0);
  // To 0.1 m: whole metres would put up to 1.4 % of rounding into the gradient of each stretch.
  const sparkline = along(track, track.length / (SPARKLINE - 1)).map((place) => round(place.elevation, 1));
  const profile = { spacing: SPACING, elevations: elevations.map((elevation) => round(elevation, 1)) };
  const latitudes = samples.map((place) => place.latitude);
  const longitudes = samples.map((place) => place.longitude);
  return {
    distance: round(track.length, 0),
    ascent: round(ascent, 0),
    duration: round(track.points.at(-1)?.time ?? 0, 0),
    elevation: { min: round(Math.min(...elevations), 0), max: round(Math.max(...elevations), 0) },
    start: { latitude: round(latitudes[0] ?? 0, 5), longitude: round(longitudes[0] ?? 0, 5) },
    bounds: {
      south: round(Math.min(...latitudes), 5),
      west: round(Math.min(...longitudes), 5),
      north: round(Math.max(...latitudes), 5),
      east: round(Math.max(...longitudes), 5),
    },
    sparkline,
    profile,
    climbs: categoriseClimbs(profile),
    path: { spacing: SPACING, points: samples.map((place) => [round(place.latitude, 5), round(place.longitude, 5)]) },
  };
}

/** The tour a video belongs to and its part, from titles such as `Rousset - 4 - Col de Rousset, Die`. */
function tourOf(title: string, tours: readonly string[]) {
  const name = tours.find((tour) => title.startsWith(`${tour} - `));
  const part = name ? Number(title.slice(name.length + 3).split(' - ')[0]) : Number.NaN;
  return name && Number.isInteger(part) ? { name, part } : undefined;
}

async function build(listed: Listed, tours: readonly string[], out: string) {
  const details = await readDetails(listed.page);
  const archive = await readArchive(details.download);
  const control = parseControlFile(archive.control.text, listed.id, '');
  const extras = routeExtras(archive.control.text);
  const track = describeTrack(archive.gpx.text);
  const folder = join(out, listed.id);
  mkdirSync(folder, { recursive: true });
  // A thumbnail or peaks file already in the folder is ours (made for the route) and stays; only a
  // route without one gets the site's picture or the names from the control file's notes.
  const peaksFile = join(folder, 'peaks.txt');
  const peaks = existsSync(peaksFile)
    ? readFileSync(peaksFile, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  const climbs = nameClimbs(track.climbs, extras.notes, peaks);
  if (!existsSync(peaksFile)) {
    const names = climbs.map((climb) => climb.name ?? '').filter(Boolean);
    writeFileSync(peaksFile, names.length > 0 ? `${names.join('\n')}\n` : '');
  }
  const picture = join(folder, 'thumbnail.jpg');
  if (!existsSync(picture) && details.thumbnail) {
    writeFileSync(picture, new Uint8Array(await (await get(details.thumbnail)).arrayBuffer()));
  }
  const thumbnail = existsSync(picture) ? `${listed.id}/thumbnail.jpg` : undefined;
  writeFileSync(join(folder, 'profile.svg'), drawProfile(track.profile, climbs));
  const video = archive.files.find((file) => file.name.split('/').at(-1) === extras.videoFile);
  const summary = {
    id: listed.id,
    title: listed.title,
    page: listed.page,
    tour: tourOf(listed.title, tours),
    country: listed.country,
    level: listed.level,
    trackType: listed.trackType,
    bikeType: listed.bikeType,
    added: listed.added,
    distance: track.distance,
    ascent: track.ascent,
    duration: track.duration,
    elevation: track.elevation,
    start: track.start,
    sparkline: track.sparkline,
    climbs,
    stated: listed.stated,
    thumbnail,
    trailer: details.trailer,
    download: {
      url: details.download,
      format: 'incyclist-gpx-import',
      size: archive.size,
      etag: archive.etag,
      lastModified: archive.lastModified,
      files: archive.files,
    },
    video: {
      file: video?.name,
      incyclistId: extras.incyclistId,
      next: extras.nextVideo,
      codec: listed.codec,
      framerate: control.framerate,
      startFrame: control.startFrame,
      endFrame: extras.endFrame,
    },
  };
  const route = {
    ...summary,
    heading: details.title,
    highlight: details.highlight,
    description: details.description,
    bounds: track.bounds,
    notes: extras.notes,
    segments: extras.segments,
    profile: track.profile,
    path: track.path,
    files: { control: archive.control.name, gpx: archive.gpx.name },
  };
  writeFileSync(join(folder, 'route.json'), `${JSON.stringify({ source: SOURCE, route }, null, 2)}\n`);
  return summary;
}

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = resolve(outIndex >= 0 ? (args.splice(outIndex, 2)[1] ?? '') : join(import.meta.dirname, '../plugins/video-source-vangestel/catalog'));
const only = new Set<string>();
for (let i = args.indexOf('--only'); i >= 0; i = args.indexOf('--only')) {
  only.add(args.splice(i, 2)[1] ?? '');
}

const { videos, tours } = await readList();
const routes = [];
let failed = 0;
for (const listed of videos.filter((video) => only.size === 0 || only.has(video.id))) {
  try {
    const route = await build(listed, tours, out);
    console.log(`${route.id}: ${(route.distance / 1000).toFixed(1)} km, ${route.ascent} m (site: ${(listed.stated.distance / 1000).toFixed(1)} km, ${listed.stated.ascent} m)`);
    routes.push(route);
  } catch (error) {
    failed += 1;
    console.error(`${listed.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (only.size === 0) {
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'index.json'),
    `${JSON.stringify({ format: 'ridrs-video-catalog', version: 1, source: SOURCE, routes }, null, 2)}\n`,
  );
}
console.log(`\n${routes.length} routes in ${out}, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
