// SPDX-License-Identifier: AGPL-3.0-or-later

import { AreaPage, iconStyle, MenuEntry, reactComponent, Toggle, useBack, userDocument } from '@ridrs/ui-preview';
import {
  DEFAULT_PROVIDER,
  type DataWriteResult,
  dataSourceState,
  trainingCalendarHandOverService,
  trainingCalendarPlanService,
  trainingCalendarState,
  trainingLibraryState,
} from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { useEffect, useState } from 'react';
import {
  addEntry,
  type Calendar,
  FIRST_WEEK,
  KIND_TITLES,
  localToday,
  moveLater,
  plannedWorkouts,
  removeEntry,
  undo,
  WEEKDAYS,
  type Weekday,
  WORKOUTS,
  nextDate,
  weekdayOf,
} from './calendar.ts';
import { INITIAL_TRAINING, TRAINING_DOCUMENT } from '../document.ts';
import { messages } from './i18n/index.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as masks in the text colour. */
const DUMBBELL = new URL('./assets/icons/dumbbell.svg', import.meta.url).href;
const STAR = new URL('./assets/icons/star.svg', import.meta.url).href;
const UNDO = new URL('./assets/icons/undo-2.svg', import.meta.url).href;
/** By Munbaik Cycling Clothing on Unsplash (Unsplash License, see the folder's README). */
const PICTURE = new URL('./assets/pictures/hero.jpg', import.meta.url).href;

const CSS = `
.tr-week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; }
[data-breakpoint="compact"] .tr-week, [data-breakpoint="medium"] .tr-week {
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.tr-day { display: flex; flex-direction: column; gap: 6px; min-height: 150px; padding: 8px;
  border: 1px solid var(--ridrs-line, #24324d); border-radius: 12px;
  background: var(--ridrs-surface, #131c2e); }
/* Today is marked by its label, not a border: a light border would look like the focus. */
.tr-day[data-today] > .pv-chip span { color: var(--ridrs-accent, #b8f53b); }
.tr-day[data-today] > .pv-chip[aria-pressed="true"] span { color: inherit; }
.tr-day > .pv-chip { justify-content: space-between; border-radius: 10px; }
.tr-entry { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: 10px;
  background: var(--ridrs-surface-raised, #1a2540); font-size: 13px; }
.tr-entry[data-kind="rest"] { color: var(--ridrs-text-muted, #93a1b8); }
.tr-entry[data-kind="outdoor"] { color: var(--ridrs-ok, #3ddc84); }
.tr-entry .pv-row { gap: 4px; }
.tr-entry .pv-button { min-height: 28px; padding: 2px 8px; font-size: 12px; }
`;

/** What the rider changed in this area, kept at once (ADR 0059). */
const useTraining = userDocument(TRAINING_DOCUMENT, INITIAL_TRAINING);

function Day({
  ctx,
  day,
  selected,
  today,
  onSelect,
}: {
  readonly ctx: UiContext;
  readonly day: Weekday;
  readonly selected: boolean;
  readonly today: boolean;
  readonly onSelect: () => void;
}) {
  const text = useMessages(ctx, messages);
  const [state, change] = useTraining(ctx);
  const calendar = (update: (calendar: Calendar) => Calendar) =>
    change((s) => ({ ...s, calendar: update(s.calendar) as typeof s.calendar }));
  const next = WEEKDAYS[WEEKDAYS.indexOf(day) + 1];
  return (
    <div className="tr-day" data-calendar-day={day} data-today={today || undefined}>
      <button type="button" className="pv-chip" aria-label={text.weekdays[day]} aria-pressed={selected} onClick={onSelect}>
        {text.short(text.weekdays[day])}
        {today ? <span aria-hidden="true">{text.today}</span> : null}
      </button>
      {state.calendar.entries
        .filter((entry) => entry.day === day)
        .map((entry) => {
          const title = entry.kind === 'workout' ? entry.title : text.kinds[entry.kind];
          return (
          <div key={entry.id} className="tr-entry" data-kind={entry.kind}>
            <span>{title}</span>
            <div className="pv-row">
              {next ? (
                <button
                  type="button"
                  className="pv-button"
                  aria-label={text.move(title, text.weekdays[day], text.weekdays[next])}
                  onClick={() => calendar((c) => moveLater(c, entry.id))}
                >
                  {text.later}
                </button>
              ) : null}
              <button
                type="button"
                className="pv-button"
                aria-label={text.removeFrom(title, text.weekdays[day])}
                onClick={() => calendar((c) => removeEntry(c, entry.id))}
              >
                {text.remove}
              </button>
            </div>
          </div>
          );
        })}
    </div>
  );
}

/** The workouts of every provider's library, read only, grouped by provider (ADR 0075). */
function Library({
  ctx,
  selected,
  planHere,
}: {
  readonly ctx: UiContext;
  readonly selected: Weekday;
  /** Puts a workout on the selected day of this area's calendar, the calendar of ridrs. */
  readonly planHere: (name: string) => void;
}) {
  const text = useMessages(ctx, messages);
  const calendars = useStateEntries(ctx, trainingCalendarState);
  const chosen = useStateEntries(ctx, dataSourceState).get('training.calendar')?.provider ?? DEFAULT_PROVIDER;
  const [refusal, setRefusal] = useState<string>();
  // "Plan on a day" writes to the chosen calendar, which answers whether it took it. The calendar
  // of ridrs is this area's own: the workout becomes one of its entries, without steps.
  const plan = (from: string, workoutId: string, name: string) => {
    if (chosen === DEFAULT_PROVIDER) {
      setRefusal(undefined);
      planHere(name);
      return;
    }
    const source = calendars.get(chosen);
    const label = source?.label ?? chosen;
    ctx
      .call(trainingCalendarPlanService, {
        key: chosen,
        date: nextDate(selected, localToday()),
        workoutId,
        from,
      })
      .then(
        (answer: DataWriteResult) => setRefusal(answer.ok ? undefined : text.planRefused(label, answer.reason)),
        (error: unknown) => ctx.logger.warn(`Could not plan the workout: ${String(error)}`),
      );
  };
  const providers = [...useStateEntries(ctx, trainingLibraryState).values()]
    .filter((source) => (source.data?.workouts.length ?? 0) > 0)
    .sort((a, b) => a.provider.localeCompare(b.provider));
  return (
    <section className="pv-section" data-testid="library">
      <h2>{text.library}</h2>
      {providers.length === 0 ? <p className="pv-muted">{text.libraryEmpty}</p> : null}
      {refusal ? (
        <p className="pv-muted" role="status">
          {refusal}
        </p>
      ) : null}
      {providers.map((source) => (
        <div key={source.provider} data-provider={source.provider}>
          <h3>{source.provider === DEFAULT_PROVIDER ? text.thisDevice : source.label}</h3>
          <div className="pv-cards">
            {source.data?.workouts.map((workout) => (
              <article key={workout.id} className="pv-card" data-library-workout={workout.id}>
                <h4>{workout.name}</h4>
                <span className="pv-muted">
                  {[
                    workout.folder,
                    workout.durationSeconds === undefined
                      ? undefined
                      : `${Math.round(workout.durationSeconds / 60)} min`,
                    workout.trainingLoad === undefined ? undefined : `${Math.round(workout.trainingLoad)} TSS`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <div className="pv-row">
                  <button type="button" className="pv-button" onClick={() => plan(source.provider, workout.id, workout.name)}>
                    {text.planFromLibrary(workout.name, text.weekdays[selected])}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function TrainingAreaView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const [state, change] = useTraining(ctx);
  const today = weekdayOf(new Date());
  const [selected, setSelected] = useState<Weekday>(today);
  useBack(ctx);
  // The calendar is a data source (ADR 0075): its owner learns of every change. Not of the
  // initial entries, which its owner has read from the same document.
  useEffect(() => {
    if (state.calendar.entries === FIRST_WEEK.entries) return;
    ctx
      .call(trainingCalendarHandOverService, {
        workouts: plannedWorkouts(state.calendar.entries, localToday()),
      })
      .catch((error: unknown) => ctx.logger.warn(`Could not hand over the calendar: ${String(error)}`));
  }, [ctx, state.calendar.entries]);
  const calendar = (update: (calendar: Calendar) => Calendar) =>
    change((s) => ({ ...s, calendar: update(s.calendar) as typeof s.calendar }));
  const add = (kind: 'rest' | 'note' | 'outdoor') =>
    calendar((c) => addEntry(c, { day: selected, kind, title: KIND_TITLES[kind] }));

  return (
    <AreaPage title={text.title} intro={text.intro} picture={{ image: PICTURE, credits: text.pictureCredits }}>
      <style>{CSS}</style>
      <section className="pv-section">
        <h2>{text.thisWeek}</h2>
        <div className="tr-week">
          {WEEKDAYS.map((day) => (
            <Day
              key={day}
              ctx={ctx}
              day={day}
              selected={day === selected}
              today={day === today}
              onSelect={() => setSelected(day)}
            />
          ))}
        </div>
        <div className="pv-row">
          <button type="button" className="pv-button" onClick={() => add('rest')}>
            {text.addRest(text.weekdays[selected])}
          </button>
          <button type="button" className="pv-button" onClick={() => add('note')}>
            {text.addNote(text.weekdays[selected])}
          </button>
          <button type="button" className="pv-button" onClick={() => add('outdoor')}>
            {text.addOutdoor(text.weekdays[selected])}
          </button>
          <button
            type="button"
            className="pv-button"
            disabled={state.calendar.undo.length === 0}
            onClick={() => calendar(undo)}
          >
            <span className="pv-glyph" aria-hidden="true" style={iconStyle(UNDO)} />
            {text.undo}
          </button>
        </div>
        <p className="pv-muted">{text.exportLater}</p>
      </section>

      <section className="pv-section">
        <h2>{text.workouts}</h2>
        <div className="pv-cards">
          {WORKOUTS.map((workout) => (
            <article key={workout.id} className="pv-card">
              <h3>{workout.name}</h3>
              <span className="pv-muted">
                {workout.minutes} min · TSS {workout.tss} · {text.zones[workout.id] ?? workout.zone}
              </span>
              <div className="pv-row">
                <Toggle
                  className="pv-icon"
                  label={text.favourite(workout.name)}
                  on={state.favourites.includes(workout.id)}
                  onChange={(on) =>
                    change((s) => ({
                      ...s,
                      favourites: on
                        ? [...s.favourites, workout.id]
                        : s.favourites.filter((id) => id !== workout.id),
                    }))
                  }
                >
                  <span className="pv-glyph" aria-hidden="true" style={iconStyle(STAR)} />
                </Toggle>
                <button
                  type="button"
                  className="pv-button"
                  onClick={() =>
                    calendar((c) => addEntry(c, { day: selected, kind: 'workout', title: workout.name }))
                  }
                >
                  {text.schedule(workout.name, text.weekdays[selected])}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <Library
        ctx={ctx}
        selected={selected}
        planHere={(name) =>
          calendar((c) => addEntry(c, { day: selected, kind: 'workout', title: name }))
        }
      />

      <section className="pv-section">
        <h2>{text.plans}</h2>
        <div className="pv-cards">
          <article className="pv-card">
            <h3>Base Builder</h3>
            <span className="pv-muted">{text.baseBuilder}</span>
          </article>
          <article className="pv-card">
            <h3>FTP Builder</h3>
            <span className="pv-muted">{text.ftpBuilder}</span>
          </article>
        </div>
      </section>

      <section className="pv-section">
        <h2>{text.suggestion}</h2>
        <article className="pv-card">
          <span className="pv-muted">{text.suggestionLater}</span>
        </article>
      </section>
    </AreaPage>
  );
}

export const TrainingArea = reactComponent((ctx) => <TrainingAreaView ctx={ctx} />);
function TrainingMenuEntryView({ ctx }: { readonly ctx: UiContext }) {
  return <MenuEntry ctx={ctx} screen="training" label={useMessages(ctx, messages).title} icon={DUMBBELL} />;
}

export const TrainingMenuEntry = reactComponent((ctx) => <TrainingMenuEntryView ctx={ctx} />);
