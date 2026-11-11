// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Before, type DataTable, Given, Then, When } from '@cucumber/cucumber';
import type { LibraryWorkout, PlannedWorkout, Workout, WorkoutStep } from '@ridrs/contracts';
// Until `@ridrs/workout` exports the exporters from its index (the lead adds the line).
import { exportIntervalsText, importIntervalsText, type WorkoutDiagnostic } from '@ridrs/workout';
import { contentSync } from '../../plugins/planner-intervals-icu/sync.ts';
import type { RidrsWorld } from '../support/world.ts';
import { simulatedIntervalsIcu } from './training.steps.ts';

/**
 * The workout sync with intervals.icu (structured-workouts.md, sections 6, 8, 9 and 10): the whole
 * workout document, the zones, the intervals.icu exporter and the calendar with content.
 */

// Every scenario starts with the default representation of the content.
Before(() => {
  contentSync.send = 'description';
});

// ---- A test library of ridrs ------------------------------------------------------------------

interface TestLibrary {
  workouts: LibraryWorkout[];
  publish?: () => void;
}

const libraries = new WeakMap<RidrsWorld, TestLibrary>();

function library(world: RidrsWorld): TestLibrary {
  const found = libraries.get(world);
  assert.ok(found, 'Expected a test library');
  return found;
}

Given(
  'a test library plays the library of {string}',
  async function (this: RidrsWorld, provider: string) {
    const testLibrary: TestLibrary = { workouts: [] };
    libraries.set(this, testLibrary);
    const folder = join(this.tempPluginDir, 'test-library');
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, 'manifest.json'),
      JSON.stringify({
        id: 'test-library',
        name: 'Plugin test-library',
        version: '1.0.0',
        types: ['storage'],
        provides: [],
        requires: [],
        entry: 'index.ts',
        state: { owns: ['training.library'] },
      }),
      'utf8',
    );
    const contracts = resolve(import.meta.dirname, '../../packages/contracts/src/index.ts');
    const worldModule = resolve(import.meta.dirname, '../support/world.ts');
    await writeFile(
      join(folder, 'index.ts'),
      [
        '// SPDX-License-Identifier: AGPL-3.0-or-later',
        `import { definePlugin, trainingLibraryState } from ${JSON.stringify(contracts)};`,
        `import { getActiveWorld } from ${JSON.stringify(worldModule)};`,
        'export default definePlugin({',
        '  start(ctx) {',
        `    const hook = (getActiveWorld() as unknown as { testLibrary?: { workouts: unknown[]; publish?: () => void } }).testLibrary;`,
        '    if (!hook) return;',
        `    hook.publish = () => ctx.state.set(trainingLibraryState, ${JSON.stringify(provider)}, {`,
        `      provider: ${JSON.stringify(provider)}, label: 'Test library', status: 'ready', writable: false,`,
        '      data: { workouts: structuredClone(hook.workouts) as never },',
        '    });',
        '    hook.publish();',
        '  },',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    (this as unknown as { testLibrary: TestLibrary }).testLibrary = testLibrary;
  },
);

function importedText(text: string, id: string, name: string): Workout {
  const result = importIntervalsText(text, { id, sourceKind: 'builtin' });
  assert.ok(result.ok, JSON.stringify(result.diagnostics));
  const [workout] = result.workouts;
  assert.ok(workout);
  return { ...workout, name };
}

function libraryEntry(workout: Workout): LibraryWorkout {
  return {
    id: workout.id,
    name: workout.name,
    sport: workout.sport,
    steps: [...workout.steps],
    workout,
  };
}

Given(
  'the library of {string} has the workout {string} named {string} in the intervals.icu text:',
  function (this: RidrsWorld, _provider: string, id: string, name: string, text: string) {
    library(this).workouts.push(libraryEntry(importedText(text, id, name)));
  },
);

When(
  'the workout {string} of {string} changes to the intervals.icu text:',
  async function (this: RidrsWorld, id: string, _provider: string, text: string) {
    const testLibrary = library(this);
    const index = testLibrary.workouts.findIndex((entry) => entry.id === id);
    const old = testLibrary.workouts[index];
    assert.ok(old, `The library has no "${id}"`);
    testLibrary.workouts[index] = libraryEntry(importedText(text, id, old.name));
    testLibrary.publish?.();
    await this.flushState();
  },
);

When(
  'the library of {string} is published again unchanged',
  async function (this: RidrsWorld, _provider: string) {
    library(this).publish?.();
    await this.flushState();
    // Give a follow that should not happen the time to show itself.
    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise((done) => setImmediate(done));
      await this.settle();
    }
  },
);

// ---- The planner ---------------------------------------------------------------------------

Given('the planner sends the workout content to intervals.icu as a workout document', () => {
  contentSync.send = 'workout_doc';
});

When(
  'the rider plans the workout {string} of {string} on {string} in the calendar of {string}',
  async function (
    this: RidrsWorld,
    workoutId: string,
    from: string,
    date: string,
    provider: string,
  ) {
    const answer = await this.ensureHost().callService('training.calendar.plan', {
      key: provider,
      date,
      workoutId,
      from,
    });
    assert.deepEqual(answer, { ok: true });
    await this.flushState();
  },
);

When(
  'the rider changes the zones of the profile of {string} to:',
  async function (this: RidrsWorld, provider: string, table: DataTable) {
    const zones = (kind: string) =>
      table
        .hashes()
        .filter((row) => row.kind === kind)
        .map((row) => ({
          ...(row.name ? { name: row.name } : {}),
          ...(row['up to'] ? { upTo: Number(row['up to']) } : {}),
        }));
    const power = zones('power');
    const heart = zones('hr');
    const answer = await this.ensureHost().callService('athlete.profile.update', {
      key: provider,
      ...(power.length > 0 ? { powerZones: power } : {}),
      ...(heart.length > 0 ? { heartRateZones: heart } : {}),
    });
    assert.deepEqual(answer, { ok: true });
    await this.flushState();
  },
);

// ---- The simulated intervals.icu -----------------------------------------------------------

let nextDocEventId = 95_001;

Given(
  'intervals.icu plans {string} on {string} with the workout document:',
  function (this: RidrsWorld, name: string, date: string, json: string) {
    simulatedIntervalsIcu(this).events.push({
      id: nextDocEventId++,
      start_date_local: `${date}T00:00:00`,
      category: 'WORKOUT',
      type: 'Ride',
      name,
      workout_doc: JSON.parse(json) as { steps: unknown[] },
    });
  },
);

Given('intervals.icu keeps the Ride zones:', function (this: RidrsWorld, table: DataTable) {
  const simulation = simulatedIntervalsIcu(this);
  for (const row of table.hashes()) {
    const values = (row.values ?? '').split(',').map((value) => value.trim());
    simulation.rideZones[row.field ?? ''] = (row.field ?? '').endsWith('_names')
      ? values
      : values.map(Number);
  }
});

When(
  'the event on {string} is changed in intervals.icu to the description {string}',
  function (this: RidrsWorld, date: string, description: string) {
    const event = simulatedIntervalsIcu(this).events.find((candidate) =>
      candidate.start_date_local.startsWith(date),
    );
    assert.ok(event, `intervals.icu plans nothing on ${date}`);
    event.description = description;
  },
);

function createdEvent(world: RidrsWorld): Promise<Record<string, unknown>> {
  const simulation = simulatedIntervalsIcu(world);
  return world
    .waitForIo(
      () => simulation.eventLog.some((entry) => entry.method === 'POST'),
      'the event to reach intervals.icu',
    )
    .then(() => simulation.eventLog.filter((entry) => entry.method === 'POST').at(-1)?.body ?? {});
}

Then(
  'the event created in intervals.icu has the description:',
  async function (this: RidrsWorld, text: string) {
    assert.equal((await createdEvent(this)).description, text);
  },
);

Then(
  'the event created in intervals.icu has no workout document',
  async function (this: RidrsWorld) {
    assert.equal((await createdEvent(this)).workout_doc, undefined);
  },
);

Then(
  'the event created in intervals.icu has the workout document:',
  async function (this: RidrsWorld, json: string) {
    assert.deepEqual((await createdEvent(this)).workout_doc, JSON.parse(json));
  },
);

/** The writes of `method` to the event planned on `date`. */
function writesOn(world: RidrsWorld, method: string, date: string): Array<Record<string, unknown>> {
  const simulation = simulatedIntervalsIcu(world);
  const ids = new Set(
    simulation.events
      .filter((event) => event.start_date_local.startsWith(date))
      .map((event) => String(event.id)),
  );
  return simulation.requests
    .filter((request) => {
      const match = /\/events\/(\d+)$/.exec(new URL(request.url).pathname);
      return request.method === method && match !== null && ids.has(match[1] ?? '');
    })
    .map(
      (request) =>
        JSON.parse(typeof request.body === 'string' ? request.body : '{}') as Record<
          string,
          unknown
        >,
    );
}

Then(
  'intervals.icu received {string} for the event on {string} with the description:',
  async function (this: RidrsWorld, method: string, date: string, text: string) {
    await this.waitForIo(
      () => writesOn(this, method, date).length > 0,
      `${method} of the event on ${date}`,
    );
    assert.equal(writesOn(this, method, date).at(-1)?.description, text);
  },
);

Then(
  'intervals.icu received no {string} for the event on {string}',
  async function (this: RidrsWorld, method: string, date: string) {
    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise((done) => setImmediate(done));
      await this.settle();
    }
    assert.deepEqual(writesOn(this, method, date), []);
  },
);

// ---- What the planner shows ----------------------------------------------------------------

/** The latest data of a provider's key in a topic. */
function latest<T>(world: RidrsWorld, topic: string, provider: string): T | undefined {
  return world
    .stateValues<{ provider: string; data?: T }>(topic)
    .findLast((value) => value.provider === provider)?.data;
}

function planned(
  world: RidrsWorld,
  provider: string,
  match: (workout: PlannedWorkout) => boolean,
): PlannedWorkout | undefined {
  return latest<{ workouts: PlannedWorkout[] }>(
    world,
    'training.calendar',
    provider,
  )?.workouts.find(match);
}

async function plannedOn(
  world: RidrsWorld,
  provider: string,
  date: string,
  check: (workout: PlannedWorkout) => boolean,
  what: string,
): Promise<PlannedWorkout> {
  await world.waitForIo(() => {
    const workout = planned(world, provider, (candidate) => candidate.date === date);
    return workout !== undefined && check(workout);
  }, what);
  const workout = planned(world, provider, (candidate) => candidate.date === date);
  assert.ok(workout);
  return workout;
}

/** Steps compared as JSON: the order of keys does not matter, `undefined` fields are absent. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

Then(
  'the planned workout {string} of {string} has the steps:',
  async function (this: RidrsWorld, name: string, provider: string, json: string) {
    await this.waitForIo(
      () => planned(this, provider, (workout) => workout.name === name) !== undefined,
      `the planned workout "${name}"`,
    );
    assert.deepEqual(
      plain(planned(this, provider, (workout) => workout.name === name)?.steps),
      JSON.parse(json),
    );
  },
);

Then(
  'the library workout {string} of {string} has the steps:',
  async function (this: RidrsWorld, name: string, provider: string, json: string) {
    const find = () =>
      latest<{ workouts: LibraryWorkout[] }>(this, 'training.library', provider)?.workouts.find(
        (workout) => workout.name === name,
      );
    await this.waitForIo(() => find() !== undefined, `the library workout "${name}"`);
    assert.deepEqual(plain(find()?.steps), JSON.parse(json));
  },
);

Then(
  'the planned workout on {string} of {string} follows the workout {string} of {string}',
  async function (
    this: RidrsWorld,
    date: string,
    provider: string,
    workoutId: string,
    from: string,
  ) {
    const workout = await plannedOn(
      this,
      provider,
      date,
      (candidate) => candidate.library?.workoutId === workoutId && candidate.library.from === from,
      `the entry on ${date} to follow "${workoutId}"`,
    );
    assert.deepEqual(workout.library, { from, workoutId });
  },
);

Then(
  'the planned workout on {string} of {string} follows no library workout',
  async function (this: RidrsWorld, date: string, provider: string) {
    await plannedOn(
      this,
      provider,
      date,
      (workout) => workout.library === undefined,
      `the entry on ${date} to follow nothing`,
    );
  },
);

Then(
  'the planned workout on {string} of {string} has the description {string}',
  async function (this: RidrsWorld, date: string, provider: string, description: string) {
    await plannedOn(
      this,
      provider,
      date,
      (workout) => workout.description === description,
      `the description on ${date}`,
    );
  },
);

Then(
  'the planned workout on {string} of {string} has the steps of the workout {string} of {string}',
  async function (
    this: RidrsWorld,
    date: string,
    provider: string,
    workoutId: string,
    _from: string,
  ) {
    const steps = (): readonly WorkoutStep[] | undefined =>
      library(this).workouts.find((entry) => entry.id === workoutId)?.workout?.steps;
    await plannedOn(
      this,
      provider,
      date,
      (workout) => JSON.stringify(plain(workout.steps)) === JSON.stringify(plain(steps())),
      `the entry on ${date} to have the steps of "${workoutId}"`,
    );
  },
);

Then(
  'the athlete profile of {string} has the power zones:',
  async function (this: RidrsWorld, provider: string, table: DataTable) {
    await zonesAre(this, provider, 'powerZones', table);
  },
);

Then(
  'the athlete profile of {string} has the heart rate zones:',
  async function (this: RidrsWorld, provider: string, table: DataTable) {
    await zonesAre(this, provider, 'heartRateZones', table);
  },
);

async function zonesAre(
  world: RidrsWorld,
  provider: string,
  field: string,
  table: DataTable,
): Promise<void> {
  const expected = table.hashes().map((row) => ({
    ...(row.name ? { name: row.name } : {}),
    ...(row['up to'] ? { upTo: Number(row['up to']) } : {}),
  }));
  const actual = () => latest<Record<string, unknown>>(world, 'athlete.profile', provider)?.[field];
  await world
    .waitForIo(
      () => JSON.stringify(actual()) === JSON.stringify(expected),
      `the ${field} of ${provider}`,
    )
    .catch(() => undefined);
  assert.deepEqual(actual(), expected);
}

// ---- The intervals.icu exporter ------------------------------------------------------------

interface ExportRun {
  text?: string;
  workout?: Workout;
  first?: Workout;
  exported?: string;
  second?: Workout;
  diagnostics: readonly WorkoutDiagnostic[];
}

const runs = new WeakMap<RidrsWorld, ExportRun>();

function run(world: RidrsWorld): ExportRun {
  const found = runs.get(world);
  assert.ok(found, 'Nothing to export');
  return found;
}

Given('the intervals.icu text to export:', function (this: RidrsWorld, text: string) {
  runs.set(this, { text, diagnostics: [] });
});

Given('the canonical workout to export:', function (this: RidrsWorld, json: string) {
  runs.set(this, { workout: JSON.parse(json) as Workout, diagnostics: [] });
});

When(
  'it is imported, exported as intervals.icu text and imported again',
  function (this: RidrsWorld) {
    const state = run(this);
    const first = importIntervalsText(state.text ?? '', {
      id: 'round-trip',
      fileName: 'round-trip.txt',
    });
    assert.ok(first.ok, JSON.stringify(first.diagnostics));
    state.first = first.workouts[0];
    assert.ok(state.first);
    const exported = exportIntervalsText(state.first);
    state.exported = exported.text;
    state.diagnostics = exported.diagnostics;
    const second = importIntervalsText(exported.text, {
      id: 'round-trip',
      fileName: 'round-trip.txt',
    });
    assert.ok(second.ok, JSON.stringify(second.diagnostics));
    state.second = second.workouts[0];
  },
);

When('it is exported as intervals.icu text', function (this: RidrsWorld) {
  const state = run(this);
  assert.ok(state.workout);
  const exported = exportIntervalsText(state.workout);
  state.exported = exported.text;
  state.diagnostics = exported.diagnostics;
});

Then('the export is exactly the text', function (this: RidrsWorld) {
  assert.equal(run(this).exported, run(this).text);
});

Then('the export is:', function (this: RidrsWorld, text: string) {
  assert.equal(run(this).exported, text);
});

Then('both imports give the same workout', function (this: RidrsWorld) {
  assert.deepEqual(run(this).second, run(this).first);
});

Then('the export has no warnings', function (this: RidrsWorld) {
  assert.deepEqual(run(this).diagnostics, []);
});

Then('the export warns {string}', function (this: RidrsWorld, codes: string) {
  const seen = [...new Set(run(this).diagnostics.map((diagnostic) => diagnostic.code))];
  assert.deepEqual(
    seen,
    codes.split(',').map((code) => code.trim()),
  );
});
