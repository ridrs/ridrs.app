// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  athleteProfileState,
  dataSourceState,
  trainingCalendarState,
  trainingLibraryState,
  type UiCapabilityInput,
  type Workout,
  type WorkoutDetailsSubject,
  type WorkoutStep,
  workoutChartCapability,
  workoutDetailsCapability,
  workoutEditorCapability,
} from '@ridrs/contracts';
import type { UiCapabilityComponent, UiCapabilityHandle, UiContext } from '@ridrs/ui-sdk';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { defaultPowerZones, type WorkoutAthlete, workoutMetrics } from '@ridrs/workout';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  chartFallbackText,
  dayText,
  effortText,
  numbersOf,
  repeatText,
  stepDurationText,
  stepMarks,
  stepName,
  zoneRowsOf,
} from './format.ts';
import { type Messages, messages } from './i18n/index.ts';
import { chosenAthlete, type EditRef, editRef, type Library, shownWorkout } from './subject.ts';
import { DetailsStyles } from './theme.tsx';

type ChartInput = UiCapabilityInput<typeof workoutChartCapability>;

/**
 * The chart through `ui.workout-chart` (ADR 0083), variant `full`. Its container belongs to the
 * shell while the provider draws, so React never renders into it; the fallback is a sibling,
 * shown while no provider is there.
 */
function Chart({
  ctx,
  input,
  fallback,
  onStep,
  text,
}: {
  readonly ctx: UiContext;
  readonly input: ChartInput;
  readonly fallback: string;
  readonly onStep: (stepId: string) => void;
  readonly text: Messages;
}) {
  const place = useRef<HTMLDivElement>(null);
  const handle = useRef<UiCapabilityHandle<typeof workoutChartCapability>>(undefined);
  const drawn = useRef(input);
  const latestStep = useRef(onStep);
  latestStep.current = onStep;
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const element = place.current;
    if (!element) return undefined;
    const chart = ctx.render(workoutChartCapability, element, drawn.current);
    handle.current = chart;
    const stops = [
      chart.onAvailability(setAvailable),
      chart.on('step-focused', ({ stepId }) => latestStep.current(stepId)),
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
    <section className="wd-chart" aria-label={text.chart}>
      <div ref={place} data-testid="workout-details-chart" data-available={String(available)} />
      {available ? null : (
        <p className="wd-fallback" data-testid="workout-details-fallback">
          {fallback}
        </p>
      )}
    </section>
  );
}

type EditorSubject = UiCapabilityInput<typeof workoutEditorCapability>;

/**
 * The editor through `ui.workout-editor` (ADR 0083), in place of the details. Its container
 * belongs to the shell while the provider draws; without a provider there is nothing to show but a
 * way back.
 */
function EditorPlace({
  ctx,
  subject,
  onSaved,
  onClosed,
  text,
}: {
  readonly ctx: UiContext;
  readonly subject: EditorSubject;
  readonly onSaved: (workoutId: string) => void;
  readonly onClosed: () => void;
  readonly text: Messages;
}) {
  const place = useRef<HTMLDivElement>(null);
  const latest = useRef({ onSaved, onClosed });
  latest.current = { onSaved, onClosed };
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    const element = place.current;
    if (!element) return undefined;
    const editor = ctx.render(workoutEditorCapability, element, subject);
    const stops = [
      editor.onAvailability(setAvailable),
      editor.on('saved', ({ workoutId }) => latest.current.onSaved(workoutId)),
      editor.on('closed', () => latest.current.onClosed()),
    ];
    return () => {
      for (const stop of stops) stop();
      editor.release();
    };
  }, [ctx, subject]);
  return (
    <>
      <div ref={place} data-testid="workout-details-editor" />
      {available ? null : (
        <p className="wd-fallback">
          {text.editorMissing}{' '}
          <button type="button" className="wd-back" onClick={onClosed}>
            {text.back}
          </button>
        </p>
      )}
    </>
  );
}

/**
 * The steps as the workout states them, repeats with their inner steps below them. Each interval
 * is a button: the arrows move through them (AGENTS.md rule 12), and the focused one is the step
 * the chart shows as selected. The selected one is marked `aria-current`.
 */
function StepList({
  steps,
  athlete,
  selected,
  onSelect,
  text,
}: {
  readonly steps: readonly WorkoutStep[];
  readonly athlete: WorkoutAthlete;
  readonly selected: string | undefined;
  readonly onSelect: (stepId: string) => void;
  readonly text: Messages;
}) {
  const rows: React.ReactNode[] = [];
  const add = (list: readonly WorkoutStep[], depth: number) => {
    for (const step of list) {
      if (step.kind === 'repeat') {
        rows.push(
          <li
            key={`repeat-${step.id}`}
            data-testid="workout-details-step"
            className="wd-repeat"
            style={{ paddingLeft: `${depth * 20}px` }}
          >
            <span data-field="step">{repeatText(step, text)}</span>
            <span data-field="duration" />
            <span data-field="target" />
            <span data-field="mark" />
          </li>,
        );
        add(step.steps, depth + 1);
        continue;
      }
      const marks = stepMarks(step);
      rows.push(
        <li key={step.id} data-testid="workout-details-step" style={{ paddingLeft: `${depth * 20}px` }}>
          <button
            type="button"
            className="wd-step"
            data-step={step.id}
            aria-current={selected === step.id ? 'step' : undefined}
            onFocus={() => onSelect(step.id)}
            onClick={() => onSelect(step.id)}
          >
            <span data-field="step" className="wd-step-name">
              {stepName(step, text)}
            </span>
            <span data-field="duration">{stepDurationText(step.duration, text)}</span>
            <span data-field="target">{effortText(step.effort, athlete, text)}</span>
            <span data-field="mark">
              {marks.length > 0 ? (
                <span className="wd-mark" data-mark={marks.join(' ')}>
                  {marks.map((mark) => text.marks[mark]).join(' · ')}
                </span>
              ) : null}
            </span>
          </button>
        </li>,
      );
    }
  };
  add(steps, 0);
  return (
    <ol className="wd-steps" data-testid="workout-details-steps">
      {rows}
    </ol>
  );
}

/** Label and value pairs as a description list. */
function Pairs({ testId, pairs }: { readonly testId: string; readonly pairs: [string, string][] }) {
  return (
    <dl className="wd-pairs" data-testid={testId}>
      {pairs.map(([label, value]) => (
        <div key={label}>
          <dt className="wd-label">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Details({
  ctx,
  workout,
  plannedFor,
  athlete,
  text,
  edit,
}: {
  readonly edit?: ReactNode;
  readonly ctx: UiContext;
  readonly workout: Workout;
  readonly plannedFor: string | undefined;
  readonly athlete: WorkoutAthlete;
  readonly text: Messages;
}) {
  const [selected, setSelected] = useState<string>();
  const metrics = useMemo(() => workoutMetrics(workout, athlete), [workout, athlete]);
  const chartInput = useMemo<ChartInput>(
    () => ({
      workout,
      athlete,
      variant: 'full',
      ...(selected === undefined ? {} : { selectedStep: selected }),
    }),
    [workout, athlete, selected],
  );
  const list = useRef<HTMLDivElement>(null);
  // A step focused in the chart selects its row and brings it into view; the focus stays there.
  const fromChart = (stepId: string) => {
    setSelected(stepId);
    const rows = list.current?.querySelectorAll<HTMLElement>('[data-step]') ?? [];
    [...rows].find((row) => row.dataset.step === stepId)?.scrollIntoView?.({ block: 'nearest' });
  };
  const zones = zoneRowsOf(metrics, athlete.powerZones ?? defaultPowerZones(), text);
  const byline = [workout.author ? text.by(workout.author) : undefined, workout.license]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <header className="wd-head">
        {plannedFor ? <span className="wd-eyebrow">{text.plannedFor(dayText(plannedFor, text))}</span> : null}
        <h1 className="wd-title">{workout.name}</h1>
        {byline ? <span className="wd-byline">{byline}</span> : null}
        {edit}
      </header>
      {workout.description ? <p className="wd-description">{workout.description}</p> : null}
      <section aria-label={text.numbers}>
        <Pairs testId="workout-details-numbers" pairs={numbersOf(metrics, text)} />
        {metrics.durationEstimated || metrics.intensityEstimated ? (
          <p className="wd-hint">{text.estimated}</p>
        ) : null}
      </section>
      <Chart
        ctx={ctx}
        input={chartInput}
        fallback={chartFallbackText(metrics, text)}
        onStep={fromChart}
        text={text}
      />
      <section aria-labelledby="wd-steps-heading">
        <h2 id="wd-steps-heading">{text.steps}</h2>
        <div ref={list}>
          <StepList steps={workout.steps} athlete={athlete} selected={selected} onSelect={setSelected} text={text} />
        </div>
      </section>
      <section aria-labelledby="wd-zones-heading">
        <h2 id="wd-zones-heading">{text.timeInZones}</h2>
        {zones ? <Pairs testId="workout-details-zones" pairs={zones} /> : <p className="wd-hint">{text.zonesNeedFtp}</p>}
      </section>
    </>
  );
}

/**
 * The details of the subject. Back (the key or the button) reports `back`; the consumer closes
 * the details. The Back button takes the focus when they open, so the arrows start at the top.
 */
function DetailsView({
  ctx,
  subject,
  onBack,
}: {
  readonly ctx: UiContext;
  readonly subject: WorkoutDetailsSubject;
  readonly onBack: () => void;
}) {
  const text = useMessages(ctx, messages);
  const libraries = useStateEntries(ctx, trainingLibraryState) as ReadonlyMap<string, Library>;
  const calendars = useStateEntries(ctx, trainingCalendarState);
  const profiles = useStateEntries(ctx, athleteProfileState);
  const choices = useStateEntries(ctx, dataSourceState);
  // "Edit" opens the editor in place of the details; once it has saved, the details show the saved workout.
  const [editing, setEditing] = useState<EditorSubject>();
  const [saved, setSaved] = useState<{ readonly of: string; readonly subject: WorkoutDetailsSubject }>();
  const subjectKey = JSON.stringify(subject);
  const current = saved?.of === subjectKey ? saved.subject : subject;
  const shown = useMemo(() => shownWorkout(current, libraries, calendars), [current, libraries, calendars]);
  const ref = useMemo(() => editRef(current, libraries, calendars), [current, libraries, calendars]);
  const athlete = useMemo(() => chosenAthlete(profiles, choices), [profiles, choices]);
  const back = useRef<HTMLButtonElement>(null);
  const latestBack = useRef(onBack);
  latestBack.current = onBack;

  useEffect(() => ctx.onBack(() => latestBack.current()), [ctx]);
  useEffect(() => back.current?.focus(), []);

  const closeEditor = () => {
    setEditing(undefined);
    queueMicrotask(() => back.current?.focus());
  };
  const startEdit = (from: EditRef) =>
    setEditing({ kind: from.own ? 'edit' : 'copy', from: from.from, workoutId: from.workoutId });

  const name = shown.state === 'shown' ? shown.workout.name : '';
  if (editing) {
    return (
      <article className="wd-page" data-testid="workout-details-editing" aria-label={text.details(name)}>
        <DetailsStyles />
        <EditorPlace
          ctx={ctx}
          subject={editing}
          text={text}
          onClosed={closeEditor}
          onSaved={(workoutId) => {
            setSaved({ of: subjectKey, subject: { kind: 'library', from: 'ridrs', workoutId } });
            closeEditor();
          }}
        />
      </article>
    );
  }
  return (
    <article className="wd-page" data-testid="workout-details" aria-label={text.details(name)}>
      <DetailsStyles />
      <button ref={back} type="button" className="wd-back" onClick={() => latestBack.current()}>
        {text.back}
      </button>
      {shown.state === 'shown' ? (
        <Details
          ctx={ctx}
          workout={shown.workout}
          plannedFor={shown.plannedFor}
          athlete={athlete}
          text={text}
          edit={
            ref ? (
              <button
                type="button"
                className="wd-back"
                data-testid="workout-details-edit"
                onClick={() => startEdit(ref)}
              >
                {ref.own ? text.edit : text.editAsCopy}
              </button>
            ) : undefined
          }
        />
      ) : (
        <p className="wd-hint">{shown.state === 'loading' ? text.loading : text.missing}</p>
      )}
    </article>
  );
}

/** Provides `ui.workout-details`: one React root per drawing, new input without a new mount. */
export const WorkoutDetails: UiCapabilityComponent<typeof workoutDetailsCapability> = (
  container,
  ctx,
  input,
  emit,
) => {
  const root = createRoot(container);
  const onBack = () => emit('back', {});
  const draw = (subject: WorkoutDetailsSubject) =>
    root.render(<DetailsView ctx={ctx} subject={subject} onBack={onBack} />);
  draw(input);
  return { update: draw, release: () => root.unmount() };
};
