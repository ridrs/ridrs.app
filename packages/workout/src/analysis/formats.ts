// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkoutImporter } from '../codec.ts';
import { importFit } from '../codecs/fit/index.ts';
import {
  importErg,
  importIntervalsText,
  importMrc,
  importTcx,
  importZwo,
} from '../codecs/text/index.ts';

export type WorkoutFileFormat = 'zwo' | 'fit' | 'erg' | 'mrc' | 'tcx' | 'intervals';

export const WORKOUT_IMPORTERS: Record<WorkoutFileFormat, WorkoutImporter> = {
  zwo: importZwo,
  fit: importFit,
  erg: importErg,
  mrc: importMrc,
  tcx: importTcx,
  intervals: importIntervalsText,
};

const BY_EXTENSION: Record<string, WorkoutFileFormat> = {
  zwo: 'zwo',
  fit: 'fit',
  erg: 'erg',
  mrc: 'mrc',
  tcx: 'tcx',
  txt: 'intervals',
  md: 'intervals',
};

const extensionOf = (fileName: string) =>
  fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();

/** A ZIP starts with "PK" and a local file header (or the end of an empty one). */
export const isZipArchive = (bytes: Uint8Array): boolean =>
  bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5);

/** A FIT file has ".FIT" at byte 8 of its 12- or 14-byte header. */
const isFit = (bytes: Uint8Array): boolean =>
  bytes.length > 11 && String.fromCharCode(...bytes.slice(8, 12)) === '.FIT';

/**
 * The format of a file: its extension decides (the importer then says what is wrong with a file
 * that does not fit it), else its content. `undefined` is a file ridrs cannot read.
 */
export function detectWorkoutFormat(
  fileName: string,
  bytes: Uint8Array,
): WorkoutFileFormat | 'zip' | undefined {
  if (isZipArchive(bytes) || extensionOf(fileName) === 'zip') return 'zip';
  const byName = BY_EXTENSION[extensionOf(fileName)];
  if (byName) return byName;
  if (isFit(bytes)) return 'fit';
  const head = new TextDecoder().decode(bytes.slice(0, 2000));
  if (/<workout_file[\s>]/.test(head)) return 'zwo';
  if (/<TrainingCenterDatabase[\s>]/.test(head)) return 'tcx';
  if (/\[COURSE HEADER\]/i.test(head)) return /MINUTES\s+PERCENT/i.test(head) ? 'mrc' : 'erg';
  return undefined;
}
