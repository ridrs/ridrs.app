// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Workout,
  WorkoutInterval,
  WorkoutRepeat,
  WorkoutStep,
  WorkoutTarget,
  WorkoutTargetUnit,
} from '@ridrs/contracts';

/**
 * The editor's workout model: pure functions from a workout to a changed copy (headless first),
 * so that undo is a stack of workouts. New ids are `n1`, `n2`, …: the next one above those in use,
 * so the same edits give the same ids.
 */

export const NEW_STEP_KINDS = [
  'warm-up',
  'steady',
  'ramp',
  'range',
  'cool-down',
  'free-ride',
  'max-effort',
  'interval-block',
] as const;
export type NewStepKind = (typeof NEW_STEP_KINDS)[number];

export const EDITABLE_UNITS = ['percent-ftp', 'watts', 'power-zone'] as const;
export type EditableUnit = (typeof EDITABLE_UNITS)[number];

export function blankWorkout(id = 'new'): Workout {
  return {
    format: 'ridrs-workout',
    version: 1,
    id,
    name: '',
    sport: 'virtual-ride',
    source: { kind: 'user' },
    steps: [],
  };
}

const eachStep = (steps: readonly WorkoutStep[], visit: (step: WorkoutStep) => void) => {
  for (const step of steps) {
    visit(step);
    if (step.kind === 'repeat') eachStep(step.steps, visit);
  }
};

/** The next free ids `n<k>`, above every `n<k>` in use. */
export function idMaker(workout: Workout): () => string {
  let top = 0;
  eachStep(workout.steps, (step) => {
    const found = /^n(\d+)$/.exec(step.id);
    if (found) top = Math.max(top, Number(found[1]));
  });
  return () => `n${++top}`;
}

const time = (seconds: number) => ({ kind: 'time', seconds }) as const;
const percent = (low: number, high = low, end?: number): WorkoutTarget => ({
  unit: 'percent-ftp',
  start: { low, high },
  ...(end === undefined ? {} : { end: { low: end, high: end } }),
});
const interval = (
  id: string,
  seconds: number,
  primary: WorkoutTarget,
  intensity?: WorkoutInterval['intensity'],
): WorkoutInterval => ({
  kind: 'interval',
  id,
  ...(intensity ? { intensity } : {}),
  duration: time(seconds),
  effort: { kind: 'target', primary },
});

/** A new step of the kind, with values to start from. */
export function createStep(kind: NewStepKind, newId: () => string): WorkoutStep {
  switch (kind) {
    case 'warm-up':
      return interval(newId(), 600, percent(50, 50, 75), 'warm-up');
    case 'steady':
      return interval(newId(), 300, percent(75));
    case 'ramp':
      return interval(newId(), 300, percent(50, 50, 100));
    case 'range':
      return interval(newId(), 300, percent(85, 95));
    case 'cool-down':
      return interval(newId(), 300, percent(65, 65, 45), 'cool-down');
    case 'free-ride':
      return {
        kind: 'interval',
        id: newId(),
        duration: time(300),
        effort: { kind: 'free' },
      };
    case 'max-effort':
      return {
        kind: 'interval',
        id: newId(),
        intensity: 'interval',
        duration: time(30),
        effort: { kind: 'max-effort' },
      };
    case 'interval-block': {
      const id = newId();
      return {
        kind: 'repeat',
        id,
        until: { kind: 'count', reps: 3 },
        steps: [
          interval(newId(), 240, percent(100), 'interval'),
          interval(newId(), 120, percent(50), 'recovery'),
        ],
      };
    }
  }
}

/** Where a step sits: the list that holds it (the repeat's id, none for the top) and its index. */
export function locate(
  workout: Workout,
  id: string,
): { parent: string | undefined; index: number } | undefined {
  const search = (
    steps: readonly WorkoutStep[],
    parent: string | undefined,
  ): { parent: string | undefined; index: number } | undefined => {
    for (const [index, step] of steps.entries()) {
      if (step.id === id) return { parent, index };
      if (step.kind === 'repeat') {
        const inner = search(step.steps, step.id);
        if (inner) return inner;
      }
    }
    return undefined;
  };
  return search(workout.steps, undefined);
}

export function findStep(steps: readonly WorkoutStep[], id: string): WorkoutStep | undefined {
  let found: WorkoutStep | undefined;
  eachStep(steps, (step) => {
    if (step.id === id) found = step;
  });
  return found;
}

/** Rebuilds the lists of steps with `change` applied to the list with this parent id. */
function editList(
  steps: readonly WorkoutStep[],
  parent: string | undefined,
  at: string | undefined,
  change: (list: readonly WorkoutStep[]) => readonly WorkoutStep[],
): readonly WorkoutStep[] {
  if (parent === at) return change(steps);
  return steps.map((step) =>
    step.kind === 'repeat' ? { ...step, steps: editList(step.steps, parent, step.id, change) } : step,
  );
}

const withSteps = (workout: Workout, steps: readonly WorkoutStep[]): Workout => ({ ...workout, steps: [...steps] });

/** Replaces one step by what `change` makes of it. */
export function mapStep(
  workout: Workout,
  id: string,
  change: (step: WorkoutStep) => WorkoutStep,
): Workout {
  const map = (steps: readonly WorkoutStep[]): WorkoutStep[] =>
    steps.map((step) =>
      step.id === id ? change(step) : step.kind === 'repeat' ? { ...step, steps: map(step.steps) } : step,
    );
  return withSteps(workout, map(workout.steps));
}

export function updateInterval(
  workout: Workout,
  id: string,
  change: (step: WorkoutInterval) => WorkoutInterval,
): Workout {
  return mapStep(workout, id, (step) => (step.kind === 'interval' ? change(step) : step));
}

/** Inserts a step into a list; the repeat `parent` (none: the top) at `index` (none: the end). */
export function insertStep(
  workout: Workout,
  step: WorkoutStep,
  parent?: string,
  index?: number,
): Workout {
  return withSteps(
    workout,
    editList(workout.steps, parent, undefined, (list) => {
      const at = index === undefined ? list.length : Math.min(Math.max(index, 0), list.length);
      return [...list.slice(0, at), step, ...list.slice(at)];
    }),
  );
}

/** Adds a step after the selected one, inside a selected repeat at its end, else at the end. */
export function addAfter(workout: Workout, step: WorkoutStep, selected?: string): Workout {
  const target = selected === undefined ? undefined : findStep(workout.steps, selected);
  if (!target) return insertStep(workout, step);
  if (target.kind === 'repeat') return insertStep(workout, step, target.id);
  const place = locate(workout, target.id);
  return place ? insertStep(workout, step, place.parent, place.index + 1) : insertStep(workout, step);
}

export function removeStep(workout: Workout, id: string): Workout {
  const place = locate(workout, id);
  if (!place) return workout;
  return withSteps(
    workout,
    editList(workout.steps, place.parent, undefined, (list) => list.filter((step) => step.id !== id)),
  );
}

/** The same step with fresh ids for it and every step inside. */
function renewed(step: WorkoutStep, newId: () => string): WorkoutStep {
  const id = newId();
  return step.kind === 'repeat'
    ? { ...step, id, steps: step.steps.map((inner) => renewed(inner, newId)) }
    : { ...step, id };
}

/** Copies a step right behind itself; returns the copy's id too. */
export function duplicateStep(workout: Workout, id: string): { workout: Workout; copy?: string } {
  const step = findStep(workout.steps, id);
  const place = locate(workout, id);
  if (!step || !place) return { workout };
  const copy = renewed(step, idMaker(workout));
  return { workout: insertStep(workout, copy, place.parent, place.index + 1), copy: copy.id };
}

/** Whether `id` is `of` itself or lies inside it. */
const isWithin = (workout: Workout, id: string | undefined, of: string): boolean => {
  if (id === undefined) return false;
  if (id === of) return true;
  const holder = findStep(workout.steps, of);
  return holder?.kind === 'repeat' && findStep(holder.steps, id) !== undefined;
};

/**
 * Moves a step into the list of `parent` (none: the top) before the step at `index` of that list,
 * counted as the list is now. A step never goes into itself.
 */
export function moveStep(workout: Workout, id: string, parent: string | undefined, index: number): Workout {
  const step = findStep(workout.steps, id);
  const from = locate(workout, id);
  if (!step || !from || isWithin(workout, parent, id)) return workout;
  // Taking it out shifts the later steps of the same list up by one.
  const at = from.parent === parent && from.index < index ? index - 1 : index;
  return insertStep(removeStep(workout, id), step, parent, at);
}

/** Moves a step one place up or down in its list. */
export function nudgeStep(workout: Workout, id: string, direction: -1 | 1): Workout {
  const place = locate(workout, id);
  if (!place) return workout;
  const list = place.parent === undefined ? workout.steps : (findStep(workout.steps, place.parent) as WorkoutRepeat).steps;
  const to = place.index + direction;
  if (to < 0 || to >= list.length) return workout;
  return moveStep(workout, id, place.parent, direction === 1 ? to + 1 : to);
}

/** Wraps a step in a repeat that runs it twice; returns the repeat's id. */
export function wrapInRepeat(workout: Workout, id: string): { workout: Workout; repeat?: string } {
  if (!findStep(workout.steps, id)) return { workout };
  const repeat = idMaker(workout)();
  return {
    workout: mapStep(workout, id, (step) => ({
      kind: 'repeat',
      id: repeat,
      until: { kind: 'count', reps: 2 },
      steps: [step],
    })),
    repeat,
  };
}

/** Replaces a repeat by its steps. */
export function unwrapRepeat(workout: Workout, id: string): Workout {
  const place = locate(workout, id);
  const repeat = findStep(workout.steps, id);
  if (!place || repeat?.kind !== 'repeat') return workout;
  return withSteps(
    workout,
    editList(workout.steps, place.parent, undefined, (list) => [
      ...list.slice(0, place.index),
      ...repeat.steps,
      ...list.slice(place.index + 1),
    ]),
  );
}

export function setReps(workout: Workout, id: string, typed: number): Workout {
  // A count is a whole number above 0 for the format; the limit 1–99 is the validation's.
  const reps = Math.max(1, Math.round(typed));
  return mapStep(workout, id, (step) =>
    step.kind === 'repeat' ? { ...step, until: { kind: 'count', reps } } : step,
  );
}

/** What a power target looks like in the editor: a value, a ramp from and to, or a range. */
export type PowerShape = 'steady' | 'ramp' | 'range';

export function powerTargetOf(step: WorkoutInterval): (WorkoutTarget & { unit: EditableUnit }) | undefined {
  if (step.effort.kind !== 'target') return undefined;
  const { primary } = step.effort;
  return (EDITABLE_UNITS as readonly WorkoutTargetUnit[]).includes(primary.unit)
    ? (primary as WorkoutTarget & { unit: EditableUnit })
    : undefined;
}

export function shapeOf(target: WorkoutTarget): PowerShape {
  if (target.end) return 'ramp';
  return target.start.low === target.start.high ? 'steady' : 'range';
}

export type PowerField = 'value' | 'from' | 'to' | 'low' | 'high';

/** Sets one number of the power target (a steady value, a ramp's ends or a range's bounds). */
export function setPower(step: WorkoutInterval, field: PowerField, typed: number): WorkoutInterval {
  const value = Math.max(0, typed);
  const target = powerTargetOf(step);
  if (!target || step.effort.kind !== 'target') return step;
  const next: WorkoutTarget =
    field === 'value' || field === 'from'
      ? { ...target, start: { low: value, high: value } }
      : field === 'to'
        ? { ...target, end: { low: value, high: value } }
        : { ...target, start: { ...target.start, [field]: value } };
  return { ...step, effort: { ...step.effort, primary: next } };
}

export function setSeconds(step: WorkoutInterval, seconds: number): WorkoutInterval {
  return { ...step, duration: time(seconds) };
}

/**
 * Changes the unit of the power target, keeping what it means where the FTP is known (% FTP and
 * watts), else starting from a usual value; a zone is its number.
 */
export function setUnit(step: WorkoutInterval, unit: EditableUnit, ftp?: number): WorkoutInterval {
  const target = powerTargetOf(step);
  if (!target || step.effort.kind !== 'target' || target.unit === unit) return step;
  const convert = (value: number) => {
    if (unit === 'power-zone' || target.unit === 'power-zone') return unit === 'power-zone' ? 2 : 75;
    if (!ftp) return unit === 'watts' ? 150 : 75;
    return Math.round(unit === 'watts' ? (value * ftp) / 100 : (value * 100) / ftp);
  };
  const range = (r: { low: number; high: number }) => ({ low: convert(r.low), high: convert(r.high) });
  const next: WorkoutTarget = {
    unit,
    start: range(target.start),
    ...(target.end ? { end: range(target.end) } : {}),
    ...(target.averaging ? { averaging: target.averaging } : {}),
  };
  return { ...step, effort: { ...step.effort, primary: next } };
}

/** The cadence beside the power: the first `rpm` target of the secondary ones. */
export function cadenceOf(step: WorkoutInterval): { low: number; high: number } | undefined {
  const effort = step.effort;
  if (effort.kind === 'max-effort') return undefined;
  return effort.secondary?.find((each) => each.unit === 'rpm')?.start;
}

/** Sets the cadence (`undefined` removes it); other secondary targets stay. */
export function setCadence(
  step: WorkoutInterval,
  cadence: { low: number; high: number } | undefined,
): WorkoutInterval {
  const effort = step.effort;
  if (effort.kind === 'max-effort') return step;
  const others = (effort.secondary ?? []).filter((each) => each.unit !== 'rpm');
  const secondary = cadence ? [...others, { unit: 'rpm', start: cadence } as WorkoutTarget] : others;
  const { secondary: _dropped, ...rest } = effort;
  return { ...step, effort: { ...rest, ...(secondary.length > 0 ? { secondary } : {}) } as typeof effort };
}

/** Parses "12:30", "1:05:00" or minutes ("12", "7,5") into seconds; undefined when it is none. */
export function parseDuration(input: string): number | undefined {
  const text = input.trim().replace(',', '.');
  const clock = /^(?:(\d+):)?(\d+):(\d{1,2})$/.exec(text);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 60);
  return undefined;
}

/** "12:30", "1:05:00". */
export function clockText(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** An id for a workout saved for the first time: its name as a slug, made unique among `taken`. */
export function uniqueWorkoutId(name: string, taken: ReadonlySet<string>): string {
  const slug =
    name
      .replace(/ß/g, 'ss')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workout';
  if (!taken.has(slug)) return slug;
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n += 1;
  return `${slug}-${n}`;
}

/** What the editor can change of a step: the others are shown and can be deleted. */
export function editability(step: WorkoutInterval): { duration: boolean; target: boolean } {
  return { duration: step.duration.kind === 'time', target: step.effort.kind === 'target' && powerTargetOf(step) !== undefined };
}
