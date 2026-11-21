// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Given, Then } from '@cucumber/cucumber';
import { parseControl } from '@ridrs/ride';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { gpx, incyclistPackage } from '../support/simulated-downloads.ts';
import { PICTURE_BYTES } from '../support/simulated-drop.ts';
import { withStoredVideo } from '../support/simulated-file.ts';
import { smallPicture } from '../support/simulated-picture.ts';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv } from './devices-and-metrics.steps.ts';

/** Where `storage-media-node` keeps the media. */
const MEDIA_DIR_ENV = 'RIDRS_MEDIA_DIR';

const folderOf = (key: string) =>
  join(process.env[MEDIA_DIR_ENV] ?? '', 'videos', ...key.split('/'));

/** A route as ridrs stored it before ADR 0094: `route.json`, `video.mp4`, `track.gpx`. */
function unifiedRoute(key: string, title: string, picture: boolean): void {
  const folder = folderOf(key);
  mkdirSync(folder, { recursive: true });
  const route = {
    format: 'ridrs-video-route',
    version: 1,
    title,
    notes: [{ distance: 20, text: { en: `${title}\nLength: 0.3 km` } }],
    segments: [{ name: 'The whole route', start: 0, end: 300 }],
    video: { file: 'video.mp4', framerate: 30, startFrame: 12 },
    track: { file: 'track.gpx' },
    ...(picture ? { thumbnail: { file: 'thumbnail.jpg' } } : {}),
    imported: { by: 'video-import-incyclist', version: '2' },
  };
  writeFileSync(join(folder, 'route.json'), `${JSON.stringify(route, null, 2)}\n`);
  writeFileSync(join(folder, 'video.mp4'), new Uint8Array(64));
  writeFileSync(join(folder, 'track.gpx'), gpx());
  if (picture) writeFileSync(join(folder, 'thumbnail.jpg'), new Uint8Array([0xff, 0xd8, 0xff]));
}

function offerFiles(world: RidrsWorld, key: string): string[] {
  const offer = world.ensureHost().getState('route.offer').get(key) as
    | { availability?: { files?: Record<string, string> } }
    | undefined;
  return Object.keys(offer?.availability?.files ?? {}).sort();
}

/** The files of a route's folder; hidden ones (`.tile.jpg`, `.overlay.json`) are the app's own, no entries. */
function filesBelow(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .flatMap((entry) =>
      entry.isDirectory()
        ? filesBelow(join(directory, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    );
}

Given(
  'the media storage holds the Van Gestel route {string} in the unified format',
  function (this: RidrsWorld, id: string) {
    unifiedRoute(`video-source-scenic/vg-${id}`, 'Col de Pennes', false);
  },
);

Given(
  'the media storage holds the own route {string} titled {string} with a picture in the unified format',
  function (this: RidrsWorld, id: string, title: string) {
    unifiedRoute(`video-source-local/${id}`, title, true);
    const index = {
      version: 1,
      routes: [
        { id, title, distance: 300, ascent: 12, sparkline: [433, 445], thumbnail: 'thumbnail.jpg' },
      ],
    };
    writeFileSync(
      join(folderOf('video-source-local'), 'routes.json'),
      `${JSON.stringify(index)}\n`,
    );
  },
);

Then(
  'the route folder {string} holds {string}',
  async function (this: RidrsWorld, key: string, files: string) {
    const wanted = splitCsv(files).sort();
    await this.waitForIo(
      () => JSON.stringify(filesBelow(folderOf(key)).sort()) === JSON.stringify(wanted),
      `"${key}" to hold ${files}`,
    );
  },
);

Then(
  'the route offer {string} names the files {string}',
  async function (this: RidrsWorld, key: string, files: string) {
    const wanted = splitCsv(files).sort();
    await this.waitForIo(
      () => JSON.stringify(offerFiles(this, key)) === JSON.stringify(wanted),
      `"${key}" to name ${files}, not ${offerFiles(this, key).join(', ')}`,
    );
  },
);

const controlOf = (key: string) =>
  parseControl(readFileSync(join(folderOf(key), 'route.xml'), 'utf8'));

Then(
  'the control file of {string} names the video {string} at {float} frames per second from frame {int}',
  function (this: RidrsWorld, key: string, video: string, framerate: number, startFrame: number) {
    const control = controlOf(key);
    assert.deepEqual(
      [control.video, control.gpx, control.framerate, control.startFrame],
      [video, 'track.gpx', framerate, startFrame],
    );
  },
);

Then(
  'the control file of {string} is titled {string}',
  function (this: RidrsWorld, key: string, title: string) {
    assert.equal(controlOf(key).title, title);
  },
);

Given(
  'the media storage holds the own route folder {string} unpacked from an Incyclist package',
  async function (this: RidrsWorld, id: string) {
    const folder = folderOf(`video-source-local/${id}`);
    const reader = new ZipReader(new Uint8ArrayReader(await incyclistPackage(null)));
    for (const entry of await reader.getEntries()) {
      if (entry.directory) continue;
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, entry.filename), await entry.getData(new Uint8ArrayWriter()));
    }
    await reader.close();
  },
);

Given(
  'the media storage holds the own route folder {string} with a package that keeps its video stored',
  async function (this: RidrsWorld, id: string) {
    const folder = folderOf(`video-source-local/${id}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'route.ride'), await withStoredVideo(await incyclistPackage(null)));
  },
);

Given('the media storage holds no index of own routes', function (this: RidrsWorld) {
  const index = join(folderOf('video-source-local'), 'routes.json');
  if (existsSync(index)) rmSync(index);
});

/** A picture's URL without its query: ridrs Scenic adds `?h=<hash>` to its files (docs/formats/scenic-ride-catalog-v1.md). */
const pathOf = (url: string | undefined) =>
  url === undefined ? undefined : decodeURI(new URL(url, 'file:///').pathname);

/** The Van Gestel catalog (content/vangestel), the source of ridrs Scenic's rides. */
const CATALOG = join(import.meta.dirname, '../../content/vangestel');

/** Unpacks the small Incyclist package into the route folder of `key`, with `preview.jpg` where `picture`. */
async function unpackedRoute(key: string, picture = false): Promise<void> {
  const folder = folderOf(key);
  mkdirSync(folder, { recursive: true });
  const reader = new ZipReader(new Uint8ArrayReader(await incyclistPackage(null)));
  for (const entry of await reader.getEntries()) {
    if (!entry.directory)
      writeFileSync(join(folder, entry.filename), await entry.getData(new Uint8ArrayWriter()));
  }
  await reader.close();
  if (picture) writeFileSync(join(folder, 'preview.jpg'), PICTURE_BYTES);
}

Given(
  'the media storage holds the own route folder {string} unpacked from an Incyclist package with a picture',
  async function (this: RidrsWorld, id: string) {
    await unpackedRoute(`video-source-local/${id}`, true);
  },
);

Given(
  'the media storage holds the Van Gestel route {string} with the overlay of an older catalog',
  async function (this: RidrsWorld, id: string) {
    const key = `video-source-scenic/vg-${id}`;
    await unpackedRoute(key);
    writeFileSync(join(folderOf(key), 'preview.jpg'), new TextEncoder().encode('an older picture'));
    writeFileSync(
      join(folderOf(key), '.overlay.json'),
      `${JSON.stringify({ 'preview.jpg': 'an older hash' })}\n`,
    );
  },
);

Then(
  "the route folder {string} holds the catalog's {string} of {string}",
  async function (this: RidrsWorld, key: string, file: string, id: string) {
    const wanted = readFileSync(join(CATALOG, id, 'overlay', file));
    await this.waitForIo(() => {
      const path = join(folderOf(key), file);
      return existsSync(path) && readFileSync(path).equals(wanted);
    }, `"${key}" to hold the catalog's ${file}`);
  },
);

Then(
  'the small picture of {string} is made from its {string}',
  async function (this: RidrsWorld, key: string, file: string) {
    await this.waitForIo(() => {
      const tile = join(folderOf(key), '.tile.jpg');
      const picture = join(folderOf(key), file);
      return (
        existsSync(tile) &&
        existsSync(picture) &&
        readFileSync(tile).equals(
          Buffer.from(smallPicture(new Uint8Array(readFileSync(picture)), 800)),
        )
      );
    }, `the small picture of "${key}" made from ${file}`);
  },
);

Then(
  'the route offer {string} shows the tile picture {string}',
  async function (this: RidrsWorld, key: string, ending: string) {
    await this.waitForIo(() => {
      const offer = this.ensureHost().getState('route.offer').get(key) as
        | { tile?: string }
        | undefined;
      return pathOf(offer?.tile)?.endsWith(ending) === true;
    }, `"${key}" to show the tile picture ${ending}`);
  },
);

Then(
  'the route offer {string} shows the full picture {string}',
  async function (this: RidrsWorld, key: string, ending: string) {
    await this.waitForIo(() => {
      const offer = this.ensureHost().getState('route.offer').get(key) as
        | { thumbnail?: string }
        | undefined;
      return pathOf(offer?.thumbnail)?.endsWith(ending) === true;
    }, `"${key}" to show the full picture ${ending}`);
  },
);
