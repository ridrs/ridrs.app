// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then } from '@cucumber/cucumber';
import { type LibraryWorkout, trainingLibraryState, type WorkoutStep } from '@ridrs/contracts';
import type { RidrsWorld } from '../support/world.ts';

function ridrsLibrary(world: RidrsWorld) {
  const entry = world.ensureHost().getState(trainingLibraryState.id).get('ridrs');
  assert.ok(entry, 'The library "ridrs" is not published');
  return entry as { writable: boolean; data?: { workouts: LibraryWorkout[] } };
}

const workouts = (world: RidrsWorld): LibraryWorkout[] => ridrsLibrary(world).data?.workouts ?? [];

function named(world: RidrsWorld, name: string): LibraryWorkout {
  const found = workouts(world).find((workout) => workout.name === name);
  assert.ok(found, `The library "ridrs" has no "${name}"`);
  return found;
}

Then('the library "ridrs" holds the workouts {string}', function (this: RidrsWorld, names: string) {
  assert.deepEqual(
    workouts(this).map((workout) => workout.name),
    names.split(', '),
  );
});

Then('the library "ridrs" is read only', function (this: RidrsWorld) {
  assert.equal(ridrsLibrary(this).writable, false);
});

Then(
  'every catalogue workout has the author {string} and the licence {string}',
  function (this: RidrsWorld, author: string, license: string) {
    for (const entry of workouts(this)) {
      assert.equal(entry.workout?.author, author, entry.name);
      assert.equal(entry.workout?.license, license, entry.name);
    }
  },
);

Then(
  'every catalogue workout has steps, a duration and a training load',
  function (this: RidrsWorld) {
    for (const entry of workouts(this)) {
      assert.ok(entry.steps.length > 0, `${entry.name} has no steps`);
      assert.ok((entry.durationSeconds ?? 0) > 0, `${entry.name} has no duration`);
      assert.ok((entry.trainingLoad ?? 0) > 0, `${entry.name} has no training load`);
      assert.deepEqual(entry.workout?.steps, entry.steps);
    }
  },
);

Then(
  'the catalogue workout {string} lasts {int} seconds',
  function (this: RidrsWorld, name: string, seconds: number) {
    assert.equal(named(this, name).durationSeconds, seconds);
  },
);

function cadences(steps: readonly WorkoutStep[]): { low: number; high: number }[] {
  return steps.flatMap((step) =>
    step.kind === 'repeat'
      ? cadences(step.steps)
      : step.effort.kind === 'target'
        ? (step.effort.secondary ?? []).filter((t) => t.unit === 'rpm').map((t) => t.start)
        : [],
  );
}

Then(
  'the catalogue workout {string} has a cadence target of {int} to {int} rpm in its repeat',
  function (this: RidrsWorld, name: string, low: number, high: number) {
    const repeat = named(this, name).steps.find((step) => step.kind === 'repeat');
    assert.ok(repeat && repeat.kind === 'repeat', `${name} has no repeat`);
    assert.ok(cadences(repeat.steps).some((c) => c.low === low && c.high === high));
  },
);
