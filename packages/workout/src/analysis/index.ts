// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reading workout files for an import (ADR 0093): the format of a file, every workout of a file
 * or of a ZIP of files, and what a rider should know about each before it goes to a library. The
 * import page and the files dropped onto the window use it alike.
 */
export {
  analyseWorkoutEntry,
  analyseWorkoutFile,
  analyseWorkoutText,
  type NoErgReason,
  sha256Hex,
  type WorkoutAnalysis,
  type WorkoutNote,
  workoutNotes,
} from './analyse.ts';
export {
  detectWorkoutFormat,
  isZipArchive,
  WORKOUT_IMPORTERS,
  type WorkoutFileFormat,
} from './formats.ts';
export { chooseWorkoutId, importTime } from './ids.ts';
export { type FileEntry, unzipFiles } from './zip.ts';
