// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Given, Then } from '@cucumber/cucumber';
import { parseControl } from '@ridrs/ride';
import { gpx } from '../support/simulated-downloads.ts';
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

function filesBelow(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesBelow(join(directory, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

Given(
  'the media storage holds the Van Gestel route {string} in the unified format',
  function (this: RidrsWorld, id: string) {
    unifiedRoute(`video-source-vangestel/${id}`, 'Col de Pennes', false);
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
