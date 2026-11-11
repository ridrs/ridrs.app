// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout } from '@ridrs/contracts';

/**
 * What every importer and exporter shares (ADR 0081): importers are pure functions
 * `(input: Uint8Array | string, options) → WorkoutImportResult`, with no clock, no randomness and
 * no I/O; the caller gives what only it knows (the file name, the time, the hash, an id).
 */

/** A note about one file: an error refuses it, a warning or a note explains it. */
export interface WorkoutDiagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  /** A stable kebab-case code, e.g. `not-cycling`, `bad-crc`, `unknown-element`. */
  readonly code: string;
  /** English, for logs and tests; the UI words it from the code. */
  readonly message: string;
  /** Where in the source, e.g. `workout/SteadyState[3]` or `line 12`. */
  readonly at?: string;
}

export type WorkoutImportResult =
  | {
      readonly ok: true;
      readonly workouts: readonly Workout[];
      readonly diagnostics: readonly WorkoutDiagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly WorkoutDiagnostic[] };

export interface WorkoutImportOptions {
  /** The id of the workout; else derived from the file name or the name, never random. */
  readonly id?: string;
  readonly fileName?: string;
  /** ISO 8601, from the caller's clock. */
  readonly importedAt?: string;
  /** The hash of the original bytes, kept as provenance. */
  readonly originalHash?: string;
  /** `imported` by default; the catalogue conversion passes `builtin`. */
  readonly sourceKind?: Workout['source']['kind'];
}

export type WorkoutImporter = (
  input: Uint8Array | string,
  options?: WorkoutImportOptions,
) => WorkoutImportResult;
