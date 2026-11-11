// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NoErgReason } from '../analyse.ts';

const noErg: Record<NoErgReason, (n: number) => string> = {
  'heart-rate': (n) => `${n} ${n === 1 ? 'step' : 'steps'} by heart rate, no ERG`,
  speed: (n) => `${n} ${n === 1 ? 'step' : 'steps'} by speed, no ERG`,
  rpe: (n) => `${n} ${n === 1 ? 'step' : 'steps'} by perceived effort, no ERG`,
  free: (n) => `${n} free-ride ${n === 1 ? 'step' : 'steps'}, no ERG`,
  'max-effort': (n) => `${n} max-effort ${n === 1 ? 'step' : 'steps'}, no ERG`,
};

/** The importers' diagnostics in plain words, by their stable codes; others show the importer's English. */
const reasons: Record<string, string> = {
  'empty-file': 'The file is empty.',
  'unknown-format': 'ridrs cannot tell which workout format this file has. It reads ZWO, FIT, ERG, MRC, TCX and intervals.icu text.',
  'bad-zip': 'The ZIP file cannot be read.',
  'empty-zip': 'The ZIP file holds no files.',
  'import-failed': 'The file could not be read.',
  'not-cycling': 'This is not a cycling workout. ridrs imports cycling workouts only.',
  'no-sport': 'The file does not say which sport it is for.',
  'missing-sport': 'The file does not say which sport it is for.',
  'invalid-xml': 'The file is damaged: it is not well-formed XML.',
  'not-zwo': 'This is not a Zwift workout file.',
  'not-tcx': 'This is not a TCX file.',
  'no-workout': 'The file holds no workout (it may be a recorded activity).',
  'not-a-workout': 'The FIT file is a recorded activity, not a workout.',
  'not-fit': 'This is not a FIT file.',
  'bad-crc': 'The file is damaged: its checksum does not match.',
  'bad-header-crc': 'The file is damaged: its header checksum does not match.',
  truncated: 'The file is cut off: part of it is missing.',
  'missing-attribute': 'A step lacks a required value, such as its duration.',
  'bad-number': 'A step has a value that is not a number.',
  'bad-point': 'A line of the course has a negative or unreadable value.',
  'points-out-of-order': 'The minutes of the course go backwards.',
  'no-course-data': 'The file has no course data: it is not an ERG or MRC file.',
  'too-few-points': 'The course needs at least two points.',
  'no-steps': 'The text holds no workout steps. A step is a line like "- 10m 75%".',
  'bad-repetitions': 'A repeat has no valid number of repetitions.',
  'invalid-workout': 'The workout does not match the workout format.',
  'name-missing': 'The workout has no name.',
  'unsupported-target': 'A target has no place in the workout format; it is kept in the file but not ridden.',
  'unmapped-target': 'A target of an unknown kind was kept but not ridden.',
  'unknown-element': 'The file has parts ridrs does not know; they are kept.',
  'unknown-intensity': 'A step has an intensity ridrs does not know; it is kept.',
  'cue-before-start': 'A text comes before the workout starts; it is kept.',
  'cue-after-end': 'A text comes after the workout ends.',
  'unit-mismatch': 'The file mixes units; they stay as written.',
  'no-column-header': 'The course has no header line; its values are read as % FTP.',
  'bad-ftp': 'The FTP in the file is not a power; it is ignored.',
  'bad-course-text': 'A line of course text could not be read; it is kept.',
  'ramp-without-range': 'A ramp has no range and is read as steady.',
  'text-line': 'A line is text, not a step; it is kept as text.',
  'several-workouts': 'The file holds several workouts.',
  'cues-kept-in-extensions': 'Texts of the workout are kept with it.',
};

export const en = {
  title: 'Import workouts',
  intro: 'Choose workout files or drop them here: ZWO, FIT, ERG, MRC, TCX, or a ZIP of them. Nothing is converted: watts stay watts, % FTP stays % FTP.',
  chooseFiles: 'Choose files',
  filesLabel: 'Workout files',
  dropHint: 'Drop files or a ZIP here',
  pasteHeading: 'Paste a workout text',
  pasteLabel: 'intervals.icu workout text',
  pasteName: 'Name of the pasted workout',
  pasteDefaultName: 'Pasted workout',
  readText: 'Read the text',
  previewHeading: 'Preview',
  nothingYet: 'Nothing chosen yet.',
  reading: 'Reading…',
  state: { ok: '✓', warning: '⚠', error: '✗' },
  stateName: { ok: 'Ready', warning: 'Note', error: 'Cannot import' },
  chartLabel: (name: string) => `Chart of ${name}`,
  duplicate: (name: string) => `Already in your library as “${name}”.`,
  skip: 'Skip',
  asCopy: 'Import as a copy',
  duplicateChoice: (file: string) => `What to do with the duplicate ${file}`,
  import: 'Import',
  clear: 'Clear',
  close: 'Close',
  willImport: (n: number) => (n === 1 ? '1 workout will be imported.' : `${n} workouts will be imported.`),
  saving: 'Saving…',
  imported: (n: number) => (n === 1 ? 'Imported 1 workout.' : `Imported ${n} workouts.`),
  importFailed: (n: number) => `${n} could not be saved.`,
  libraryRefused: 'The library on this device cannot keep workouts.',
  hours: 'h',
  minutes: 'min',
  seconds: 's',
  units: (units: readonly string[]) =>
    units
      .map((unit) =>
        unit === 'watts'
          ? 'Targets in watts, ridden in watts.'
          : unit === 'percent-ftp'
            ? 'Targets in % FTP, resolved with your FTP when the ride starts.'
            : 'Targets in power zones, resolved with your zones when the ride starts.',
      )
      .join(' '),
  noErg: (reason: NoErgReason, count: number) => `${noErg[reason](count)}.`,
  reasons,
};

export type Messages = typeof en;
