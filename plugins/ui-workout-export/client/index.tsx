// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  athleteProfileState,
  dataSourceState,
  filesSaveService,
  trainingLibraryState,
  type WorkoutSourceFormat,
  workoutExportCapability,
} from '@ridrs/contracts';
import type { UiCapabilityComponent, UiContext } from '@ridrs/ui-sdk';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { messages } from './i18n/index.ts';
import {
  chosenFtp,
  EXPORT_FORMATS,
  type ExportSubject,
  fileNameOf,
  type Library,
  prepareExport,
  subjectOf,
} from './run.ts';
import { ExportStyles } from './theme.tsx';

type Saving =
  | { readonly state: 'idle' }
  | { readonly state: 'saving' }
  | { readonly state: 'saved'; readonly fileName: string }
  | { readonly state: 'cancelled' }
  | { readonly state: 'failed' };

function ExportView({
  ctx,
  subject,
  onClose,
}: {
  readonly ctx: UiContext;
  readonly subject: ExportSubject;
  readonly onClose: () => void;
}) {
  const text = useMessages(ctx, messages);
  const libraries = useStateEntries(ctx, trainingLibraryState) as ReadonlyMap<string, Library>;
  const profiles = useStateEntries(ctx, athleteProfileState);
  const choices = useStateEntries(ctx, dataSourceState);
  const found = useMemo(() => subjectOf(subject, libraries), [subject, libraries]);
  const ftp = useMemo(() => chosenFtp(profiles, choices), [profiles, choices]);
  const [format, setFormat] = useState<WorkoutSourceFormat>('zwo');
  const [saving, setSaving] = useState<Saving>({ state: 'idle' });
  const back = useRef<HTMLButtonElement>(null);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;

  useEffect(() => ctx.onBack(() => latestClose.current()), [ctx]);
  useEffect(() => back.current?.focus(), []);

  const workout = found.state === 'shown' ? found.workout : undefined;
  // Every format is prepared in front of the rider's eyes: what it changes is known before saving.
  const prepared = useMemo(
    () => (workout ? prepareExport(workout, format, ftp) : undefined),
    [workout, format, ftp],
  );

  const save = async () => {
    if (!prepared?.ok) return;
    setSaving({ state: 'saving' });
    try {
      const { saved } = await ctx.call(filesSaveService, {
        fileName: prepared.fileName,
        mediaType: prepared.mediaType,
        data: prepared.data,
      });
      setSaving(saved ? { state: 'saved', fileName: prepared.fileName } : { state: 'cancelled' });
    } catch (error) {
      ctx.logger.warn(`Could not save the exported workout: ${String(error)}`);
      setSaving({ state: 'failed' });
    }
  };

  const choose = (next: WorkoutSourceFormat) => {
    setFormat(next);
    setSaving({ state: 'idle' });
  };

  return (
    <article
      className="we-page"
      data-testid="workout-export"
      aria-label={text.title(workout?.name ?? '')}
    >
      <ExportStyles />
      <button ref={back} type="button" className="we-back" onClick={() => latestClose.current()}>
        {text.back}
      </button>
      {workout && prepared ? (
        <>
          <h1 className="we-title">{text.title(workout.name)}</h1>
          <fieldset className="we-formats" data-testid="workout-export-formats">
            <legend className="we-label">{text.formatLabel}</legend>
            {EXPORT_FORMATS.map((option) => (
              <label key={option} className="we-format">
                <input
                  type="radio"
                  name="workout-export-format"
                  value={option}
                  checked={format === option}
                  onChange={() => choose(option)}
                />
                <span>{text.formats[option]}</span>
              </label>
            ))}
          </fieldset>
          {prepared.ok ? (
            <section aria-labelledby="we-warnings-heading">
              <h2 id="we-warnings-heading">{text.warningsHeading}</h2>
              {prepared.warnings.length === 0 ? (
                <p className="we-hint" data-testid="workout-export-clean">
                  {text.noWarnings}
                </p>
              ) : (
                <ul className="we-list" data-testid="workout-export-warnings">
                  {prepared.warnings.map((warning) => (
                    <li key={warning.code} className="we-warning" data-code={warning.code}>
                      {text.warnings[warning.code] ?? text.warningFallback}
                      {warning.at ? <span className="we-place"> {text.at(warning.at)}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <section className="we-refusal" role="alert" data-testid="workout-export-refused">
              <strong>{text.refusedHeading(text.formats[format])}</strong>
              <p>
                {prepared.reason.some((d) => d.code === 'ftp-required')
                  ? text.refusedFtp
                  : text.refusedOther}
              </p>
            </section>
          )}
          <div>
            <span className="we-label">{text.fileName}</span>
            <div data-testid="workout-export-file">{fileNameOf(workout, format)}</div>
          </div>
          <button
            type="button"
            className="we-save"
            data-testid="workout-export-save"
            disabled={!prepared.ok || saving.state === 'saving'}
            onClick={() => void save()}
          >
            {saving.state === 'saving' ? text.saving : text.save}
          </button>
          <output className="we-hint" data-testid="workout-export-status" data-state={saving.state}>
            {saving.state === 'saved'
              ? text.saved(saving.fileName)
              : saving.state === 'cancelled'
                ? text.notSaved
                : saving.state === 'failed'
                  ? text.failed
                  : ''}
          </output>
        </>
      ) : (
        <p className="we-hint">{found.state === 'loading' ? text.loading : text.missing}</p>
      )}
    </article>
  );
}

/** Provides `ui.workout-export`: one React root per drawing, new input without a new mount. */
export const WorkoutExport: UiCapabilityComponent<typeof workoutExportCapability> = (
  container,
  ctx,
  input,
  emit,
) => {
  const root = createRoot(container);
  const onClose = () => emit('closed', {});
  const draw = (subject: ExportSubject) =>
    root.render(<ExportView ctx={ctx} subject={subject} onClose={onClose} />);
  draw(input);
  return { update: draw, release: () => root.unmount() };
};
