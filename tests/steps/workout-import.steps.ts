// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { After, Before, type DataTable, Given, Then, When } from '@cucumber/cucumber';
import {
  type LibraryWorkout,
  trainingLibraryRemoveService,
  trainingLibrarySaveService,
  trainingLibraryState,
  type Workout,
} from '@ridrs/contracts';
import {
  importErg,
  importFit,
  importIntervalsText,
  importMrc,
  importTcx,
  importZwo,
} from '@ridrs/workout';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';
import { useRealPlugins } from './devices-and-metrics.steps.ts';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/workout-import');
const FILES = resolve(FIXTURES, 'files');
const HOST_FIXTURE = resolve(FIXTURES, 'plugins');

const fixtureBytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(resolve(FILES, name)));

const IMPORTERS = {
  zwo: importZwo,
  fit: importFit,
  erg: importErg,
  mrc: importMrc,
  tcx: importTcx,
  txt: importIntervalsText,
};

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What the last save or removal of a scenario answered. */
const answers = new WeakMap<object, { result?: unknown; error?: unknown }>();

// The test world registers the services it knows; these two belong to this feature.
Before(function (this: RidrsWorld) {
  this.serviceDefinitions.set(trainingLibrarySaveService.id, trainingLibrarySaveService);
  this.serviceDefinitions.set(trainingLibraryRemoveService.id, trainingLibraryRemoveService);
});

After(function (this: RidrsWorld) {
  answers.delete(this);
});

/** The workout of a fixture file, imported with the real importer under the given id. */
async function workoutOf(
  fileName: string,
  id: string,
): Promise<{ workout: Workout; bytes: Uint8Array; hash: string }> {
  const bytes = fixtureBytes(fileName);
  const hash = await sha256(bytes);
  const importer = IMPORTERS[fileName.split('.').pop() as keyof typeof IMPORTERS];
  const result = importer(bytes, {
    fileName,
    id,
    originalHash: hash,
    importedAt: '2026-11-11T12:00:00.000Z',
  });
  assert.ok(result.ok && result.workouts[0], `${fileName} did not import`);
  return { workout: { ...result.workouts[0], id }, bytes, hash };
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function save(
  world: RidrsWorld,
  fileName: string,
  id: string,
  originalOf = fileName,
): Promise<void> {
  const { workout } = await workoutOf(fileName, id);
  const original = fixtureBytes(originalOf);
  try {
    const result = await world.ensureHost().callService(trainingLibrarySaveService.id, {
      key: 'ridrs',
      workout,
      original: { fileName: originalOf, data: base64(original) },
    });
    answers.set(world, { result });
  } catch (error) {
    answers.set(world, { error });
  }
  await world.settle();
}

const library = (world: RidrsWorld) => {
  const entry = world.ensureHost().getState(trainingLibraryState.id).get('ridrs');
  assert.ok(entry, 'The library "ridrs" is not published');
  return entry as { writable: boolean; data?: { workouts: LibraryWorkout[] } };
};
const workouts = (world: RidrsWorld) => library(world).data?.workouts ?? [];

Given(
  'the ridrs plugins {string} running with app files',
  async function (this: RidrsWorld, csv: string) {
    this.useMemoryStorage();
    await useRealPlugins(
      this,
      csv.split(',').map((id) => id.trim()),
    );
    await this.ensureHost().start();
    await this.settle();
  },
);

When(
  'the rider saves the file {string} to the ridrs library as {string}',
  async function (this: RidrsWorld, fileName: string, id: string) {
    await save(this, fileName, id);
  },
);

When(
  'the rider saves the file {string} to the ridrs library with the original of {string}',
  async function (this: RidrsWorld, fileName: string, originalOf: string) {
    await save(this, fileName, 'mismatch', originalOf);
  },
);

Given(
  'the rider has saved the file {string} to the ridrs library as {string}',
  async function (this: RidrsWorld, fileName: string, id: string) {
    await save(this, fileName, id);
    assert.deepEqual(answers.get(this)?.result, { ok: true });
  },
);

When(
  'the rider removes the workout {string} from the ridrs library',
  async function (this: RidrsWorld, workoutId: string) {
    try {
      answers.set(this, {
        result: await this.ensureHost().callService(trainingLibraryRemoveService.id, {
          key: 'ridrs',
          workoutId,
        }),
      });
    } catch (error) {
      answers.set(this, { error });
    }
    await this.settle();
  },
);

Then('the save succeeded', function (this: RidrsWorld) {
  assert.deepEqual(answers.get(this)?.result, { ok: true }, String(answers.get(this)?.error));
});

Then('the save was refused as {string}', function (this: RidrsWorld, reason: string) {
  assert.deepEqual(answers.get(this)?.result, { ok: false, reason });
});

Then('the removal was refused as {string}', function (this: RidrsWorld, reason: string) {
  assert.deepEqual(answers.get(this)?.result, { ok: false, reason });
});

Then('the save failed with {string}', function (this: RidrsWorld, code: string) {
  assert.equal((answers.get(this)?.error as { code?: string } | undefined)?.code, code);
});

Then('the library "ridrs" is writable', function (this: RidrsWorld) {
  assert.equal(library(this).writable, true);
});

Then('the library "ridrs" holds {int} workouts', function (this: RidrsWorld, count: number) {
  assert.equal(workouts(this).length, count);
});

Then(
  'the library "ridrs" holds the workout {string} with the id {string}',
  function (this: RidrsWorld, name: string, id: string) {
    const found = workouts(this).find((workout) => workout.id === id);
    assert.ok(found, `The library has no workout with the id "${id}"`);
    assert.equal(found.name, name);
  },
);

const originalFile = (world: RidrsWorld, hash: string) =>
  world.memoryFiles?.files.get(`training/originals/${hash}`);

Then(
  'the original of {string} is kept as an app file named by its SHA-256',
  async function (this: RidrsWorld, id: string) {
    const found = workouts(this).find((workout) => workout.id === id);
    const hash = found?.workout?.source.originalHash;
    assert.ok(hash, `"${id}" names no original`);
    const kept = originalFile(this, hash);
    assert.ok(kept, 'The original is not kept');
    assert.equal(await sha256(kept), hash);
    assert.equal(hash, await sha256(fixtureBytes(found?.workout?.source.fileName ?? '')));
  },
);

Then(
  'no original is kept for the file {string}',
  async function (this: RidrsWorld, fileName: string) {
    assert.equal(originalFile(this, await sha256(fixtureBytes(fileName))), undefined);
  },
);

// --- The import screen (@ui) ---

Given(
  'the ridrs plugins {string} with the workout import fixtures',
  async function (this: RidrsWorld, csv: string) {
    this.useMemoryStorage();
    await useRealPlugins(
      this,
      csv.split(',').map((id) => id.trim()),
    );
    this.extraPluginDirs.push(HOST_FIXTURE);
  },
);

/** The screen, once the shell has mounted it. */
const shown = (world: RidrsWorld) => waitFor(() => screen(world));

const screen = (world: RidrsWorld) => {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return within(view.root).getByTestId('workout-import');
};

const rowElements = (world: RidrsWorld) => [
  ...screen(world).querySelectorAll<HTMLElement>('[data-testid="import-row"]'),
];
const field = (row: Element, name: string) =>
  (row.querySelector(`[data-field="${name}"]`)?.textContent ?? '').replace(/\s+/g, ' ').trim();
const notesOf = (row: Element) =>
  [...(row.querySelectorAll('[data-field="notes"] li') ?? [])].map((li) =>
    (li.textContent ?? '').trim(),
  );

const rowOf = (world: RidrsWorld, file: string, index = 0): HTMLElement => {
  const found = rowElements(world).filter((row) => field(row, 'file') === file);
  const row = found[index];
  assert.ok(row, `The preview has no row ${index + 1} for "${file}"`);
  return row;
};

const asFile = (name: string) => new File([fixtureBytes(name) as BlobPart], name);

/** Waits until the screen has read the files: at least one more row for each. */
async function addedRows(world: RidrsWorld, before: number, files: number, act: () => void) {
  act();
  await waitFor(() =>
    assert.ok(rowElements(world).length >= before + files, 'The files were not read'),
  );
}

When('I choose the file {string}', async function (this: RidrsWorld, name: string) {
  await shown(this);
  const input = screen(this).querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(input, 'The screen has no file input');
  await addedRows(this, rowElements(this).length, 1, () =>
    fireEvent.change(input, { target: { files: [asFile(name)] } }),
  );
});

When('I choose the files {string}', async function (this: RidrsWorld, csv: string) {
  await shown(this);
  const names = csv.split(',').map((name) => name.trim());
  const input = screen(this).querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(input, 'The screen has no file input');
  await addedRows(this, rowElements(this).length, names.length, () =>
    fireEvent.change(input, { target: { files: names.map(asFile) } }),
  );
});

When('I drop the file {string}', async function (this: RidrsWorld, name: string) {
  await shown(this);
  const zone = within(screen(this)).getByTestId('workout-import-drop');
  await addedRows(this, rowElements(this).length, 1, () =>
    fireEvent.drop(zone, { dataTransfer: { files: [asFile(name)] } }),
  );
});

When(
  'I paste the intervals.icu text of {string} as {string}',
  async function (this: RidrsWorld, file: string, name: string) {
    await shown(this);
    const root = screen(this);
    const text = root.querySelector('textarea');
    const nameInput = root.querySelector<HTMLInputElement>('input.wi-name');
    assert.ok(text && nameInput, 'The screen has no text area');
    fireEvent.change(text, { target: { value: new TextDecoder().decode(fixtureBytes(file)) } });
    fireEvent.change(nameInput, { target: { value: name } });
    const before = rowElements(this).length;
    const button = await within(root).findByRole('button', {
      name: /^(Read the text|Text lesen)$/,
    });
    await addedRows(this, before, 1, () => fireEvent.click(button));
  },
);

Then('the preview lists these workouts:', async function (this: RidrsWorld, table: DataTable) {
  await waitFor(() => {
    const shown = rowElements(this).map((row) => ({
      file: field(row, 'file'),
      name: field(row, 'name'),
      duration: field(row, 'duration'),
      state: field(row, 'state'),
    }));
    assert.deepEqual(shown, table.hashes());
  });
});

Then(
  'the preview of {string} has the state {string}',
  async function (this: RidrsWorld, file: string, state: string) {
    await waitFor(() => assert.equal(field(rowOf(this, file), 'state'), state));
  },
);

Then(
  'the preview of the second {string} has the state {string}',
  async function (this: RidrsWorld, file: string, state: string) {
    await waitFor(() => assert.equal(field(rowOf(this, file, 1), 'state'), state));
  },
);

Then(
  'the preview of {string} notes {string}',
  async function (this: RidrsWorld, file: string, note: string) {
    await waitFor(() => {
      const notes = notesOf(rowOf(this, file));
      assert.ok(
        notes.some((text) => text.includes(note)),
        `"${note}" is not among the notes: ${JSON.stringify(notes)}`,
      );
    });
  },
);

Then(
  'the preview of {string} draws a chart of {string} in the variant {string}',
  async function (this: RidrsWorld, file: string, name: string, variant: string) {
    await waitFor(() => {
      const chart = rowOf(this, file).querySelector<HTMLElement>(
        '[data-testid="fixture-workout-chart"]',
      );
      assert.ok(chart, 'The row has no chart');
      assert.equal(chart.dataset.workout, name);
      assert.equal(chart.dataset.variant, variant);
    });
  },
);

Then('the import button {string} is disabled', async function (this: RidrsWorld, label: string) {
  await waitFor(() => {
    const button = within(screen(this)).getByRole('button', { name: label }) as HTMLButtonElement;
    assert.equal(button.disabled, true);
  });
});

Then('the import says {string}', async function (this: RidrsWorld, message: string) {
  await waitFor(() =>
    assert.equal(within(screen(this)).getByTestId('workout-import-status').textContent, message),
  );
});

Then('the screen says {string}', async function (this: RidrsWorld, heading: string) {
  await waitFor(() => within(screen(this)).getByRole('heading', { level: 1, name: heading }));
});

When(
  'I choose {string} for the duplicate {string}',
  async function (this: RidrsWorld, label: string, file: string) {
    const row = rowOf(this, file);
    fireEvent.click(within(row).getByRole('radio', { name: label }));
    await this.settle();
  },
);

Then(
  'the library "ridrs" holds the workout {string} from the file {string} under an id of its file name and the start of its hash',
  async function (this: RidrsWorld, name: string, file: string) {
    const base = file.replace(/\.[^.]*$/, '');
    const expected = `${base}-${(await sha256(fixtureBytes(file))).slice(0, 8)}`;
    const found = workouts(this).find((workout) => workout.id === expected);
    assert.ok(
      found,
      `The library has no workout with the id "${expected}": ${workouts(this).map((w) => w.id)}`,
    );
    assert.equal(found.name, name);
  },
);

Then(
  'the original of the imported {string} is kept as an app file named by its SHA-256',
  async function (this: RidrsWorld, name: string) {
    const found = workouts(this).find(
      (workout) => workout.name === name && workout.workout?.source.kind === 'imported',
    );
    const hash = found?.workout?.source.originalHash;
    assert.ok(hash, `"${name}" names no original`);
    const kept = originalFile(this, hash);
    assert.ok(kept, 'The original is not kept');
    assert.equal(await sha256(kept), hash);
  },
);

Then(
  'the library "ridrs" holds two workouts named {string} with different ids',
  function (this: RidrsWorld, name: string) {
    const ids = workouts(this)
      .filter((workout) => workout.name === name)
      .map((workout) => workout.id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  },
);
