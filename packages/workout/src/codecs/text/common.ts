// SPDX-License-Identifier: AGPL-3.0-or-later

import { type Workout, type WorkoutSourceFormat, workoutSchema } from '@ridrs/contracts';
import type { WorkoutDiagnostic, WorkoutImportOptions, WorkoutImportResult } from '../../codec.ts';

/**
 * What the text importers share: decoding, diagnostics, ids and the source of a workout. Every
 * importer throws an `ImportError` for a file it must refuse and `finish`es its workouts through
 * the contract's schema, so that no importer can return a workout the schema would not accept.
 */

/** A file the importer refuses; the code is stable, the message says why. */
export class ImportError extends Error {
  readonly code: string;
  readonly at: string | undefined;
  constructor(code: string, message: string, at?: string) {
    super(message);
    this.code = code;
    this.at = at;
  }
}

/** Collects the warnings and notes of one import. */
export class Diagnostics {
  readonly list: WorkoutDiagnostic[] = [];
  warn(code: string, message: string, at?: string): void {
    this.list.push({ severity: 'warning', code, message, ...(at === undefined ? {} : { at }) });
  }
  info(code: string, message: string, at?: string): void {
    this.list.push({ severity: 'info', code, message, ...(at === undefined ? {} : { at }) });
  }
}

/** Text from bytes: the byte order mark decides UTF-8 or UTF-16; a string only loses its mark. */
export function decodeText(input: Uint8Array | string): string {
  if (typeof input === 'string') return input.replace(/^﻿/, '');
  const encoding =
    input[0] === 0xfe && input[1] === 0xff
      ? 'utf-16be'
      : input[0] === 0xff && input[1] === 0xfe
        ? 'utf-16le'
        : 'utf-8';
  // The decoder drops the byte order mark itself.
  return new TextDecoder(encoding).decode(input);
}

/** A lower-case ASCII slug, for ids derived from a name. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The file name without its folders and its last extension. */
export function baseName(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined;
  const name = fileName.slice(fileName.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
  return name || undefined;
}

/** The id of a workout: the caller's, else from the file name or the name, never random. */
export function workoutId(options: WorkoutImportOptions, name: string): string {
  return options.id ?? (slugify(baseName(options.fileName) ?? '') || slugify(name) || 'workout');
}

export function sourceOf(
  format: WorkoutSourceFormat,
  options: WorkoutImportOptions,
): Workout['source'] {
  return {
    kind: options.sourceKind ?? 'imported',
    format,
    ...(options.fileName === undefined ? {} : { fileName: options.fileName }),
    ...(options.originalHash === undefined ? {} : { originalHash: options.originalHash }),
    ...(options.importedAt === undefined ? {} : { importedAt: options.importedAt }),
  };
}

/** A decimal number as written; no `NaN`, no hex, no thousands separators. */
export function parseNumber(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** A fraction as written ("0.75") in percent (75), without the float noise of `* 100`. */
export function fractionToPercent(text: string): number | undefined {
  const trimmed = text.trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return Number(`${trimmed}e2`);
  const value = parseNumber(trimmed);
  return value === undefined ? undefined : Math.round(value * 100 * 1e9) / 1e9;
}

export function refused(error: ImportError, diagnostics: Diagnostics): WorkoutImportResult {
  return {
    ok: false,
    diagnostics: [
      ...diagnostics.list,
      {
        severity: 'error',
        code: error.code,
        message: error.message,
        ...(error.at === undefined ? {} : { at: error.at }),
      },
    ],
  };
}

/** Validates the workouts with the contract's schema and wraps them in a result. */
export function finish(
  workouts: readonly Workout[],
  diagnostics: Diagnostics,
): WorkoutImportResult {
  for (const workout of workouts) {
    const parsed = workoutSchema.safeParse(workout);
    if (!parsed.success) {
      return refused(
        new ImportError(
          'invalid-workout',
          `The imported workout "${workout.name}" does not match the workout format: ${parsed.error.message}`,
        ),
        diagnostics,
      );
    }
  }
  return { ok: true, workouts, diagnostics: diagnostics.list };
}

/** Runs an import body; an `ImportError` becomes a refusal with its reason. */
export function guarded(
  body: (diagnostics: Diagnostics) => readonly Workout[],
): WorkoutImportResult {
  const diagnostics = new Diagnostics();
  try {
    return finish(body(diagnostics), diagnostics);
  } catch (error) {
    if (error instanceof ImportError) return refused(error, diagnostics);
    throw error;
  }
}

/** Removes keys whose value is `undefined`, so that a result is plain JSON. */
export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
