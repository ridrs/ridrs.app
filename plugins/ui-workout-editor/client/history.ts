// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Undo and redo: the workouts before and after the one shown. Edits of one field in a row (the
 * digits of a number) share a key and make one undo step.
 */
export interface History<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
  /** The field the last edit belonged to: the next edit of it replaces the present, not pushes. */
  readonly key?: string;
}

const LIMIT = 200;

export const begin = <T>(present: T): History<T> => ({ past: [], present, future: [] });

export function commit<T>(history: History<T>, next: T, key?: string): History<T> {
  if (next === history.present) return history;
  if (key !== undefined && key === history.key) return { ...history, present: next };
  return {
    past: [...history.past, history.present].slice(-LIMIT),
    present: next,
    future: [],
    ...(key === undefined ? {} : { key }),
  };
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo<T>(history: History<T>): History<T> {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}

/** Ends the run of edits of one field (a drag is over): the next edit is a step of its own. */
export const seal = <T>(history: History<T>): History<T> => {
  const { key: _key, ...rest } = history;
  return rest;
};
