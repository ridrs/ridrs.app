// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then } from '@cucumber/cucumber';
import {
  type CompletedWorkout,
  type DataSource,
  DEFAULT_PROVIDER,
  trainingHistoryState,
} from '@ridrs/contracts';
import { gzip, RECORDINGS_DIRECTORY } from '@ridrs/recording';
import type { RidrsWorld } from '../support/world.ts';

/** The bytes of the recording a scenario put in the app files under its old name. */
const oldBytes = new WeakMap<RidrsWorld, Uint8Array>();

function memory(world: RidrsWorld) {
  assert.ok(world.memoryFiles, 'Expected the memory storage');
  return world.memoryFiles;
}

const inRecordings = (file: string) => `${RECORDINGS_DIRECTORY}/${file}`;

Given(
  'the recordings hold these files, whose content cannot be read:',
  async function (this: RidrsWorld, table: DataTable) {
    for (const { file } of table.hashes()) {
      await memory(this).write(
        inRecordings(file ?? ''),
        new TextEncoder().encode('not a recording'),
      );
    }
  },
);

Given(
  'the recordings hold the sealed ride {string} of {int} s with the workout {string} planned as the {string} entry {string}, and its FIT file',
  async function (
    this: RidrsWorld,
    file: string,
    seconds: number,
    name: string,
    provider: string,
    id: string,
  ) {
    const startedAt = Date.UTC(2026, 10, 1, 9, 0, 0, 0);
    const sessionId = '0badc0de-0000-4000-8000-000000000000';
    const workout = {
      workout: {
        format: 'ridrs-workout',
        version: 1,
        id: 'w',
        name,
        sport: 'virtual-ride',
        source: { kind: 'user' },
        steps: [],
      },
      planned: { provider, id },
    };
    const lines = [
      {
        kind: 'header',
        format: 'ridrs.recording',
        formatVersion: 1,
        ridrsVersion: '0.1.0',
        sessionId,
        startedAt,
        timeZoneOffsetMinutes: 60,
        platform: { runtime: 'node', os: 'test', appVersion: '0.1.0' },
        prerollMs: 60_000,
      },
      { kind: 'snapshot', host: {}, sections: {} },
      {
        kind: 'event',
        seq: 1,
        preroll: false,
        envelope: {
          id: 'e1',
          type: 'activity.state-changed',
          source: 'activity-session',
          timestamp: startedAt,
          payload: { state: 'running', sessionId, startedAt, workout },
        },
      },
      {
        kind: 'footer',
        status: 'complete',
        endedAt: startedAt + seconds * 1000,
        lastSeq: 1,
        counts: { events: 1, diagnostics: 0, byType: { 'activity.state-changed': 1 } },
      },
    ];
    const bytes = await gzip(
      new TextEncoder().encode(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`),
    );
    await memory(this).write(inRecordings(file), bytes);
    await memory(this).write(
      inRecordings(file.replace(/\.ridrs$/, '.fit')),
      new TextEncoder().encode('a FIT file'),
    );
    oldBytes.set(this, bytes);
  },
);

function recordingFiles(world: RidrsWorld): string[] {
  const prefix = `${RECORDINGS_DIRECTORY}/`;
  return [...memory(world).files.keys()]
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length))
    .sort();
}

Then(
  'the recordings come to hold {string} and nothing else',
  async function (this: RidrsWorld, csv: string) {
    const expected = csv.split(', ').sort();
    await this.waitForIo(
      () => JSON.stringify(recordingFiles(this)) === JSON.stringify(expected),
      `the recordings to be ${expected.join(', ')}`,
    );
  },
);

Then('the renamed recording has the bytes of the old one', function (this: RidrsWorld) {
  const renamed = recordingFiles(this).find((file) => file.endsWith('.ridrs'));
  assert.ok(renamed);
  assert.deepEqual(memory(this).files.get(inRecordings(renamed)), oldBytes.get(this));
});

Then(
  'the rides saved on this device are, with the status {string}:',
  async function (this: RidrsWorld, status: string, table: DataTable) {
    const latest = () =>
      this.stateValues<DataSource<{ workouts: CompletedWorkout[] }>>(trainingHistoryState.id).at(
        -1,
      );
    await this.waitForIo(() => latest()?.status === status, `the history to be ${status}`);
    const history = latest();
    assert.equal(this.stateOf(trainingHistoryState.id).at(-1)?.key, DEFAULT_PROVIDER);
    const rows = table.hashes().map((row) => {
      const [provider, id] = (row.planned ?? '').split(' ');
      return {
        id: row.id,
        date: row.date,
        startedAt: Date.parse(row['started at'] ?? ''),
        name: row.name,
        sport: 'virtual-ride',
        durationSeconds: Number(row.duration),
        externalId: (row.id ?? '').replaceAll(':', '_'),
        ...(provider && id ? { planned: { provider, id } } : {}),
      };
    });
    assert.deepEqual(history?.data?.workouts, rows);
  },
);

Then('no recording was read', function (this: RidrsWorld) {
  const read = [...memory(this).reads.keys()].filter((path) => path.endsWith('.ridrs'));
  assert.deepEqual(read, []);
});
