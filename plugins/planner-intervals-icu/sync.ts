// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LibraryWorkout, Workout } from '@ridrs/contracts';
// The exporters of `@ridrs/workout`; imported by path until the package's index exports them.
import { exportIntervalsDoc, exportIntervalsText } from '@ridrs/workout';

/**
 * The content of a planned workout in the calendar of intervals.icu (structured-workouts.md,
 * section 10): a workout of another library (the built-in workouts of ridrs) is created with its
 * whole content, and its entry follows the library workout until the entry is changed in
 * intervals.icu.
 *
 * **Which representation is sent is not decided yet** (an ADR after a check against the real API):
 * the intervals.icu text in the description (`description`, the default: intervals.icu builds its
 * `workout_doc` from it, as the web app does), or the `workout_doc` itself (`workout_doc`). The
 * switch is here, and only here.
 */
export const contentSync: { send: 'description' | 'workout_doc' } = { send: 'description' };

/**
 * What ridrs knows of an entry it planned from a library: the library workout, the day, and two
 * hashes. `content` is the hash of the entry as intervals.icu answered the last write: an entry
 * that hashes differently on a later read was changed in intervals.icu and loses its link.
 * `source` is the hash of the library workout that was sent: a different one means the library
 * workout changed, and the entry follows.
 *
 * The links are kept in the plugin's cache (app files), not in the event: a marker in the
 * description would show in the rider's text in intervals.icu and in every device that syncs it,
 * and could be edited away or copied with the event. Only this device follows its links; another
 * device of the rider plans its own.
 */
export interface Link {
  readonly from: string;
  readonly workoutId: string;
  readonly date: string;
  readonly mode: 'description' | 'workout_doc';
  readonly content: string;
  readonly source: string;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** JSON with the keys of every object sorted: the same content gives the same text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** FNV-1a, 32 bits, as hex: a fingerprint to compare, not a secret. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The fields of a step that intervals.icu fills in itself (`_power`, `_hr`, …) are no content. */
function ownFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(ownFields);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, inner]) => [key, ownFields(inner)]),
    );
  }
  return value;
}

/**
 * The hash of an event's content: its name and description, and with a workout document sent,
 * its steps. With the description sent, intervals.icu derives the document from it, so the
 * description alone says whether the rider changed the workout (the web app's builder writes it).
 */
export function eventHash(event: unknown, mode: Link['mode']): string {
  const body = isObject(event) ? event : {};
  const doc = isObject(body.workout_doc) ? body.workout_doc : {};
  return fingerprint(
    canonicalJson({
      name: body.name ?? null,
      description: body.description ?? null,
      ...(mode === 'workout_doc' ? { steps: ownFields(doc.steps ?? null) } : {}),
    }),
  );
}

/** The canonical workout of a library entry: its own, or one made of its steps. */
export function workoutOf(entry: LibraryWorkout): Workout {
  return (
    entry.workout ?? {
      format: 'ridrs-workout',
      version: 1,
      id: entry.id,
      name: entry.name,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      sport: entry.sport,
      source: { kind: 'provider' },
      steps: entry.steps,
    }
  );
}

/** The hash of what a library entry would send. */
export function sourceHash(entry: LibraryWorkout): string {
  const workout = workoutOf(entry);
  return fingerprint(
    canonicalJson({
      name: entry.name,
      description: entry.description ?? null,
      sport: entry.sport,
      steps: workout.steps,
      extensions: workout.extensions ?? null,
    }),
  );
}

/**
 * The fields of the event for a library entry, with its content in the chosen representation.
 * The rider's description of the workout comes first; the text follows after a blank line.
 * Without steps there is no content: the event has the name and the length only.
 */
export function eventContent(
  entry: LibraryWorkout,
  mode: Link['mode'],
  log: (diagnostics: readonly { code: string; message: string }[]) => void,
): Json {
  const workout = workoutOf(entry);
  const base = {
    name: entry.name,
    type: entry.sport === 'virtual-ride' ? 'VirtualRide' : 'Ride',
    ...(entry.durationSeconds !== undefined ? { moving_time: entry.durationSeconds } : {}),
  };
  if (workout.steps.length === 0) {
    return { ...base, ...(entry.description !== undefined ? { description: entry.description } : {}) };
  }
  if (mode === 'workout_doc') {
    const { doc, diagnostics } = exportIntervalsDoc(workout);
    log(diagnostics);
    return {
      ...base,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      workout_doc: doc,
    };
  }
  const { text, diagnostics } = exportIntervalsText(workout);
  log(diagnostics);
  return {
    ...base,
    description: entry.description !== undefined ? `${entry.description}\n\n${text}` : text,
  };
}
