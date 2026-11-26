// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Given, Then, When } from '@cucumber/cucumber';
import { type PluginEntry, processRunCapability } from '@ridrs/contracts';
import { waitFor, within } from '@testing-library/dom';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import type { RidrsWorld } from '../support/world.ts';
import { drop } from './file-drop.steps.ts';

/** Plugins as the rider installs them: a manifest and one bundled ES module each. */
const LOADABLE = resolve(import.meta.dirname, '../fixtures/plugins/loadable');

/** The ZIP of a loadable plugin of the fixtures; with `id`, its manifest names that id instead. */
async function pluginZip(name: string, id?: string): Promise<Uint8Array> {
  const folder = join(LOADABLE, name);
  const zip = new ZipWriter(new Uint8ArrayWriter());
  for (const file of readdirSync(folder)) {
    let bytes = new Uint8Array(readFileSync(join(folder, file)));
    if (file === 'manifest.json' && id) {
      const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      bytes = new TextEncoder().encode(JSON.stringify({ ...manifest, id }));
    }
    await zip.add(file, new Uint8ArrayReader(bytes));
  }
  return zip.close();
}

When(
  'the rider drags the plugin {string} onto the window',
  async function (this: RidrsWorld, name: string) {
    drop(this).dragBytes(`${name}.zip`, await pluginZip(name));
  },
);

When(
  'the rider drags the plugin {string} as {string} onto the window',
  async function (this: RidrsWorld, name: string, id: string) {
    drop(this).dragBytes(`${name}.zip`, await pluginZip(name, id));
  },
);

type Verdict = { kind: string; plugin?: Record<string, unknown>; reason?: string };

const verdictOf = (world: RidrsWorld): Verdict | undefined =>
  (
    world.ensureHost().getState('file.drop').get('window') as
      | { files: { verdict: Verdict }[] }
      | undefined
  )?.files[0]?.verdict;

Then(
  'the dragged file is the plugin {string} {word}, asking for {string} and the programs {string}',
  function (
    this: RidrsWorld,
    name: string,
    version: string,
    capabilities: string,
    programs: string,
  ) {
    const verdict = verdictOf(this);
    assert.equal(verdict?.kind, 'plugin', JSON.stringify(verdict));
    assert.deepEqual(verdict?.plugin, {
      id: 'test-youtube-downloader',
      name,
      version,
      capabilities: capabilities.split(', '),
      programs: programs.split(', '),
    });
  },
);

Then('the dragged file is refused: {string}', function (this: RidrsWorld, reason: string) {
  assert.deepEqual(verdictOf(this), { kind: 'refused', reason });
});

const installedFolder = (id: string) => join(process.env.RIDRS_MEDIA_DIR ?? '', 'plugins', id);

Then(
  'the media storage holds the installed plugin {string}',
  async function (this: RidrsWorld, id: string) {
    await this.waitForIo(
      () =>
        existsSync(join(installedFolder(id), 'manifest.json')) &&
        existsSync(join(installedFolder(id), 'index.js')),
      `the plugin "${id}" to be installed`,
    );
  },
);

Then(
  'the media storage holds no installed plugin {string}',
  async function (this: RidrsWorld, id: string) {
    await this.waitForIo(() => !existsSync(installedFolder(id)), `the plugin "${id}" to be gone`);
  },
);

const entryOf = (world: RidrsWorld, id: string) =>
  world.ensureHost().getState('plugins.list').get(id) as PluginEntry | undefined;

/** How the list shows a plugin, in words: `bundled, on, running, locked`. */
const wordsOf = (entry: PluginEntry) =>
  [
    entry.origin,
    entry.enabled ? 'on' : 'off',
    entry.running ? 'running' : 'stopped',
    ...(entry.locked ? ['locked'] : []),
  ].join(', ');

Then(
  'the plugin {string} is {string}',
  async function (this: RidrsWorld, id: string, words: string) {
    await this.waitForIo(
      () => {
        const entry = entryOf(this, id);
        return entry !== undefined && wordsOf(entry) === words;
      },
      `the plugin "${id}" to be "${words}", not "${(() => {
        const entry = entryOf(this, id);
        return entry ? wordsOf(entry) : 'unlisted';
      })()}"`,
    );
  },
);

Then('there is no plugin {string}', async function (this: RidrsWorld, id: string) {
  await this.settle();
  assert.equal(entryOf(this, id), undefined);
});

Given(
  'a test plugin {string} provides {string} and a test plugin {string} requires it',
  async function (this: RidrsWorld, provider: string, capability: string, user: string) {
    this.getOrRegisterCapability(capability);
    this.getBehavior(provider).providedImplementations.set(capability, {});
    await this.writeProbePluginFolder({
      folder: provider,
      id: provider,
      types: ['test'],
      provides: [capability],
    });
    await this.writeProbePluginFolder({
      folder: user,
      id: user,
      types: ['test'],
      requires: [capability],
    });
    this.realPluginIds.push(provider, user);
  },
);

Then(
  'the plugin {string} is needed by {string}',
  async function (this: RidrsWorld, id: string, user: string) {
    await this.waitForIo(() => entryOf(this, id) !== undefined, `the plugin "${id}" to be listed`);
    assert.deepEqual(entryOf(this, id)?.neededBy, [user]);
  },
);

/** What the last program started through `process.run` did. */
const programs = new WeakMap<RidrsWorld, { code?: number; error?: string }>();

When(
  'a plugin runs the program {string} through process.run',
  async function (this: RidrsWorld, program: string) {
    const run = this.ensureHost().getProvider(processRunCapability);
    assert.ok(run, 'No plugin provides process.run');
    programs.set(
      this,
      await run.run({ program, args: ['-e', ''] }).then(
        ({ code }) => ({ code }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      ),
    );
  },
);

Then('the program was refused: {string}', function (this: RidrsWorld, reason: string) {
  assert.deepEqual(programs.get(this), { error: reason });
});

/** Runs of a program under a key, by the step's name for each caller. */
interface KeyedRun {
  readonly lines: string[];
  readonly abort: AbortController;
  readonly done: Promise<number | undefined>;
}
const keyedRuns = new WeakMap<RidrsWorld, Map<string, KeyedRun>>();

function keyedRunsOf(world: RidrsWorld): Map<string, KeyedRun> {
  const runs = keyedRuns.get(world) ?? new Map<string, KeyedRun>();
  keyedRuns.set(world, runs);
  return runs;
}

function processRunOf(world: RidrsWorld) {
  const run = world.ensureHost().getProvider(processRunCapability);
  assert.ok(run, 'No plugin provides process.run');
  return run;
}

function startKeyed(
  world: RidrsWorld,
  name: string,
  start: (onLine: (line: string) => void, signal: AbortSignal) => Promise<number | undefined>,
) {
  const lines: string[] = [];
  const abort = new AbortController();
  const done = start((line) => lines.push(line), abort.signal);
  keyedRunsOf(world).set(name, { lines, abort, done });
}

When(
  'the run {string} starts the program {string} under the key {string}, which writes {string} and ends with {int} after {int} s',
  async function (
    this: RidrsWorld,
    name: string,
    program: string,
    key: string,
    line: string,
    code: number,
    seconds: number,
  ) {
    const script = `setTimeout(() => { console.log(${JSON.stringify(line)}); process.exit(${code}); }, ${seconds * 1000});`;
    const run = processRunOf(this);
    startKeyed(this, name, (onLine, signal) =>
      run.run({ program, args: ['-e', script], key }, onLine, signal).then(({ code }) => code),
    );
    // The program is running before the next caller comes.
    await sleep(200);
  },
);

When(
  'the run {string} starts the program {string} under the key {string}, which ends with {int} at once',
  function (this: RidrsWorld, name: string, program: string, key: string, code: number) {
    const run = processRunOf(this);
    startKeyed(this, name, (onLine, signal) =>
      run
        .run({ program, args: ['-e', `process.exit(${code})`], key }, onLine, signal)
        .then(({ code }) => code),
    );
  },
);

When(
  'the run {string} attaches to the key {string}',
  function (this: RidrsWorld, name: string, key: string) {
    const run = processRunOf(this);
    startKeyed(this, name, (onLine, signal) =>
      run.attach(key, onLine, signal).then((result) => result?.code),
    );
  },
);

When('the run {string} is cancelled', function (this: RidrsWorld, name: string) {
  const run = keyedRunsOf(this).get(name);
  assert.ok(run, `There is no run "${name}"`);
  run.abort.abort();
});

Then(
  'the run {string} heard {string} and ended with {int}',
  async function (this: RidrsWorld, name: string, line: string, code: number) {
    const run = keyedRunsOf(this).get(name);
    assert.ok(run, `There is no run "${name}"`);
    assert.equal(await run.done, code);
    assert.deepEqual(run.lines, [line]);
  },
);

Then(
  'the run {string} ended with {int}',
  async function (this: RidrsWorld, name: string, code: number) {
    const run = keyedRunsOf(this).get(name);
    assert.ok(run, `There is no run "${name}"`);
    assert.equal(await run.done, code);
  },
);

Then('nothing runs under the key {string}', async function (this: RidrsWorld, key: string) {
  assert.equal(await processRunOf(this).attach(key), undefined);
});

Then('the plugins page reads {string}', async function (this: RidrsWorld, text: string) {
  const view = this.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  await waitFor(() => {
    const page = within(view.root).getByRole('tabpanel');
    assert.ok(page.textContent?.includes(text), page.textContent ?? '');
  });
});

Then(
  'the route offer {string} is {string} once its program has run',
  async function (this: RidrsWorld, key: string, state: string) {
    // A program of the device runs in real time: up to 10 s of it.
    const stateOf = () =>
      (
        this.ensureHost().getState('route.offer').get(key) as
          | { availability?: { state: string } }
          | undefined
      )?.availability?.state;
    for (let waited = 0; waited < 10_000 && stateOf() !== state; waited += 20) {
      await this.settle();
      await sleep(20);
    }
    assert.equal(stateOf(), state);
  },
);
