// SPDX-License-Identifier: AGPL-3.0-or-later

// The FIT workout importer, headless: hand-written vectors from packages/workout/test-vectors/fit
// and workouts made by the official Garmin FIT SDK at test time (a devDependency of the tests
// only, ADR 0034, 0084).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Then, When } from '@cucumber/cucumber';
import { Encoder, Profile } from '@garmin/fitsdk';
import type {
  WorkoutDuration,
  WorkoutRepeat,
  WorkoutRepeatUntil,
  WorkoutStep,
  WorkoutTarget,
} from '@ridrs/contracts';
import { importFit, type WorkoutImportResult } from '@ridrs/workout';

const VECTORS = resolve(import.meta.dirname, '../../packages/workout/test-vectors/fit');

const results = new WeakMap<object, WorkoutImportResult>();

function result(world: object): WorkoutImportResult {
  const imported = results.get(world);
  assert.ok(imported, 'No FIT workout was imported');
  return imported;
}

function workout(world: object) {
  const imported = result(world);
  assert.ok(imported.ok, `The FIT import was refused: ${JSON.stringify(imported.diagnostics)}`);
  const first = imported.workouts[0];
  assert.ok(first);
  return first;
}

function find(steps: readonly WorkoutStep[], id: string): WorkoutStep | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    const inner = step.kind === 'repeat' ? find(step.steps, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

function step(world: object, id: string): WorkoutStep {
  const found = find(workout(world).steps, id);
  assert.ok(found, `No step "${id}"`);
  return found;
}

const range = (target: WorkoutTarget) =>
  `${target.unit} ${target.start.low}–${target.start.high}${target.end ? ` to ${target.end.low}–${target.end.high}` : ''}${target.averaging ? ` over ${target.averaging}` : ''}`;

function length(duration: WorkoutDuration): string {
  switch (duration.kind) {
    case 'time':
      return `${duration.seconds} s`;
    case 'distance':
      return `${duration.meters} m`;
    case 'energy':
      return `${duration.kilocalories} kcal`;
    case 'open':
      return 'until the lap button';
    case 'until':
      return `until ${duration.unit} ${duration.comparison} ${duration.value}`;
  }
}

function until(end: WorkoutRepeatUntil): string {
  switch (end.kind) {
    case 'count':
      return `repeat ${end.reps} times`;
    case 'time':
      return `repeat until ${end.seconds} s`;
    case 'distance':
      return `repeat until ${end.meters} m`;
    case 'energy':
      return `repeat until ${end.kilocalories} kcal`;
    case 'condition':
      return `repeat until ${end.unit} ${end.comparison} ${end.value}`;
  }
}

/** "240 s at percent-ftp 115–115 with rpm 95–105", "open target for 300 s", "repeat 5 times". */
function describe(step: WorkoutStep): string {
  if (step.kind === 'repeat') {
    return until(step.until);
  }
  const { effort, duration } = step;
  const secondary =
    effort.kind !== 'max-effort' && effort.secondary
      ? effort.secondary.map((target) => ` with ${range(target)}`).join('')
      : '';
  if (effort.kind === 'target') {
    return `${length(duration)} at ${range(effort.primary)}${secondary}`;
  }
  if (effort.kind === 'free') {
    const how = ['time', 'distance', 'energy'].includes(duration.kind) ? 'for ' : '';
    return `open target ${how}${length(duration)}${secondary}`;
  }
  return `max effort ${length(duration)}`;
}

function fitExtension(step: WorkoutStep): Record<string, unknown> {
  return (step.extensions?.fit ?? {}) as Record<string, unknown>;
}

const list = (text: string) => text.split(',').map((item) => item.trim());

When('the FIT workout file {string} is imported', function (this: object, name: string) {
  const bytes = new Uint8Array(readFileSync(resolve(VECTORS, name)));
  results.set(this, importFit(bytes, { fileName: name }));
});

When(
  'a FIT workout of 3 × \\(30 s at 400 W, 30 s at 60 % FTP) made by the official FIT SDK is imported',
  function (this: object) {
    const encoder = new Encoder();
    const write = (mesg: Record<string, unknown>) => encoder.writeMesg(mesg as never);
    write({ mesgNum: Profile.MesgNum.FILE_ID, type: 'workout', manufacturer: 'development' });
    write({
      mesgNum: Profile.MesgNum.WORKOUT,
      sport: 'cycling',
      subSport: 'indoorCycling',
      numValidSteps: 3,
      wktName: 'SDK 3x30',
    });
    const step = (messageIndex: number, fields: Record<string, unknown>) =>
      write({ mesgNum: Profile.MesgNum.WORKOUT_STEP, messageIndex, ...fields });
    // Raw values, as the profile stores them: ms, and power with its offset of 1000 for watts.
    step(0, {
      durationType: 'time',
      durationValue: 30_000,
      targetType: 'power',
      targetValue: 0,
      customTargetValueLow: 1400,
      customTargetValueHigh: 1400,
      intensity: 'interval',
    });
    step(1, {
      durationType: 'time',
      durationValue: 30_000,
      targetType: 'power',
      targetValue: 0,
      customTargetValueLow: 60,
      customTargetValueHigh: 60,
      intensity: 'recovery',
    });
    step(2, { durationType: 'repeatUntilStepsCmplt', durationValue: 0, targetValue: 3 });
    results.set(this, importFit(encoder.close(), { fileName: 'sdk-3x30.fit' }));
  },
);

Then(
  'the FIT import gives the cycling workout {string} with the sub-sport {string}',
  function (this: object, name: string, subSport: string) {
    const imported = workout(this);
    assert.equal(imported.name, name);
    assert.equal(imported.sport, 'ride');
    assert.equal(imported.subSport, subSport);
    assert.deepEqual(imported.source, {
      kind: 'imported',
      format: 'fit',
      fileName: imported.source.fileName,
    });
  },
);

Then(
  'the FIT import gives the virtual cycling workout {string}',
  function (this: object, name: string) {
    const imported = workout(this);
    assert.equal(imported.name, name);
    assert.equal(imported.sport, 'virtual-ride');
  },
);

Then('the FIT import has the top-level steps {string}', function (this: object, ids: string) {
  assert.deepEqual(
    workout(this).steps.map((s) => s.id),
    list(ids),
  );
});

Then('the FIT step {string} is {string}', function (this: object, id: string, expected: string) {
  assert.equal(describe(step(this, id)), expected);
});

Then(
  'the FIT step {string} is named {string} with the intensity {string}',
  function (this: object, id: string, name: string, intensity: string) {
    const found = step(this, id);
    assert.equal(found.kind, 'interval');
    if (found.kind === 'interval') {
      assert.equal(found.name, name);
      assert.equal(found.intensity, intensity);
    }
  },
);

Then('the FIT step {string} has no ramp', function (this: object, id: string) {
  const found = step(this, id);
  assert.ok(found.kind === 'interval' && found.effort.kind === 'target');
  if (found.kind === 'interval' && found.effort.kind === 'target') {
    assert.equal(found.effort.primary.end, undefined);
  }
});

Then(
  'the FIT repeat {string} holds the steps {string}',
  function (this: object, id: string, ids: string) {
    const found = step(this, id);
    assert.equal(found.kind, 'repeat', `Step "${id}" is not a repeat`);
    assert.deepEqual(
      (found as WorkoutRepeat).steps.map((s) => s.id),
      list(ids),
    );
  },
);

Then(
  'the FIT step {string} keeps {string} in its FIT extensions',
  function (this: object, id: string, names: string) {
    const fields = (fitExtension(step(this, id)).fields ?? {}) as Record<string, unknown>;
    for (const name of list(names)) {
      assert.ok(name in fields, `"${name}" is not in ${JSON.stringify(fields)}`);
    }
  },
);

Then(
  'the FIT step {string} keeps the developer field {int} of developer {int} with the bytes {string}',
  function (this: object, id: string, num: number, developerDataIndex: number, bytes: string) {
    assert.deepEqual(fitExtension(step(this, id)).developerFields, [
      { developerDataIndex, num, bytes },
    ]);
  },
);

Then(
  'the FIT workout keeps the messages {string} in its FIT extensions',
  function (this: object, names: string) {
    const fit = workout(this).extensions?.fit as { messages: { num: number }[] };
    const byName: Record<string, number> = { fileId: 0 };
    assert.deepEqual(
      fit.messages.map((message) => message.num),
      list(names).map((name) => byName[name] ?? Number(name)),
    );
  },
);

Then('the FIT import warns {string}', function (this: object, code: string) {
  const imported = result(this);
  assert.ok(
    imported.diagnostics.some((d) => d.severity === 'warning' && d.code === code),
    JSON.stringify(imported.diagnostics),
  );
});

Then('the FIT import is refused with {string}', function (this: object, code: string) {
  const imported = result(this);
  assert.equal(imported.ok, false, 'The FIT import was not refused');
  assert.deepEqual(
    imported.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code),
    [code],
  );
});
