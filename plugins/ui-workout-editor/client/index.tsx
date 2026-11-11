// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  athleteProfileState,
  dataSourceState,
  trainingCalendarState,
  trainingLibrarySaveService,
  trainingLibraryState,
  type UiCapabilityInput,
  type Workout,
  type WorkoutEditorSubject,
  type WorkoutInterval,
  type WorkoutStep,
  workoutChartCapability,
  workoutEditorCapability,
} from '@ridrs/contracts';
import type { UiCapabilityComponent, UiCapabilityHandle, UiContext } from '@ridrs/ui-sdk';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import {
  defaultPowerZones,
  validateWorkout,
  type WorkoutAthlete,
  type WorkoutDiagnostic,
  workoutMetrics,
} from '@ridrs/workout';
import { type DragEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Buffered, parseNumber } from './fields.tsx';
import { begin, commit, type History, redo, seal, undo } from './history.ts';
import { type Messages, messages } from './i18n/index.ts';
import {
  addAfter,
  blankWorkout,
  cadenceOf,
  clockText,
  createStep,
  duplicateStep,
  EDITABLE_UNITS,
  type EditableUnit,
  editability,
  findStep,
  idMaker,
  moveStep,
  NEW_STEP_KINDS,
  nudgeStep,
  type NewStepKind,
  type PowerField,
  parseDuration,
  powerTargetOf,
  removeStep,
  setCadence,
  setPower,
  setReps,
  setSeconds,
  setUnit,
  shapeOf,
  uniqueWorkoutId,
  unwrapRepeat,
  updateInterval,
  wrapInRepeat,
} from './model.ts';
import {
  chosenAthlete,
  type Library,
  localToday,
  OWN_LIBRARY,
  plannedDays,
  startingWorkout,
} from './source.ts';
import { EditorStyles } from './theme.tsx';

type ChartInput = UiCapabilityInput<typeof workoutChartCapability>;
type ChartHandle = UiCapabilityHandle<typeof workoutChartCapability>;
/** What `step-changed` of the chart reports. */
interface StepChanged {
  readonly stepId: string;
  readonly durationSeconds?: number;
  readonly power?: { readonly start?: number; readonly end?: number };
  readonly done: boolean;
}

const EN_DASH = '–';

function durationText(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return s > 0 ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}

/** The chart through `ui.workout-chart`, variant `edit`: its container belongs to the shell. */
function Chart({
  ctx,
  input,
  onStep,
  onChange,
  label,
}: {
  readonly ctx: UiContext;
  readonly input: ChartInput;
  readonly onStep: (stepId: string) => void;
  readonly onChange: (change: StepChanged) => void;
  readonly label: string;
}) {
  const place = useRef<HTMLDivElement>(null);
  const handle = useRef<ChartHandle>(undefined);
  const drawn = useRef(input);
  const latest = useRef({ onStep, onChange });
  latest.current = { onStep, onChange };

  useEffect(() => {
    const element = place.current;
    if (!element) return undefined;
    const chart = ctx.render(workoutChartCapability, element, drawn.current);
    handle.current = chart;
    const stops = [
      chart.on('step-focused', ({ stepId }) => latest.current.onStep(stepId)),
      chart.on('step-changed', (change) => latest.current.onChange(change)),
    ];
    return () => {
      for (const stop of stops) stop();
      chart.release();
      handle.current = undefined;
    };
  }, [ctx]);

  useEffect(() => {
    if (drawn.current === input) return;
    drawn.current = input;
    handle.current?.update(input);
  }, [input]);

  return (
    <section aria-label={label}>
      <div ref={place} data-testid="workout-editor-chart" />
    </section>
  );
}

interface Actions {
  readonly select: (id: string) => void;
  readonly edit: (change: (workout: Workout) => Workout, key?: string) => void;
  readonly add: (change: (workout: Workout) => { workout: Workout; select?: string | undefined }) => void;
}

interface Drag {
  readonly id: string | undefined;
  readonly setId: (id: string | undefined) => void;
  readonly drop: (parent: string | undefined, index: number) => void;
}

function Field({ label, children, wide }: { readonly label: string; readonly children: ReactNode; readonly wide?: boolean }) {
  return (
    <label className={wide ? 'we-field we-wide' : 'we-field'}>
      <span className="we-label">{label}</span>
      {children}
    </label>
  );
}

const cadenceShow = (value: { low: number; high: number } | undefined) =>
  value === undefined ? '' : value.low === value.high ? String(value.low) : `${value.low}-${value.high}`;
const cadenceParse = (text: string) => {
  const trimmed = text.trim();
  if (trimmed === '') return { value: undefined };
  const found = /^(\d+)\s*[-–]\s*(\d+)$/.exec(trimmed);
  if (found) return { value: { low: Number(found[1]), high: Number(found[2]) } };
  return /^\d+$/.test(trimmed) ? { value: { low: Number(trimmed), high: Number(trimmed) } } : undefined;
};

/** The name a step goes by in the list. */
const stepTitle = (step: WorkoutInterval, text: Messages) =>
  step.name ?? (step.effort.kind === 'free' ? text.freeRide : step.effort.kind === 'max-effort' ? text.maxEffort : step.intensity ? text.intensities[step.intensity] : text.step);

/** What an imported step that is not edited says: its length and its target in its own words. */
function foreignText(step: WorkoutInterval, text: Messages): string {
  const { duration, effort } = step;
  const length =
    duration.kind === 'time'
      ? durationText(duration.seconds)
      : duration.kind === 'distance'
        ? `${duration.meters / 1000} km`
        : duration.kind === 'energy'
          ? `${duration.kilocalories} kcal`
          : duration.kind === 'open'
            ? text.untilLapButton
            : text.untilCondition;
  if (effort.kind !== 'target') return length;
  const { primary } = effort;
  const range = (r: { low: number; high: number }) => (r.low === r.high ? `${r.low}` : `${r.low}–${r.high}`);
  return `${length} · ${range(primary.start)} ${primary.unit}`;
}

function IntervalRow({
  step,
  athlete,
  errors,
  actions,
  text,
}: {
  readonly step: WorkoutInterval;
  readonly athlete: WorkoutAthlete;
  readonly errors: readonly string[];
  readonly actions: Actions;
  readonly text: Messages;
}) {
  const can = editability(step);
  const target = powerTargetOf(step);
  const foreign = !can.duration || (step.effort.kind === 'target' && !target);
  const key = (field: string) => `${step.id}:${field}`;
  const change = (field: string, next: (step: WorkoutInterval) => WorkoutInterval) =>
    actions.edit((workout) => updateInterval(workout, step.id, next), key(field));
  const power = (field: PowerField, label: string, value: number) => (
    <Field label={label}>
      <Buffered
        value={value}
        show={String}
        parse={parseNumber}
        onCommit={(next) => change(`power-${field}`, (each) => setPower(each, field, next))}
        label={label}
        invalid={errors.length > 0}
        inputMode="decimal"
        data-field={`power-${field}`}
      />
    </Field>
  );
  const shape = target ? shapeOf(target) : undefined;
  return (
    <>
      <div className="we-fields">
        {foreign ? (
          <>
            <Field label={text.stepName} wide>
              <input readOnly value={stepTitle(step, text)} data-field="name" />
            </Field>
            <span data-field="foreign">{foreignText(step, text)}</span>
            <span className="we-hint">{text.keptAsImported}</span>
          </>
        ) : (
          <>
            <Field label={text.stepName} wide>
              <input
                value={step.name ?? ''}
                placeholder={stepTitle({ ...step, name: undefined } as WorkoutInterval, text)}
                data-field="name"
                onChange={(event) =>
                  change('name', (each) => {
                    const { name: _old, ...rest } = each;
                    return event.target.value === '' ? rest : { ...rest, name: event.target.value };
                  })
                }
              />
            </Field>
            <Field label={text.durationField}>
              <Buffered
                value={step.duration.kind === 'time' ? step.duration.seconds : 0}
                show={clockText}
                parse={(raw) => {
                  const seconds = parseDuration(raw);
                  return seconds === undefined ? undefined : { value: seconds };
                }}
                onCommit={(seconds) => change('duration', (each) => setSeconds(each, seconds))}
                label={text.durationField}
                invalid={errors.length > 0 && step.duration.kind === 'time' && step.duration.seconds <= 0}
                data-field="duration"
              />
            </Field>
            {target && shape ? (
              <>
                <Field label={text.unit}>
                  <select
                    value={target.unit}
                    data-field="unit"
                    onChange={(event) =>
                      actions.edit((workout) =>
                        updateInterval(workout, step.id, (each) => setUnit(each, event.target.value as EditableUnit, athlete.ftp)),
                      )
                    }
                  >
                    {EDITABLE_UNITS.map((unit) => (
                      <option key={unit} value={unit}>
                        {text.units[unit]}
                      </option>
                    ))}
                  </select>
                </Field>
                {shape === 'steady' ? power('value', text.value, target.start.low) : null}
                {shape === 'ramp' ? (
                  <>
                    {power('from', text.from, target.start.low)}
                    {power('to', text.to, (target.end ?? target.start).low)}
                  </>
                ) : null}
                {shape === 'range' ? (
                  <>
                    {power('low', text.low, target.start.low)}
                    {power('high', text.high, target.start.high)}
                  </>
                ) : null}
              </>
            ) : (
              <span data-field="effort">{step.effort.kind === 'max-effort' ? text.maxEffort : text.freeRide}</span>
            )}
            {step.effort.kind !== 'max-effort' ? (
              <Field label={text.cadence}>
                <Buffered
                  value={cadenceOf(step)}
                  show={cadenceShow}
                  parse={cadenceParse}
                  onCommit={(next) => change('cadence', (each) => setCadence(each, next))}
                  label={text.cadence}
                  placeholder={text.cadenceHint}
                  data-field="cadence"
                />
              </Field>
            ) : null}
          </>
        )}
      </div>
      {foreign ? null : (
        <Field label={text.notes}>
          <input
            value={step.notes ?? ''}
            data-field="notes"
            onChange={(event) =>
              change('notes', (each) => {
                const { notes: _old, ...rest } = each;
                return event.target.value === '' ? rest : { ...rest, notes: event.target.value };
              })
            }
          />
        </Field>
      )}
    </>
  );
}

function StepList({
  steps,
  parent,
  ...shared
}: {
  readonly steps: readonly WorkoutStep[];
  readonly parent: string | undefined;
  readonly workout: Workout;
  readonly athlete: WorkoutAthlete;
  readonly problems: ReadonlyMap<string, readonly string[]>;
  readonly selected: string | undefined;
  readonly actions: Actions;
  readonly drag: Drag;
  readonly text: Messages;
}) {
  const { problems, selected, actions, drag, text } = shared;
  const [over, setOver] = useState<string>();
  const allow = (event: DragEvent, id: string) => {
    if (drag.id === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    setOver(id);
  };
  const dropAt = (event: DragEvent, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    setOver(undefined);
    drag.drop(parent, index);
  };
  return (
    <ol className="we-steps" data-testid={parent === undefined ? 'workout-editor-steps' : 'workout-editor-block-steps'}>
      {steps.map((step, index) => {
        const errors = problems.get(step.id) ?? [];
        const last = index === steps.length - 1;
        const title = step.kind === 'repeat' ? text.block(step.until.kind === 'count' ? step.until.reps : 0) : stepTitle(step, text);
        return (
          <li
            key={step.id}
            data-testid="workout-editor-step"
            data-step-id={step.id}
            data-kind={step.kind}
            onDragOver={(event) => allow(event, step.id)}
            onDragLeave={() => setOver((was) => (was === step.id ? undefined : was))}
            onDrop={(event) => dropAt(event, index)}
          >
            <div
              className="we-row"
              data-selected={selected === step.id || undefined}
              data-over={over === step.id || undefined}
              aria-current={selected === step.id ? 'step' : undefined}
              onFocus={() => actions.select(step.id)}
              onClick={() => actions.select(step.id)}
            >
              <div className="we-fields">
                <button
                  type="button"
                  className="we-button we-grip"
                  draggable
                  data-testid="workout-editor-grip"
                  aria-label={`${text.drag}: ${title}`}
                  onDragStart={(event) => {
                    event.dataTransfer?.setData('text/plain', step.id);
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                    drag.setId(step.id);
                  }}
                  onDragEnd={() => {
                    drag.setId(undefined);
                    setOver(undefined);
                  }}
                >
                  ⠿
                </button>
                {step.kind === 'repeat' ? (
                  <>
                    <strong data-field="block">{title}</strong>
                    <Field label={text.reps}>
                      <Buffered
                        value={step.until.kind === 'count' ? step.until.reps : 0}
                        show={String}
                        parse={parseNumber}
                        onCommit={(reps) => actions.edit((each) => setReps(each, step.id, reps), `${step.id}:reps`)}
                        label={text.reps}
                        invalid={errors.length > 0}
                        inputMode="numeric"
                        data-field="reps"
                      />
                    </Field>
                  </>
                ) : null}
                <div className="we-tools">
                  <button type="button" className="we-button" aria-label={`${text.moveUp}: ${title}`} disabled={index === 0} onClick={() => actions.edit((each) => nudgeStep(each, step.id, -1))}>
                    ↑
                  </button>
                  <button type="button" className="we-button" aria-label={`${text.moveDown}: ${title}`} disabled={last} onClick={() => actions.edit((each) => nudgeStep(each, step.id, 1))}>
                    ↓
                  </button>
                  <button
                    type="button"
                    className="we-button"
                    aria-label={`${text.duplicate}: ${title}`}
                    onClick={() =>
                      actions.add((each) => {
                        const { workout: next, copy } = duplicateStep(each, step.id);
                        return { workout: next, select: copy };
                      })
                    }
                  >
                    ⧉
                  </button>
                  {step.kind === 'repeat' ? (
                    <button type="button" className="we-button" onClick={() => actions.edit((each) => unwrapRepeat(each, step.id))}>
                      {text.unwrap}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="we-button"
                      onClick={() =>
                        actions.add((each) => {
                          const { workout: next, repeat } = wrapInRepeat(each, step.id);
                          return { workout: next, select: repeat };
                        })
                      }
                    >
                      {text.wrap}
                    </button>
                  )}
                  <button type="button" className="we-button" aria-label={`${text.delete}: ${title}`} onClick={() => actions.edit((each) => removeStep(each, step.id))}>
                    ✕
                  </button>
                </div>
              </div>
              {step.kind === 'interval' ? (
                <IntervalRow step={step} athlete={shared.athlete} errors={errors} actions={actions} text={text} />
              ) : null}
              {errors.map((message) => (
                <p key={message} className="we-error" role="alert" data-testid="workout-editor-step-error">
                  {message}
                </p>
              ))}
            </div>
            {step.kind === 'repeat' ? (
              <StepList {...shared} steps={step.steps} parent={step.id} />
            ) : null}
          </li>
        );
      })}
      <li
        className="we-drop"
        data-testid="workout-editor-drop-end"
        data-parent={parent}
        aria-label={text.dropAtEnd}
        data-over={over === '@end' || undefined}
        onDragOver={(event) => allow(event, '@end')}
        onDragLeave={() => setOver((was) => (was === '@end' ? undefined : was))}
        onDrop={(event) => dropAt(event, steps.length)}
      />
    </ol>
  );
}

/** The reason of a diagnostic, in words, with the number it is about. */
function reasonOf(diagnostic: WorkoutDiagnostic, workout: Workout, text: Messages): string {
  const step = diagnostic.at === undefined ? undefined : findStep(workout.steps, diagnostic.at);
  let value = 0;
  if (diagnostic.code === 'power-out-of-range' && step?.kind === 'interval' && step.effort.kind !== 'max-effort') {
    const targets = [
      ...(step.effort.kind === 'target' ? [step.effort.primary] : []),
      ...(step.effort.secondary ?? []),
    ].filter((each) => each.unit === 'percent-ftp');
    value = Math.max(0, ...targets.flatMap((each) => [each.start.high, each.end?.high ?? 0]));
  }
  if (diagnostic.code === 'repeat-count-out-of-range' && step?.kind === 'repeat' && step.until.kind === 'count') {
    value = step.until.reps;
  }
  return text.errors[diagnostic.code]?.(value) ?? diagnostic.message;
}

const tagsShow = (tags: readonly string[]) => tags.join(', ');
const tagsParse = (text: string) => ({
  value: text
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean),
});

function Editor({
  ctx,
  subject,
  initial,
  athlete,
  text,
  onSaved,
  onClosed,
}: {
  readonly ctx: UiContext;
  readonly subject: WorkoutEditorSubject;
  readonly initial: Workout;
  readonly athlete: WorkoutAthlete;
  readonly text: Messages;
  readonly onSaved: (workoutId: string) => void;
  readonly onClosed: () => void;
}) {
  const libraries = useStateEntries(ctx, trainingLibraryState) as ReadonlyMap<string, Library>;
  const calendars = useStateEntries(ctx, trainingCalendarState);
  const [history, setHistory] = useState<History<Workout>>(() => begin(initial));
  const [selected, setSelected] = useState<string>();
  const [dragged, setDragged] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const workout = history.present;
  const dirty = history.past.length > 0;

  const edit = (change: (workout: Workout) => Workout, key?: string) =>
    setHistory((was) => commit(was, change(was.present), key));
  const actions: Actions = {
    select: setSelected,
    edit,
    add: (change) => {
      const result = change(workout);
      setHistory((was) => commit(was, change(was.present).workout));
      if (result.select) setSelected(result.select);
    },
  };
  const drag: Drag = {
    id: dragged,
    setId: setDragged,
    drop: (parent, index) => {
      if (dragged !== undefined) edit((each) => moveStep(each, dragged, parent, index));
      setDragged(undefined);
    },
  };

  // A drag of a handle in the chart: one undo step, however many changes it reports.
  const changed = (change: StepChanged) => {
    setHistory((was) => {
      const key = `chart:${change.stepId}`;
      let next = was.present;
      if (change.durationSeconds !== undefined) {
        const seconds = change.durationSeconds;
        next = updateInterval(next, change.stepId, (each) => setSeconds(each, seconds));
      }
      const { start, end } = change.power ?? {};
      if (start !== undefined) next = updateInterval(next, change.stepId, (each) => setPower(each, 'from', start));
      if (end !== undefined) next = updateInterval(next, change.stepId, (each) => setPower(each, 'to', end));
      const committed = commit(was, next, key);
      return change.done ? seal(committed) : committed;
    });
  };

  const walk = (event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const letter = event.key.toLowerCase();
    if (letter === 'z' && !event.shiftKey) setHistory(undo);
    else if ((letter === 'z' && event.shiftKey) || letter === 'y') setHistory(redo);
    else return;
    event.preventDefault();
  };

  const latestClose = useRef(onClosed);
  latestClose.current = onClosed;
  useEffect(() => ctx.onBack(() => latestClose.current()), [ctx]);

  const diagnostics = useMemo(() => validateWorkout(workout), [workout]);
  const problems = useMemo(() => {
    const byStep = new Map<string, string[]>();
    for (const diagnostic of diagnostics) {
      if (diagnostic.at === undefined) continue;
      byStep.set(diagnostic.at, [...(byStep.get(diagnostic.at) ?? []), reasonOf(diagnostic, workout, text)]);
    }
    return byStep;
  }, [diagnostics, workout, text]);
  const general = diagnostics.filter((each) => each.at === undefined).map((each) => reasonOf(each, workout, text));

  const metrics = useMemo(() => workoutMetrics(workout, athlete), [workout, athlete]);
  const zones = athlete.powerZones ?? defaultPowerZones();
  const chartInput = useMemo<ChartInput>(
    () => ({ workout: { ...workout, name: workout.name || text.titleNew }, athlete, variant: 'edit', ...(selected === undefined ? {} : { selectedStep: selected }) }),
    [workout, athlete, selected, text],
  );

  const days = subject.kind === 'edit' ? plannedDays(calendars, OWN_LIBRARY, workout.id, localToday()) : 0;

  const save = async () => {
    if (diagnostics.length > 0 || saving) return;
    const { description, declared: _declared, ...rest } = workout;
    const taken = new Set((libraries.get(OWN_LIBRARY)?.data?.workouts ?? []).map((each) => each.id));
    const name = workout.name.trim();
    const prepared: Workout = {
      ...rest,
      name,
      ...(description?.trim() ? { description } : {}),
      ...(subject.kind === 'edit' ? {} : { id: uniqueWorkoutId(name, taken) }),
      ...(dirty || subject.kind !== 'edit' ? {} : { declared: _declared }),
    };
    setSaving(true);
    setFailure(undefined);
    try {
      const result = await ctx.call(trainingLibrarySaveService, { key: OWN_LIBRARY, workout: prepared });
      if (result.ok) {
        onSaved(prepared.id);
        return;
      }
      setFailure(text.saveFailed(text.reasons[result.reason] ?? result.reason));
    } catch {
      setFailure(text.saveFailed(text.reasons.unavailable ?? ''));
    }
    setSaving(false);
  };

  const title =
    subject.kind === 'new' ? text.titleNew : subject.kind === 'edit' ? text.titleEdit(initial.name) : text.titleCopy(initial.name);
  const hasZoneTime = metrics.timeInZones !== undefined;

  return (
    <article className="we-page" data-testid="workout-editor" aria-label={title} onKeyDown={walk}>
      <EditorStyles />
      <div className="we-bar">
        <h1>{title}</h1>
        <div className="we-actions">
          <button type="button" className="we-button" data-testid="workout-editor-undo" disabled={history.past.length === 0} onClick={() => setHistory(undo)}>
            {text.undo}
          </button>
          <button type="button" className="we-button" data-testid="workout-editor-redo" disabled={history.future.length === 0} onClick={() => setHistory(redo)}>
            {text.redo}
          </button>
        </div>
      </div>

      <section aria-label={text.about} className="we-grid">
        <Field label={text.name}>
          <input
            value={workout.name}
            data-field="meta-name"
            aria-invalid={workout.name.trim() === '' ? 'true' : undefined}
            onChange={(event) => edit((each) => ({ ...each, name: event.target.value }), 'meta:name')}
          />
        </Field>
        <Field label={text.focus}>
          <select
            value={workout.focus ?? ''}
            data-field="meta-focus"
            onChange={(event) =>
              edit((each) => {
                const { focus: _old, ...rest } = each;
                return event.target.value === '' ? rest : { ...rest, focus: event.target.value as NonNullable<Workout['focus']> };
              })
            }
          >
            <option value="">{text.noFocus}</option>
            {Object.keys(text.focuses).map((focus) => (
              <option key={focus} value={focus}>
                {text.focuses[focus]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={text.tags}>
          <Buffered
            value={workout.tags ?? []}
            show={tagsShow}
            parse={tagsParse}
            onCommit={(tags) =>
              edit((each) => {
                const { tags: _old, ...rest } = each;
                return tags.length === 0 ? rest : { ...rest, tags };
              }, 'meta:tags')
            }
            label={text.tags}
            data-field="meta-tags"
          />
        </Field>
        <Field label={text.description}>
          <textarea
            rows={2}
            value={workout.description ?? ''}
            data-field="meta-description"
            onChange={(event) => edit((each) => ({ ...each, description: event.target.value }), 'meta:description')}
          />
        </Field>
      </section>

      <section aria-label={text.numbers}>
        <dl className="we-numbers" data-testid="workout-editor-numbers">
          <div>
            <dt>{text.duration}</dt>
            <dd>{`${metrics.durationEstimated ? '≈ ' : ''}${durationText(metrics.durationSeconds)}`}</dd>
          </div>
          <div>
            <dt>{text.trainingLoad}</dt>
            <dd>{metrics.trainingLoad === undefined ? EN_DASH : Math.round(metrics.trainingLoad)}</dd>
          </div>
          <div>
            <dt>{text.intensityFactor}</dt>
            <dd>
              {metrics.intensityFactor === undefined
                ? EN_DASH
                : new Intl.NumberFormat(text.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(metrics.intensityFactor)}
            </dd>
          </div>
        </dl>
        <h2>{text.timeInZones}</h2>
        {hasZoneTime ? (
          <dl className="we-numbers" data-testid="workout-editor-zones">
            {zones.map((zone, index) => {
              const seconds = metrics.timeInZones?.[index] ?? 0;
              return (
                <div key={zone.name ?? String(zone.upTo)}>
                  <dt>{`Z${index + 1}`}</dt>
                  <dd>{seconds > 0 ? durationText(seconds) : EN_DASH}</dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <p className="we-hint">{text.zonesNeedFtp}</p>
        )}
      </section>

      <Chart
        ctx={ctx}
        input={chartInput}
        label={text.chart}
        onStep={setSelected}
        onChange={changed}
      />

      <section aria-labelledby="we-add-heading">
        <h2 id="we-add-heading">{text.addStep}</h2>
        <div className="we-add">
          {NEW_STEP_KINDS.map((kind: NewStepKind) => (
            <button
              key={kind}
              type="button"
              className="we-button"
              data-testid="workout-editor-add"
              data-kind={kind}
              onClick={() =>
                actions.add((each) => {
                  const step = createStep(kind, idMaker(each));
                  return { workout: addAfter(each, step, selected), select: step.id };
                })
              }
            >
              {text.kinds[kind]}
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="we-steps-heading">
        <h2 id="we-steps-heading">{text.steps}</h2>
        {workout.steps.length === 0 ? <p className="we-hint">{text.noSteps}</p> : null}
        <StepList
          steps={workout.steps}
          parent={undefined}
          workout={workout}
          athlete={athlete}
          problems={problems}
          selected={selected}
          actions={actions}
          drag={drag}
          text={text}
        />
      </section>

      <footer className="we-foot">
        {days > 0 ? (
          <p className="we-notice" data-testid="workout-editor-notice" role="status">
            {text.plannedOn(days)}
          </p>
        ) : null}
        {general.length > 0 ? (
          <ul className="we-error" data-testid="workout-editor-problems" aria-label={text.problems}>
            {general.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
        {failure ? (
          <p className="we-error" role="alert" data-testid="workout-editor-failure">
            {failure}
          </p>
        ) : null}
        <div className="we-actions">
          <button type="button" className="we-button we-primary" data-testid="workout-editor-save" disabled={diagnostics.length > 0 || saving} onClick={save}>
            {saving ? text.saving : text.save}
          </button>
          <button type="button" className="we-button" data-testid="workout-editor-cancel" onClick={onClosed}>
            {text.cancel}
          </button>
        </div>
      </footer>
    </article>
  );
}

/** Waits for the workout to start from, then hands it to the editor once. */
function EditorView({
  ctx,
  subject,
  onSaved,
  onClosed,
}: {
  readonly ctx: UiContext;
  readonly subject: WorkoutEditorSubject;
  readonly onSaved: (workoutId: string) => void;
  readonly onClosed: () => void;
}) {
  const text = useMessages(ctx, messages);
  const libraries = useStateEntries(ctx, trainingLibraryState) as ReadonlyMap<string, Library>;
  const profiles = useStateEntries(ctx, athleteProfileState);
  const choices = useStateEntries(ctx, dataSourceState);
  const athlete = useMemo(() => chosenAthlete(profiles, choices), [profiles, choices]);
  const source = startingWorkout(subject, libraries, text.copyOf, blankWorkout());
  // The draft starts from the first answer; the library changing beneath it later changes nothing.
  const [initial, setInitial] = useState<Workout>();
  useEffect(() => {
    if (initial === undefined && source.state === 'ready') setInitial(source.workout);
  }, [initial, source]);
  const latestClose = useRef(onClosed);
  latestClose.current = onClosed;
  useEffect(() => (initial === undefined ? ctx.onBack(() => latestClose.current()) : undefined), [ctx, initial]);

  if (initial) {
    return <Editor ctx={ctx} subject={subject} initial={initial} athlete={athlete} text={text} onSaved={onSaved} onClosed={onClosed} />;
  }
  return (
    <article className="we-page" data-testid="workout-editor">
      <EditorStyles />
      <p className="we-hint">{source.state === 'missing' ? text.missing : text.loading}</p>
      <div className="we-actions">
        <button type="button" className="we-button" onClick={onClosed}>
          {text.cancel}
        </button>
      </div>
    </article>
  );
}

/** Provides `ui.workout-editor`: one React root per drawing. A new subject starts a new draft. */
export const WorkoutEditor: UiCapabilityComponent<typeof workoutEditorCapability> = (container, ctx, input, emit) => {
  // React's own element inside the container: the shell empties the container when the editor is
  // released, and React must not find its children gone from under it.
  const host = document.createElement('div');
  host.style.display = 'contents';
  container.append(host);
  const root = createRoot(host);
  const draw = (subject: WorkoutEditorSubject) =>
    root.render(
      <EditorView
        key={JSON.stringify(subject)}
        ctx={ctx}
        subject={subject}
        onSaved={(workoutId) => emit('saved', { workoutId })}
        onClosed={() => emit('closed', {})}
      />,
    );
  draw(input);
  // Released from inside a render of the consumer: unmount once that is done.
  return { update: draw, release: () => queueMicrotask(() => root.unmount()) };
};
