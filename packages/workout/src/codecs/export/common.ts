// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkoutDiagnostic } from '../../codec.ts';

/** Collects the warnings of one export: what the target format cannot express. */
export class ExportNotes {
  readonly list: WorkoutDiagnostic[] = [];

  warn(code: string, message: string, at?: string): void {
    this.list.push({ severity: 'warning', code, message, ...(at !== undefined ? { at } : {}) });
  }
}

/** A number as intervals.icu writes it: no trailing zeros, at most three decimals. */
export function num(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** The JSON object of `value`, or `undefined`. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `extensions.intervals` of a step or workout, as an object. */
export function intervalsExtension(owner: {
  readonly extensions?: Record<string, unknown>;
}): Record<string, unknown> {
  return record(owner.extensions?.intervals) ?? {};
}
