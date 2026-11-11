// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  trainingLibrarySaveService,
  trainingLibraryState,
  type Workout,
  workoutChartCapability,
} from '@ridrs/contracts';
import { reactComponent, useBack } from '@ridrs/ui-preview';
import type { UiContext } from '@ridrs/ui-sdk';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { workoutMetrics } from '@ridrs/workout';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Analysis, analyseFile, analyseText, type Note } from './analyse.ts';
import { type Messages, messages } from './i18n/index.ts';
import { type DuplicateChoice, type KnownWorkout, type PlannedRow, planImport } from './plan.ts';
import { ImportStyles } from './theme.tsx';

interface Row {
  readonly key: string;
  readonly analysis: Analysis;
}

/** Bytes as base64, in chunks: `String.fromCharCode(...bytes)` would overflow the stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function durationText(seconds: number, estimated: boolean, text: Messages): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const parts =
    hours > 0
      ? [`${hours} ${text.hours}`, ...(minutes > 0 ? [`${minutes} ${text.minutes}`] : [])]
      : minutes > 0
        ? [`${minutes} ${text.minutes}`, ...(rest > 0 ? [`${rest} ${text.seconds}`] : [])]
        : [`${rest} ${text.seconds}`];
  return `${estimated ? '≈ ' : ''}${parts.join(' ')}`;
}

function noteText(note: Note, text: Messages): string {
  if (note.kind === 'units') return text.units(note.units);
  if (note.kind === 'no-erg') return text.noErg(note.reason, note.count);
  return text.reasons[note.diagnostic.code] ?? note.diagnostic.message;
}

/** The reasons of a refused file, in plain words, without repeats. */
function reasonTexts(analysis: Analysis & { kind: 'error' }, text: Messages): string[] {
  const errors = analysis.diagnostics.filter((d) => d.severity === 'error');
  const shown = errors.length > 0 ? errors : analysis.diagnostics;
  return [...new Set(shown.map((d) => text.reasons[d.code] ?? d.message))];
}

/** The small chart of `ui.workout-chart`; its container belongs to the shell while a provider draws. */
function MiniChart({ ctx, workout, label }: { readonly ctx: UiContext; readonly workout: Workout; readonly label: string }) {
  const place = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = place.current;
    if (!element) return undefined;
    const chart = ctx.render(workoutChartCapability, element, { workout, variant: 'mini' });
    return () => chart.release();
  }, [ctx, workout]);
  return <div ref={place} className="wi-chart" role="img" aria-label={label} data-testid="workout-import-chart" />;
}

function PreviewRow(props: {
  readonly ctx: UiContext;
  readonly row: PlannedRow;
  readonly onChoice: (choice: DuplicateChoice) => void;
  readonly text: Messages;
}) {
  const { analysis } = props.row;
  return analysis.kind === 'error' ? (
    <ErrorRow analysis={analysis} text={props.text} />
  ) : (
    <WorkoutRow {...props} analysis={analysis} />
  );
}

function ErrorRow({
  analysis,
  text,
}: {
  readonly analysis: Analysis & { kind: 'error' };
  readonly text: Messages;
}) {
  return (
    <li className="wi-row" data-testid="import-row" data-state="error">
      <div className="wi-chart" />
      <div className="wi-main">
        <div className="wi-head">
          <span className="wi-name-text" data-field="name">{analysis.fileName}</span>
          <span className="wi-state" data-field="state" data-state="error" title={text.stateName.error}>{text.state.error}</span>
        </div>
        <span className="wi-label" data-field="file">{analysis.fileName}</span>
        <ul className="wi-notes" data-field="notes">
          {reasonTexts(analysis, text).map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </div>
    </li>
  );
}

function WorkoutRow({
  ctx,
  row,
  analysis,
  onChoice,
  text,
}: {
  readonly ctx: UiContext;
  readonly row: PlannedRow;
  readonly analysis: Analysis & { kind: 'workout' };
  readonly onChoice: (choice: DuplicateChoice) => void;
  readonly text: Messages;
}) {
  const { workout } = analysis;
  const metrics = useMemo(() => workoutMetrics(workout), [workout]);
  const state = row.duplicateOf !== undefined ? 'warning' : analysis.state;
  const notes = [
    ...(row.duplicateOf !== undefined ? [text.duplicate(row.duplicateOf)] : []),
    ...analysis.notes.map((note) => noteText(note, text)),
  ];
  return (
    <li className="wi-row" data-testid="import-row" data-state={state} data-will-import={String(row.id !== undefined)}>
      <MiniChart ctx={ctx} workout={workout} label={text.chartLabel(workout.name)} />
      <div className="wi-main">
        <div className="wi-head">
          <span className="wi-name-text" data-field="name">{workout.name}</span>
          <span data-field="duration">{durationText(metrics.durationSeconds, metrics.durationEstimated, text)}</span>
          <span className="wi-state" data-field="state" data-state={state} title={text.stateName[state]}>{text.state[state]}</span>
        </div>
        <span className="wi-label" data-field="file">{analysis.fileName}</span>
        <ul className="wi-notes" data-field="notes">
          {[...new Set(notes)].map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        {row.duplicateOf !== undefined ? (
          <div className="wi-choice" role="radiogroup" aria-label={text.duplicateChoice(analysis.fileName)}>
            {(['skip', 'copy'] as const).map((choice) => (
              <label key={choice}>
                <input
                  type="radio"
                  name={`duplicate-${row.key}`}
                  checked={row.choice === choice}
                  onChange={() => onChoice(choice)}
                />
                {choice === 'skip' ? text.skip : text.asCopy}
              </label>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function ImportView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const libraries = useStateEntries(ctx, trainingLibraryState);
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [choices, setChoices] = useState<ReadonlyMap<string, DuplicateChoice>>(new Map());
  const [reading, setReading] = useState(0);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>();
  const [over, setOver] = useState(false);
  const [pasted, setPasted] = useState('');
  const [pastedName, setPastedName] = useState<string>();
  const counter = useRef(0);
  useBack(ctx);

  const known = useMemo<KnownWorkout[]>(
    () =>
      (libraries.get('ridrs')?.data?.workouts ?? []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        ...(entry.workout?.source.originalHash ? { originalHash: entry.workout.source.originalHash } : {}),
      })),
    [libraries],
  );
  const plan = useMemo(() => planImport(rows, known, choices), [rows, known, choices]);
  const accepted = plan.filter((row) => row.id !== undefined);

  const add = (analyses: readonly Analysis[]) => {
    setRows((current) => [
      ...current,
      ...analyses.map((analysis) => ({ key: `row-${(counter.current += 1)}`, analysis })),
    ]);
    setStatus(undefined);
  };

  const addFiles = async (files: readonly File[]) => {
    setReading((n) => n + 1);
    try {
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        add(await analyseFile({ fileName: file.name, bytes }, new Date().toISOString()));
      }
    } finally {
      setReading((n) => n - 1);
    }
  };

  const addText = async () => {
    const analyses = await analyseText(pasted, pastedName ?? text.pasteDefaultName, new Date().toISOString());
    add(analyses);
    if (analyses.some((analysis) => analysis.kind === 'workout')) setPasted('');
  };

  const importAll = async () => {
    setSaving(true);
    let saved = 0;
    let failed = 0;
    for (const row of accepted) {
      if (row.analysis.kind !== 'workout' || row.id === undefined) continue;
      const { workout, bytes, hash, fileName } = row.analysis;
      try {
        const answer = await ctx.call(trainingLibrarySaveService, {
          key: 'ridrs',
          workout: { ...workout, id: row.id, source: { ...workout.source, originalHash: hash } },
          original: { fileName, data: toBase64(bytes) },
        });
        if (answer.ok) saved += 1;
        else failed += 1;
      } catch (error) {
        ctx.logger.warn(`Could not save ${row.id}: ${String(error)}`);
        failed += 1;
      }
    }
    setSaving(false);
    setRows([]);
    setChoices(new Map());
    setStatus([text.imported(saved), failed > 0 ? text.importFailed(failed) : ''].filter(Boolean).join(' '));
  };

  return (
    <div className="wi-page" data-testid="workout-import">
      <ImportStyles />
      <h1 className="wi-title">{text.title}</h1>
      <p className="wi-muted">{text.intro}</p>

      <section
        className="wi-drop"
        data-testid="workout-import-drop"
        data-over={String(over)}
        aria-label={text.dropHint}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void addFiles([...(event.dataTransfer?.files ?? [])]);
        }}
      >
        <span>{text.dropHint}</span>
        <label className="wi-button">
          {text.chooseFiles}
          <input
            type="file"
            multiple
            className="wi-file"
            onChange={(event) => {
              const input = event.currentTarget;
              void addFiles([...(input.files ?? [])]);
              try {
                input.value = '';
              } catch {
                // Some engines refuse to reset a file input; choosing the same file again then needs a reload.
              }
            }}
          />
        </label>
      </section>

      <section className="wi-paste" aria-labelledby="wi-paste-heading">
        <h2 id="wi-paste-heading">{text.pasteHeading}</h2>
        <textarea
          className="wi-text"
          aria-label={text.pasteLabel}
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
        />
        <input
          className="wi-name"
          aria-label={text.pasteName}
          value={pastedName ?? text.pasteDefaultName}
          onChange={(event) => setPastedName(event.target.value)}
        />
        <div className="wi-actions">
          <button type="button" className="wi-button" disabled={pasted.trim() === ''} onClick={() => void addText()}>
            {text.readText}
          </button>
        </div>
      </section>

      <section aria-labelledby="wi-preview-heading">
        <h2 id="wi-preview-heading">{text.previewHeading}</h2>
        {reading > 0 ? <p className="wi-muted">{text.reading}</p> : null}
        {plan.length === 0 && reading === 0 ? <p className="wi-muted">{text.nothingYet}</p> : null}
        <ol className="wi-rows" data-testid="workout-import-rows">
          {plan.map((row) => (
            <PreviewRow
              key={row.key}
              ctx={ctx}
              row={row}
              text={text}
              onChoice={(choice) => setChoices((current) => new Map(current).set(row.key, choice))}
            />
          ))}
        </ol>
      </section>

      <div className="wi-actions">
        <button
          type="button"
          className="wi-button wi-primary"
          disabled={accepted.length === 0 || saving}
          onClick={() => void importAll()}
        >
          {text.import}
        </button>
        <button
          type="button"
          className="wi-button"
          disabled={rows.length === 0 || saving}
          onClick={() => {
            setRows([]);
            setChoices(new Map());
          }}
        >
          {text.clear}
        </button>
        <span className="wi-muted" role="status" data-testid="workout-import-status">
          {saving ? text.saving : (status ?? (accepted.length > 0 ? text.willImport(accepted.length) : ''))}
        </span>
      </div>
    </div>
  );
}

/** The screen `workout-import`, a global screen shown in a dialog over the page (ADR 0071). */
export const WorkoutImportScreen = reactComponent((ctx) => <ImportView ctx={ctx} />);
