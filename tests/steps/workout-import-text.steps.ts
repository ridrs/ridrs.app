// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import type { Workout, WorkoutStep } from '@ridrs/contracts';
import {
  importErg,
  importIntervalsText,
  importMrc,
  importTcx,
  importZwo,
  type WorkoutImporter,
  type WorkoutImportResult,
} from '@ridrs/workout';

/** What a scenario of the text importers has: the file it gave and the result of the import. */
interface TextImport {
  fileName: string;
  content: string;
  result?: WorkoutImportResult;
}

const imports = new WeakMap<object, TextImport>();

const state = (world: object): TextImport => {
  const current = imports.get(world);
  assert.ok(current, 'no workout text file was given');
  return current;
};

const importerFor = (fileName: string): WorkoutImporter => {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  const importers: Record<string, WorkoutImporter> = {
    zwo: importZwo,
    erg: importErg,
    mrc: importMrc,
    tcx: importTcx,
    txt: importIntervalsText,
  };
  const importer = importers[extension];
  assert.ok(importer, `no importer for .${extension}`);
  return importer;
};

const imported = (world: object): Workout => {
  const { result } = state(world);
  assert.ok(result?.ok, `the import was refused: ${JSON.stringify(result?.diagnostics)}`);
  const [workout] = result.workouts;
  assert.ok(workout, 'the import gave no workout');
  return workout;
};

/** A step by its path id (`2.1`). */
const stepOf = (world: object, id: string): WorkoutStep => {
  const find = (steps: readonly WorkoutStep[]): WorkoutStep | undefined => {
    for (const step of steps) {
      if (step.id === id) return step;
      if (step.kind === 'repeat') {
        const inner = find(step.steps);
        if (inner) return inner;
      }
    }
    return undefined;
  };
  const step = find(imported(world).steps);
  assert.ok(step, `no step "${id}"`);
  return step;
};

const intervalOf = (world: object, id: string) => {
  const step = stepOf(world, id);
  assert.equal(step.kind, 'interval', `step "${id}" is a repeat`);
  assert.ok(step.kind === 'interval');
  return step;
};

/** `children[0].node.name` on a JSON value. */
const valueAt = (root: unknown, path: string): unknown =>
  path
    .split(/\.|(?=\[)/)
    .filter(Boolean)
    .reduce<unknown>((value, part) => {
      const index = /^\[(\d+)\]$/.exec(part);
      const key = index ? Number(index[1]) : part;
      return value === null || typeof value !== 'object'
        ? undefined
        : (value as Record<string | number, unknown>)[key];
    }, root);

Given('a workout text file {string}:', function (this: object, fileName: string, content: string) {
  imports.set(this, { fileName, content });
});

When('the workout text file is imported', function (this: object) {
  const current = state(this);
  current.result = importerFor(current.fileName)(current.content, { fileName: current.fileName });
});

Then('the import succeeds with {int} workout(s)', function (this: object, count: number) {
  const { result } = state(this);
  assert.ok(result?.ok, `the import was refused: ${JSON.stringify(result?.diagnostics)}`);
  assert.equal(result.workouts.length, count);
});

Then('the import is refused with the code {string}', function (this: object, code: string) {
  const { result } = state(this);
  assert.ok(result && !result.ok, 'the import succeeded');
  assert.ok(
    result.diagnostics.some((d) => d.severity === 'error' && d.code === code),
    `no error "${code}" in ${JSON.stringify(result.diagnostics)}`,
  );
});

Then('the import has a reason', function (this: object) {
  const { result } = state(this);
  const error = result?.diagnostics.find((d) => d.severity === 'error');
  assert.ok(error && error.message.length > 10, 'the refusal has no reason');
});

Then('the import reports the warning {string}', function (this: object, code: string) {
  const { result } = state(this);
  assert.ok(
    result?.diagnostics.some((d) => d.severity === 'warning' && d.code === code),
    `no warning "${code}" in ${JSON.stringify(result?.diagnostics)}`,
  );
});

Then('the imported workout is named {string}', function (this: object, name: string) {
  assert.equal(imported(this).name, name);
});

Then('the imported workout has the description {string}', function (this: object, text: string) {
  assert.equal(imported(this).description, text);
});

Then('the imported workout has the reference FTP {int}', function (this: object, ftp: number) {
  assert.equal(imported(this).referenceFtp, ftp);
});

Then(
  'in the imported workout, step {string} lasts {int} seconds',
  function (this: object, id: string, seconds: number) {
    assert.deepEqual(intervalOf(this, id).duration, { kind: 'time', seconds });
  },
);

Then(
  'in the imported workout, step {string} lasts {int} meters',
  function (this: object, id: string, meters: number) {
    assert.deepEqual(intervalOf(this, id).duration, { kind: 'distance', meters });
  },
);

Then(
  'in the imported workout, step {string} lasts until the lap button',
  function (this: object, id: string) {
    assert.deepEqual(intervalOf(this, id).duration, { kind: 'open' });
  },
);

Then(
  'in the imported workout, step {string} lasts until the heart rate is below {int} bpm',
  function (this: object, id: string, value: number) {
    assert.deepEqual(intervalOf(this, id).duration, {
      kind: 'until',
      unit: 'bpm',
      comparison: 'below',
      value,
    });
  },
);

const primaryOf = (world: object, id: string) => {
  const { effort } = intervalOf(world, id);
  assert.equal(effort.kind, 'target', `step "${id}" has no target`);
  assert.ok(effort.kind === 'target');
  return effort.primary;
};

Then(
  'in the imported workout, step {string} holds {float} {word}',
  function (this: object, id: string, value: number, unit: string) {
    const target = primaryOf(this, id);
    assert.deepEqual(target, { unit, start: { low: value, high: value } });
  },
);

Then(
  'in the imported workout, step {string} holds {float} to {float} {word}',
  function (this: object, id: string, low: number, high: number, unit: string) {
    const target =
      unit === 'rpm'
        ? (() => {
            const { effort } = intervalOf(this, id);
            assert.ok(effort.kind === 'target' || effort.kind === 'free');
            return effort.kind === 'target' && effort.primary.unit === 'rpm'
              ? effort.primary
              : effort.secondary?.[0];
          })()
        : primaryOf(this, id);
    assert.deepEqual(target, { unit, start: { low, high } });
  },
);

Then(
  'in the imported workout, step {string} ramps from {float} to {float} {word}',
  function (this: object, id: string, from: number, to: number, unit: string) {
    assert.deepEqual(primaryOf(this, id), {
      unit,
      start: { low: from, high: from },
      end: { low: to, high: to },
    });
  },
);

Then(
  'in the imported workout, step {string} also targets {float} {word}',
  function (this: object, id: string, value: number, unit: string) {
    const { effort } = intervalOf(this, id);
    assert.ok(effort.kind !== 'max-effort');
    assert.ok(effort.secondary?.some((t) => t.unit === unit && t.start.low === value));
  },
);

Then(
  'in the imported workout, step {string} also targets {float} to {float} {word}',
  function (this: object, id: string, low: number, high: number, unit: string) {
    const { effort } = intervalOf(this, id);
    assert.ok(effort.kind !== 'max-effort');
    assert.deepEqual(effort.secondary?.find((t) => t.unit === unit)?.start, { low, high });
  },
);

Then(
  'in the imported workout, step {string} is a repeat of {int} times',
  function (this: object, id: string, reps: number) {
    const step = stepOf(this, id);
    assert.equal(step.kind, 'repeat');
    assert.ok(step.kind === 'repeat');
    assert.deepEqual(step.until, { kind: 'count', reps });
  },
);

Then(
  'in the imported workout, step {string} has the intensity {string}',
  function (this: object, id: string, intensity: string) {
    assert.equal(intervalOf(this, id).intensity, intensity);
  },
);

Then(
  'in the imported workout, step {string} has the name {string}',
  function (this: object, id: string, name: string) {
    assert.equal(intervalOf(this, id).name, name);
  },
);

Then('in the imported workout, step {string} is free riding', function (this: object, id: string) {
  assert.equal(intervalOf(this, id).effort.kind, 'free');
});

Then(
  'in the imported workout, step {string} is free riding on a flat road',
  function (this: object, id: string) {
    const { effort } = intervalOf(this, id);
    assert.ok(effort.kind === 'free' && effort.flatRoad === true);
  },
);

Then('in the imported workout, step {string} is a max effort', function (this: object, id: string) {
  assert.equal(intervalOf(this, id).effort.kind, 'max-effort');
});

Then(
  'in the imported workout, step {string} has the cue {string} at {int} seconds',
  function (this: object, id: string, text: string, offsetSeconds: number) {
    const cue = intervalOf(this, id).cues?.find((c) => c.text === text);
    assert.ok(cue, `no cue "${text}" in ${JSON.stringify(intervalOf(this, id).cues)}`);
    assert.equal(cue.offsetSeconds, offsetSeconds);
  },
);

Then(
  'the {word} extensions of step {string} have {string} equal to {string}',
  function (this: object, format: string, id: string, path: string, expected: string) {
    const extensions = (stepOf(this, id).extensions ?? {}) as Record<string, unknown>;
    assert.equal(String(valueAt(extensions[format], path)), expected);
  },
);

Then(
  'the {word} extensions of the workout have {string} equal to {string}',
  function (this: object, format: string, path: string, expected: string) {
    const extensions = (imported(this).extensions ?? {}) as Record<string, unknown>;
    assert.equal(String(valueAt(extensions[format], path)), expected);
  },
);
