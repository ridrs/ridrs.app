// SPDX-License-Identifier: AGPL-3.0-or-later

// FIT files are checked with the official Garmin FIT SDK, a devDependency of the tests only
// (ADR 0034). ridrs' own encoder never imports it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { type DataTable, Then, When } from '@cucumber/cucumber';
import { Decoder, Stream } from '@garmin/fitsdk';
import { exportFitState } from '@ridrs/contracts';
import { fitTimestamp } from '@ridrs/fit';
import type { RidrsWorld } from '../support/world.ts';
import { parseOffset } from './physics.steps.ts';
import { memoryFile } from './recording.steps.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const HEADLESS_MAIN = resolve(REPO_ROOT, 'apps/headless/src/main.ts');

/** Speeds in m/s and distances in m, as the brief allows for FIT's scaled integers. */
const SPEED_TOLERANCE = 0.0005;
const DISTANCE_TOLERANCE = 0.005;

type FitMessage = Record<string, unknown>;
type FitMessages = Record<string, FitMessage[] | undefined>;

/** Decodes a FIT file with the official SDK; it must be FIT, intact, and read without errors. */
export function decodeFit(bytes: Uint8Array): FitMessages {
  assert.ok(Decoder.isFIT(Stream.fromByteArray([...bytes])), 'Decoder.isFIT');
  const decoder = new Decoder(Stream.fromByteArray([...bytes]));
  assert.ok(decoder.checkIntegrity(), 'checkIntegrity()');
  const { messages, errors } = decoder.read();
  assert.deepEqual(errors, [], 'read() errors');
  return messages as unknown as FitMessages;
}

/** "file_id" -> "fileIdMesgs", as the SDK names its decoded message lists. */
function messagesKey(name: string): string {
  return `${name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}Mesgs`;
}

/** "virtual_activity" -> "virtualActivity", as the SDK names enum values. */
function camel(value: string): string {
  return value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function latestFitFile(world: RidrsWorld): string {
  const written = world.stateValues<{ file: string }>(exportFitState.id).at(-1);
  assert.ok(written, 'Expected an "export.fit" state');
  return written.file;
}

async function fitOf(world: RidrsWorld): Promise<FitMessages> {
  await world.waitForIo(() => world.stateValues(exportFitState.id).length > 0, 'the FIT export');
  return decodeFit(memoryFile(world, latestFitFile(world)));
}

function only(messages: FitMessages, name: string): FitMessage {
  const list = messages[messagesKey(name)] ?? [];
  assert.equal(list.length, 1, `Expected one "${name}" message, got ${list.length}`);
  return list[0] as FitMessage;
}

function sessionOf(messages: FitMessages): FitMessage {
  return only(messages, 'session');
}

function fitTime(value: unknown): number {
  assert.ok(value instanceof Date, `Expected a FIT date_time, got ${String(value)}`);
  return fitTimestamp(value.getTime());
}

function assertNear(actual: unknown, expected: number, tolerance: number, what: string): void {
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) <= tolerance,
    `${what}: expected ${expected}, got ${String(actual)}`,
  );
}

Then(
  'the latest {string} state names that file with {int} records',
  function (this: RidrsWorld, topic: string, records: number) {
    const payload = this.stateValues<{ file: string; records: number; bytes: number }>(topic).at(
      -1,
    );
    assert.ok(payload, `Expected a "${topic}" state`);
    assert.equal(payload.file, this.lastRecordingFile);
    assert.equal(payload.records, records);
    assert.equal(payload.bytes, memoryFile(this, payload.file).length);
  },
);

Then('the FIT file is valid according to the official FIT SDK', async function (this: RidrsWorld) {
  await fitOf(this);
});

Then(
  'the FIT file has one {string} message of the type {string} from the manufacturer {string}',
  async function (this: RidrsWorld, name: string, type: string, manufacturer: string) {
    const message = only(await fitOf(this), name);
    assert.equal(message.type, camel(type));
    assert.equal(message.manufacturer, camel(manufacturer));
  },
);

Then(
  'the FIT file has one {string} message with the sport {string} and the sub-sport {string}',
  async function (this: RidrsWorld, name: string, sport: string, subSport: string) {
    const message = only(await fitOf(this), name);
    assert.equal(message.sport, camel(sport));
    assert.equal(message.subSport, camel(subSport));
  },
);

Then(
  'the FIT file has one {string} message and one {string} message with {int} session',
  async function (this: RidrsWorld, first: string, second: string, sessions: number) {
    const messages = await fitOf(this);
    only(messages, first);
    assert.equal(only(messages, second).numSessions, sessions);
  },
);

Then(
  'the FIT file has a timer {string} event at {string} and a timer {string} event at {string}',
  async function (this: RidrsWorld, start: string, startAt: string, stop: string, stopAt: string) {
    const timers = ((await fitOf(this)).eventMesgs ?? []).filter((e) => e.event === 'timer');
    assert.deepEqual(
      timers.map((e) => ({ type: e.eventType, at: fitTime(e.timestamp) })),
      [
        { type: camel(start), at: fitTimestamp(parseOffset(startAt)) },
        { type: camel(stop), at: fitTimestamp(parseOffset(stopAt)) },
      ],
    );
  },
);

Then(
  'the FIT record at {string} has a power of {int} W, a heart rate of {int} bpm, a speed of {float} m\\/s and a distance of {float} m',
  async function (
    this: RidrsWorld,
    time: string,
    power: number,
    heartRate: number,
    speed: number,
    distance: number,
  ) {
    const at = fitTimestamp(parseOffset(time));
    const record = ((await fitOf(this)).recordMesgs ?? []).find((r) => fitTime(r.timestamp) === at);
    assert.ok(record, `No FIT record at "${time}"`);
    assert.equal(record.power, power);
    assert.equal(record.heartRate, heartRate);
    assertNear(record.speed, speed, SPEED_TOLERANCE, 'speed (m/s)');
    assertNear(record.enhancedSpeed, speed, SPEED_TOLERANCE, 'enhanced speed (m/s)');
    assertNear(record.distance, distance, DISTANCE_TOLERANCE, 'distance (m)');
  },
);

Then('every FIT record has no cadence', async function (this: RidrsWorld) {
  const records = (await fitOf(this)).recordMesgs ?? [];
  assert.ok(records.length > 0);
  assert.deepEqual(
    records.filter((r) => r.cadence !== undefined),
    [],
  );
});

Then(
  'the FIT session has a total elapsed time of {float} s and a total timer time of {float} s',
  async function (this: RidrsWorld, elapsed: number, timer: number) {
    const session = sessionOf(await fitOf(this));
    assert.equal(session.totalElapsedTime, elapsed);
    assert.equal(session.totalTimerTime, timer);
  },
);

Then(
  'the FIT session has a total distance of {float} m',
  async function (this: RidrsWorld, distance: number) {
    assertNear(
      sessionOf(await fitOf(this)).totalDistance,
      distance,
      DISTANCE_TOLERANCE,
      'distance',
    );
  },
);

Then(
  'the FIT session has an average speed of {float} m\\/s and a maximum speed of {float} m\\/s',
  async function (this: RidrsWorld, avg: number, max: number) {
    const session = sessionOf(await fitOf(this));
    assertNear(session.avgSpeed, avg, SPEED_TOLERANCE, 'average speed');
    assertNear(session.maxSpeed, max, SPEED_TOLERANCE, 'maximum speed');
  },
);

Then(
  'the FIT session has an average power of {int} W and a maximum power of {int} W',
  async function (this: RidrsWorld, avg: number, max: number) {
    const session = sessionOf(await fitOf(this));
    assert.equal(session.avgPower, avg);
    assert.equal(session.maxPower, max);
  },
);

Then(
  'the FIT session has an average heart rate of {int} bpm and a maximum heart rate of {int} bpm',
  async function (this: RidrsWorld, avg: number, max: number) {
    const session = sessionOf(await fitOf(this));
    assert.equal(session.avgHeartRate, avg);
    assert.equal(session.maxHeartRate, max);
  },
);

// ---- The CLI -----------------------------------------------------------------------------

/**
 * Runs `ridrs-headless <args>` (apps/headless) to completion. Plain `child_process`: in the `ui`
 * profile happy-dom replaces `AbortSignal`, which execa hands to Node's event helpers.
 */
export function runHeadless(
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', HEADLESS_MAIN, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ exitCode: code ?? -1, stdout, stderr }));
  });
}

When('the recording is exported with {string}', async function (this: RidrsWorld, command: string) {
  assert.equal(command, 'ridrs-headless recording export-fit');
  await fitOf(this);
  const fitFile = latestFitFile(this);
  const recordingFile = fitFile.replace(/\.fit$/, '.ridrs');
  const dir = await mkdtemp(join(tmpdir(), 'ridrs-phase9-'));
  const input = join(dir, 'ride.ridrs');
  const output = join(dir, 'cli.fit');
  await writeFile(input, memoryFile(this, recordingFile));
  const result = await runHeadless(['recording', 'export-fit', input, '-o', output]);
  assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
  this.cliFitBytes = new Uint8Array(await readFile(output));
});

Then("the CLI's FIT file is byte-identical to the automatic one", function (this: RidrsWorld) {
  assert.ok(this.cliFitBytes, 'Expected the CLI to have exported');
  assert.deepEqual(this.cliFitBytes, memoryFile(this, latestFitFile(this)));
});

// ---- The SDK stays in the tests ----------------------------------------------------------

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'src-tauri') {
      return [];
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return /\.(ts|tsx|js|mjs)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

Then(
  'no source file outside the tests imports {string}',
  function (this: RidrsWorld, specifier: string) {
    const importers = ['packages', 'plugins', 'apps']
      .flatMap((dir) => sourceFiles(resolve(REPO_ROOT, dir)))
      .filter((file) => readFileSync(file, 'utf8').includes(specifier))
      .map((file) => relative(REPO_ROOT, file));
    assert.deepEqual(importers, []);
  },
);

Then('the FIT file has the timer events:', async function (this: RidrsWorld, table: DataTable) {
  const timers = ((await fitOf(this)).eventMesgs ?? []).filter((e) => e.event === 'timer');
  assert.deepEqual(
    timers.map((e) => ({ type: e.eventType, at: fitTime(e.timestamp) })),
    table.hashes().map((row) => ({
      type: camel(row.type ?? ''),
      at: fitTimestamp(parseOffset(row.time ?? '')),
    })),
  );
});

Then(
  'the FIT file has {int} records, none from {string} to {string}',
  async function (this: RidrsWorld, count: number, from: string, to: string) {
    const records = (await fitOf(this)).recordMesgs ?? [];
    assert.equal(records.length, count);
    const inPause = records.filter((r) => {
      const at = fitTime(r.timestamp);
      return at >= fitTimestamp(parseOffset(from)) && at <= fitTimestamp(parseOffset(to));
    });
    assert.deepEqual(inPause, []);
  },
);

Then(
  'the latest {string} state names that file with no record count',
  function (this: RidrsWorld, topic: string) {
    const payload = this.stateValues<{ file: string; records?: number }>(topic).at(-1);
    assert.ok(payload, `Expected a "${topic}" state`);
    assert.equal(payload.file, this.lastRecordingFile);
    assert.equal(payload.records, undefined);
  },
);
