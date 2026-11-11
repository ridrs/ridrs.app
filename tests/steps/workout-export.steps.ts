// SPDX-License-Identifier: AGPL-3.0-or-later

// The exporters, headless: hand-written vectors from packages/workout/test-vectors and workouts
// written as intervals.icu text. The official Garmin FIT SDK (a devDependency of the tests only,
// ADR 0034) reads every exported FIT workout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import { Decoder, Stream } from '@garmin/fitsdk';
import type { Workout, WorkoutSourceFormat } from '@ridrs/contracts';
import {
  exportErg,
  exportFit,
  exportIntervalsText,
  exportMrc,
  exportTcx,
  exportZwo,
  importErg,
  importFit,
  importIntervalsText,
  importMrc,
  importTcx,
  importZwo,
  type WorkoutDiagnostic,
  type WorkoutExport,
} from '@ridrs/workout';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { fixtureFilesSave } from '../fixtures/plugins/workout-export/fixture-files-save/index.ts';
import type { RidrsWorld } from '../support/world.ts';
import { useRealPlugins } from './devices-and-metrics.steps.ts';

const VECTORS = resolve(import.meta.dirname, '../../packages/workout/test-vectors');

interface Scenario {
  workout?: Workout;
  /** The test vector's bytes, when the workout came from one. */
  source?: Buffer;
  fileName?: string;
  format?: WorkoutSourceFormat;
  result?: WorkoutExport<string | Uint8Array>;
}

const scenarios = new WeakMap<object, Scenario>();
const scenario = (world: object): Scenario => {
  let current = scenarios.get(world);
  if (!current) {
    current = {};
    scenarios.set(world, current);
  }
  return current;
};

const IMPORTERS = {
  zwo: importZwo,
  erg: importErg,
  mrc: importMrc,
  tcx: importTcx,
  intervals: importIntervalsText,
  fit: importFit,
} as const;

const EXTENSIONS: Record<string, WorkoutSourceFormat> = {
  zwo: 'zwo',
  erg: 'erg',
  mrc: 'mrc',
  tcx: 'tcx',
  txt: 'intervals',
  fit: 'fit',
};

const exportTo = (
  workout: Workout,
  format: WorkoutSourceFormat,
  ftp: number | undefined,
): WorkoutExport<string | Uint8Array> => {
  const options = ftp === undefined ? {} : { ftp };
  switch (format) {
    case 'zwo':
      return exportZwo(workout, options);
    case 'erg':
      return exportErg(workout, options);
    case 'mrc':
      return exportMrc(workout, options);
    case 'tcx':
      return exportTcx(workout, options);
    case 'fit':
      return exportFit(workout, options);
    case 'intervals': {
      const { text, diagnostics } = exportIntervalsText(workout);
      return { ok: true, data: text, diagnostics };
    }
  }
};

Given('the test vector {string} is imported', function (this: object, path: string) {
  const [folder = '', file = ''] = path.split('/');
  const bytes = readFileSync(resolve(VECTORS, folder, file));
  const format = EXTENSIONS[file.slice(file.lastIndexOf('.') + 1)];
  assert.ok(format, `no format for ${file}`);
  const result = (
    IMPORTERS[format] as (b: Uint8Array, o: { fileName: string }) => ReturnType<typeof importZwo>
  )(new Uint8Array(bytes), { fileName: file });
  assert.ok(result.ok, `the import was refused: ${JSON.stringify(result.diagnostics)}`);
  Object.assign(scenario(this), { workout: result.workouts[0], source: bytes, fileName: file });
});

Given('the workout from the intervals.icu text:', function (this: object, text: string) {
  const result = importIntervalsText(text, { id: 'w', fileName: 'w.txt' });
  assert.ok(result.ok, `the import was refused: ${JSON.stringify(result.diagnostics)}`);
  scenario(this).workout = result.workouts[0];
});

When('the workout is exported to {word}', function (this: object, format: WorkoutSourceFormat) {
  const current = scenario(this);
  assert.ok(current.workout, 'no workout was given');
  current.format = format;
  current.result = exportTo(current.workout, format, undefined);
});

When(
  'the workout is exported to {word} with an FTP of {int} W',
  function (this: object, format: WorkoutSourceFormat, ftp: number) {
    const current = scenario(this);
    assert.ok(current.workout, 'no workout was given');
    current.format = format;
    current.result = exportTo(current.workout, format, ftp);
  },
);

const exported = (world: object) => {
  const { result } = scenario(world);
  assert.ok(result, 'nothing was exported');
  return result;
};

const exportedText = (world: object): string => {
  const result = exported(world);
  assert.ok(result.ok, `the export was refused: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(typeof result.data, 'string', 'the export is not text');
  return result.data as string;
};

Then('the workout export succeeds', function (this: object) {
  const result = exported(this);
  assert.ok(result.ok, `the export was refused: ${JSON.stringify(result.diagnostics)}`);
});

Then('the workout export is refused with the code {string}', function (this: object, code: string) {
  const result = exported(this);
  assert.ok(!result.ok, 'the export succeeded');
  assert.ok(
    result.diagnostics.some((d: WorkoutDiagnostic) => d.severity === 'error' && d.code === code),
  );
});

Then('the workout export refusal says why', function (this: object) {
  const error = exported(this).diagnostics.find((d) => d.severity === 'error');
  assert.ok(error && /needs an FTP/.test(error.message), `no reason in ${JSON.stringify(error)}`);
});

Then('the workout export warns {string}', function (this: object, code: string) {
  const warnings = exported(this).diagnostics;
  assert.ok(
    warnings.some((d) => d.severity === 'warning' && d.code === code),
    `no warning "${code}" in ${JSON.stringify(warnings.map((d) => d.code))}`,
  );
});

Then('the workout export text contains {string}', function (this: object, part: string) {
  const text = exportedText(this);
  assert.ok(text.includes(part.replaceAll('<TAB>', '\t')), `the text lacks "${part}":\n${text}`);
});

Then('the workout export text is the text of the test vector', function (this: object) {
  const { source } = scenario(this);
  assert.ok(source);
  assert.equal(exportedText(this), `${source.toString('utf8').trimEnd()}\n`);
});

/** Without what an export of a file cannot keep: nothing but the id of a multi-workout file. */
const comparable = (workout: Workout) => {
  const { id: _id, ...rest } = workout;
  return JSON.parse(JSON.stringify(rest));
};

Then('importing the workout export again gives the same workout', function (this: object) {
  const current = scenario(this);
  const result = exported(this);
  assert.ok(result.ok && current.workout && current.format && current.fileName);
  const again = (
    IMPORTERS[current.format] as (
      d: string | Uint8Array,
      o: { fileName: string },
    ) => ReturnType<typeof importZwo>
  )(result.data, { fileName: current.fileName });
  assert.ok(again.ok, `the export was not imported: ${JSON.stringify(again.diagnostics)}`);
  const [workout] = again.workouts;
  assert.ok(workout);
  assert.deepEqual(comparable(workout), comparable(current.workout));
});

Then(
  'the official FIT SDK decodes the workout export without errors and with {int} steps',
  function (this: object, steps: number) {
    const result = exported(this);
    assert.ok(result.ok && result.data instanceof Uint8Array);
    const stream = Stream.fromByteArray([...result.data]);
    assert.ok(Decoder.isFIT(stream));
    const decoder = new Decoder(stream);
    assert.ok(decoder.checkIntegrity());
    const { messages, errors } = decoder.read();
    assert.deepEqual(errors, []);
    assert.equal(messages.fileIdMesgs?.[0]?.type, 'workout');
    assert.equal(messages.workoutStepMesgs?.length, steps);
  },
);

// ---- The export screen (`ui.workout-export`), with the fixtures of tests/fixtures/plugins/workout-export.

const EXPORT_FIXTURES = resolve(import.meta.dirname, '../fixtures/plugins/workout-export');

const screen = (world: RidrsWorld): HTMLElement => {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return within(view.root).getByTestId('workout-export');
};
const plain = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

Given(
  'the ridrs plugins {string} with the workout export fixtures',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await useRealPlugins(
      this,
      pluginsCsv.split(',').map((id) => id.trim()),
    );
    this.extraPluginDirs.push(EXPORT_FIXTURES);
    const record = fixtureFilesSave();
    record.requests.length = 0;
    record.answer = true;
  },
);

Given('the rider cancels the save dialog', () => {
  fixtureFilesSave().answer = false;
});

Then(
  'the workout export offers the formats {string}',
  async function (this: RidrsWorld, formats: string) {
    await waitFor(() => {
      const shown = [
        ...screen(this).querySelectorAll('[data-testid="workout-export-formats"] label'),
      ].map((label) => plain(label.textContent));
      assert.deepEqual(shown, formats.split(', '));
    });
  },
);

When(
  'I choose the workout export format {string}',
  async function (this: RidrsWorld, name: string) {
    const label = await waitFor(() => {
      const found = [...screen(this).querySelectorAll('label')].find(
        (l) => plain(l.textContent) === name,
      );
      assert.ok(found, `no format "${name}"`);
      return found;
    });
    fireEvent.click(label.querySelector('input') as HTMLInputElement);
    await this.settle();
  },
);

const warnings = (world: RidrsWorld): string[] =>
  [...screen(world).querySelectorAll('[data-testid="workout-export-warnings"] li')].map((li) =>
    plain(li.childNodes[0]?.textContent),
  );

Then('the workout export shows no warnings', async function (this: RidrsWorld) {
  await waitFor(() => {
    within(screen(this)).getByTestId('workout-export-clean');
    assert.deepEqual(warnings(this), []);
  });
});

Then('the workout export screen warns {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() =>
    assert.ok(warnings(this).includes(text), `warnings: ${JSON.stringify(warnings(this))}`),
  );
});

Then('the workout export names the file {string}', async function (this: RidrsWorld, name: string) {
  await waitFor(() =>
    assert.equal(plain(within(screen(this)).getByTestId('workout-export-file').textContent), name),
  );
});

Then(
  'the workout export is refused and says {string}',
  async function (this: RidrsWorld, text: string) {
    await waitFor(() => {
      const refusal = within(screen(this)).getByTestId('workout-export-refused');
      assert.ok(plain(refusal.textContent).includes(text));
      assert.ok(/needs your FTP/.test(plain(refusal.textContent)), 'the reason is not given');
    });
  },
);

const saveButton = (world: RidrsWorld) =>
  within(screen(world)).getByTestId('workout-export-save') as HTMLButtonElement;

Then('the workout export cannot be saved', async function (this: RidrsWorld) {
  await waitFor(() => assert.equal(saveButton(this).disabled, true));
});

Then('the workout export can be saved', async function (this: RidrsWorld) {
  await waitFor(() => assert.equal(saveButton(this).disabled, false));
});

When('I save the workout export', async function (this: RidrsWorld) {
  const button = await waitFor(() => saveButton(this));
  fireEvent.click(button);
  await this.settle();
});

Then(
  'files.save was asked to save {string} as {string} with a file starting with {string}',
  async function (this: RidrsWorld, fileName: string, mediaType: string, start: string) {
    await waitFor(() => assert.equal(fixtureFilesSave().requests.length, 1));
    const [request] = fixtureFilesSave().requests;
    assert.equal(request?.fileName, fileName);
    assert.equal(request?.mediaType, mediaType);
    assert.ok(
      Buffer.from(request?.data ?? '', 'base64')
        .toString('utf8')
        .startsWith(start),
    );
  },
);

Then('files.save was not asked to save anything', () => {
  assert.equal(fixtureFilesSave().requests.length, 0);
});

Then('the workout export reports {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() =>
    assert.equal(
      plain(within(screen(this)).getByTestId('workout-export-status').textContent),
      text,
    ),
  );
});
