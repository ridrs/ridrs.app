// SPDX-License-Identifier: AGPL-3.0-or-later

import { AreaPage, iconStyle, MenuEntry, reactComponent, Toggle, useBack, userDocument } from '@ridrs/ui-preview';
import type { UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { useState } from 'react';
import { z } from 'zod';
import {
  addEntry,
  type Calendar,
  type Entry,
  FIRST_WEEK,
  KIND_TITLES,
  moveLater,
  removeEntry,
  undo,
  WEEKDAYS,
  type Weekday,
  WORKOUTS,
  weekdayOf,
} from './calendar.ts';
import { messages } from './i18n/index.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as masks in the text colour. */
const DUMBBELL = new URL('./assets/icons/dumbbell.svg', import.meta.url).href;
const STAR = new URL('./assets/icons/star.svg', import.meta.url).href;
const UNDO = new URL('./assets/icons/undo-2.svg', import.meta.url).href;

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

const entrySchema = z
  .object({
    id: z.string(),
    day: z.enum(WEEKDAYS),
    kind: z.enum(['workout', 'rest', 'note', 'outdoor']),
    title: z.string(),
  })
  .strict();

/** What the rider changed in this area, kept at once (ADR 0059). */
const useTraining = userDocument(
  {
    name: 'preview',
    version: 1,
    schema: z
      .object({
        calendar: z.object({ entries: z.array(entrySchema), undo: z.array(z.array(entrySchema)) }).strict(),
        favourites: z.array(z.string()),
      })
      .strict(),
  },
  { calendar: FIRST_WEEK as { entries: Entry[]; undo: Entry[][] }, favourites: [] as string[] },
);

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

function TrainingAreaView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const [state, change] = useTraining(ctx);
  const today = weekdayOf(new Date());
  const [selected, setSelected] = useState<Weekday>(today);
  useBack(ctx);
  const calendar = (update: (calendar: Calendar) => Calendar) =>
    change((s) => ({ ...s, calendar: update(s.calendar) as typeof s.calendar }));
  const add = (kind: 'rest' | 'note' | 'outdoor') =>
    calendar((c) => addEntry(c, { day: selected, kind, title: KIND_TITLES[kind] }));

  return (
    <AreaPage title={text.title} intro={text.intro}>
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
