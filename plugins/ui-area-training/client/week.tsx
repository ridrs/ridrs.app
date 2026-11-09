// SPDX-License-Identifier: AGPL-3.0-or-later

import { iconStyle, userDocument } from '@ridrs/ui-preview';
import {
  type CompletedWorkout,
  DEFAULT_PROVIDER,
  type DataWriteResult,
  dataSourceState,
  trainingCalendarHandOverService,
  trainingCalendarMoveService,
  trainingCalendarPlanService,
  trainingCalendarState,
  trainingHistoryState,
} from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { type DragEvent, useEffect, useRef, useState } from 'react';
import { INITIAL_TRAINING, TRAINING_DOCUMENT } from '../document.ts';
import {
  addDays,
  addEntry,
  arrivedEntry,
  type Calendar,
  FIRST_WEEK,
  localToday,
  mergeCompleted,
  moveEntry,
  type Pending,
  type PlannedItem,
  plannedWorkouts,
  WEEKDAYS,
  type Weekday,
  weekDate,
  withPending,
} from './calendar.ts';
import { messages } from './i18n/index.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as masks in the text colour. */
const CHEVRON_LEFT = new URL('./assets/icons/chevron-left.svg', import.meta.url).href;
const CHEVRON_RIGHT = new URL('./assets/icons/chevron-right.svg', import.meta.url).href;
export const MAXIMIZE = new URL('./assets/icons/maximize-2.svg', import.meta.url).href;
const CHECK = new URL('./assets/icons/check.svg', import.meta.url).href;

/** What the rider changed in this area, kept at once (ADR 0059). */
export const useTraining = userDocument(TRAINING_DOCUMENT, INITIAL_TRAINING);

/** A change of a remote calendar that waits for Save: what is shown, and the call it becomes. */
interface DraftChange {
  readonly key: number;
  readonly change: Omit<Pending, 'key' | 'draft'>;
  readonly request:
    | { readonly kind: 'plan'; readonly workoutId: string; readonly from: string }
    | { readonly kind: 'move'; readonly id: string };
}

/** What is being dragged: an entry of the week, or a workout of a library. */
export type Drag =
  | { readonly kind: 'entry'; readonly id: string }
  | { readonly kind: 'library'; readonly provider: string; readonly workoutId: string; readonly name: string };

/** What the pointer shows: a workout of a catalog is copied into the calendar (a plus), an entry of it moved. */
export const effectOf = (drag: Drag): 'copy' | 'move' => (drag.kind === 'library' ? 'copy' : 'move');

export const startDrag = (drag: Drag, set: (drag: Drag | undefined) => void) => (event: DragEvent<HTMLElement>) => {
  // Some web views start no drag without data.
  event.dataTransfer?.setData('text/plain', drag.kind === 'entry' ? drag.id : drag.name);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = effectOf(drag);
  set(drag);
};

/** "45 min"; nothing for a ride of no length. */
const minutes = (seconds: number | undefined) =>
  seconds !== undefined && Math.round(seconds / 60) > 0 ? `${Math.round(seconds / 60)} min` : undefined;

const detailOf = (ride: CompletedWorkout): string =>
  [minutes(ride.durationSeconds), ride.trainingLoad ? `${Math.round(ride.trainingLoad)} TSS` : undefined]
    .filter(Boolean)
    .join(' · ');

/**
 * The week the calendar shows, and what the rider can do with it: the entries of the chosen
 * calendar and the rides done by every provider (ADR 0076) on its days, a drag that plans or moves
 * a workout, and the answer of a calendar that refused one. The calendar of ridrs holds this week's
 * entries only (they have weekdays, no dates): other weeks show what the providers have.
 */
export function useWeek(ctx: UiContext) {
  const text = useMessages(ctx, messages);
  const [state, change] = useTraining(ctx);
  const today = localToday();
  const [offset, setOffset] = useState(0);
  const [drag, setDrag] = useState<Drag>();
  const [refusal, setRefusal] = useState<string>();
  // Plans and moves a provider has not answered: shown at once, with a sign that they are not kept yet.
  const [pending, setPending] = useState<readonly Pending[]>([]);
  // Changes to a calendar behind an external API wait here for one Save (ADR 0078).
  const [draft, setDraft] = useState<readonly DraftChange[]>([]);
  const [saving, setSaving] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const nextKey = useRef(1);
  const monday = addDays(weekDate('Monday', today), offset * 7);
  const dateOf = (day: Weekday) => addDays(monday, WEEKDAYS.indexOf(day));

  // The calendar is a data source (ADR 0075): its owner learns of every change. Not of the
  // initial entries, which its owner has read from the same document.
  useEffect(() => {
    if (state.calendar.entries === FIRST_WEEK.entries) return;
    ctx
      .call(trainingCalendarHandOverService, { workouts: plannedWorkouts(state.calendar.entries, localToday()) })
      .catch((error: unknown) => ctx.logger.warn(`Could not hand over the calendar: ${String(error)}`));
  }, [ctx, state.calendar.entries]);
  const calendar = (update: (calendar: Calendar) => Calendar) =>
    change((s) => ({ ...s, calendar: update(s.calendar) as typeof s.calendar }));

  const calendars = useStateEntries(ctx, trainingCalendarState);
  const chosen = useStateEntries(ctx, dataSourceState).get('training.calendar')?.provider ?? DEFAULT_PROVIDER;
  const ownEntriesOnly = chosen === DEFAULT_PROVIDER;
  const providerWorkouts = calendars.get(chosen)?.data?.workouts ?? [];
  // A change is shown until its entry is in the provider's calendar. The calendar arrives before the
  // answer to the write (and an answer can also come first), so the entry is neither gone nor
  // listed twice for a moment: the change is hidden at once when its entry is there.
  const shownPending = pending.filter((change) => !arrivedEntry(change, providerWorkouts));
  const remote = !ownEntriesOnly && calendars.get(chosen)?.remote === true;
  // The entry a plan became takes over the key of its pending entry for good: one entry, updated.
  const claims = useRef(new Map<string, string>());
  for (const change of pending) {
    const entry = change.moving === undefined ? arrivedEntry(change, providerWorkouts) : undefined;
    if (entry) claims.current.set(entry.id, `pending-${change.key}`);
  }
  useEffect(() => {
    if (shownPending.length !== pending.length) setPending(shownPending);
  }, [pending, shownPending]);
  const planned = (day: Weekday): readonly PlannedItem[] => {
    if (ownEntriesOnly) {
      return offset === 0
        ? state.calendar.entries.filter((entry) => entry.day === day).map((entry) => ({ ...entry, key: entry.id }))
        : [];
    }
    const entries = (calendars.get(chosen)?.data?.workouts ?? [])
      .filter((workout) => workout.date === dateOf(day))
      .map((workout) => ({
        id: workout.id,
        kind: 'workout' as const,
        title: workout.name,
        ...(minutes(workout.durationSeconds) ? { detail: minutes(workout.durationSeconds) as string } : {}),
      }));
    return withPending(
      entries,
      dateOf(day),
      [...shownPending, ...draft.map((item): Pending => ({ ...item.change, key: item.key, draft: true }))],
      claims.current,
    );
  };

  const completed = mergeCompleted(
    [...useStateEntries(ctx, trainingHistoryState).values()].map((source) => source.data?.workouts ?? []),
  );
  const done = (day: Weekday): readonly CompletedWorkout[] => completed.filter((ride) => ride.date === dateOf(day));

  /** Only today and the days after it take a workout; the calendar of ridrs only this week's. */
  const droppable = (day: Weekday) => dateOf(day) >= today && (!ownEntriesOnly || offset === 0);

  /** Waits for the provider's answer to a change that is shown meanwhile; a refusal takes it back. */
  const written = (change: Omit<Pending, 'key'>, answer: Promise<DataWriteResult>) => {
    const key = nextKey.current++;
    const label = calendars.get(chosen)?.label ?? chosen;
    const before = providerWorkouts.filter((workout) => workout.date === change.date).map((workout) => workout.id);
    setPending((all) => [...all, { ...change, key, before }]);
    const settled = () => setPending((all) => all.filter((item) => item.key !== key));
    answer.then(
      (result) => {
        if (result.ok) {
          // Should its entry never come (a refresh that failed), the change does not stay shown for good.
          setTimeout(settled, 4000);
        } else {
          settled();
          setRefusal(text.planRefused(label, result.reason));
        }
      },
      (error: unknown) => {
        settled();
        ctx.logger.warn(`Could not change the calendar: ${String(error)}`);
        setRefusal(text.writeFailed(label));
      },
    );
  };
  /** Sends the open changes one after another; the first refusal stops and keeps the rest. */
  const saveDraft = async () => {
    if (saving || draft.length === 0) return;
    setSaving(true);
    setRefusal(undefined);
    const label = calendars.get(chosen)?.label ?? chosen;
    for (const item of draft) {
      const answer = await ctx
        .call(
          item.request.kind === 'move' ? trainingCalendarMoveService : trainingCalendarPlanService,
          item.request.kind === 'move'
            ? { key: chosen, id: item.request.id, date: item.change.date }
            : { key: chosen, date: item.change.date, workoutId: item.request.workoutId, from: item.request.from },
        )
        .catch((error: unknown): DataWriteResult => {
          ctx.logger.warn(`Could not change the calendar: ${String(error)}`);
          return { ok: false, reason: 'unreachable' };
        });
      if (!answer.ok) {
        setRefusal(text.planRefused(label, answer.reason));
        break;
      }
      // The provider's calendar shows it at once; until its entry is there the change stays listed as saving.
      const key = nextKey.current++;
      setPending((all) => [...all, { ...item.change, key }]);
      setTimeout(() => setPending((all) => all.filter((entry) => entry.key !== key)), 4000);
      setDraft((open) => open.filter((entry) => entry.key !== item.key));
    }
    setSaving(false);
  };
  const discardDraft = () => {
    setDraft([]);
    setRefusal(undefined);
  };
  const drop = (day: Weekday) => {
    if (drag === undefined || !droppable(day)) return;
    const date = dateOf(day);
    setRefusal(undefined);
    if (drag.kind === 'entry') {
      if (ownEntriesOnly) calendar((c) => moveEntry(c, drag.id, day));
      else {
        const title = (calendars.get(chosen)?.data?.workouts ?? []).find((workout) => workout.id === drag.id)?.name ?? '';
        if (remote) {
          const before = providerWorkouts.filter((workout) => workout.date === date).map((workout) => workout.id);
          setDraft((open) => [
            ...open.filter((item) => !(item.request.kind === 'move' && item.request.id === drag.id)),
            { key: nextKey.current++, change: { date, title, moving: drag.id, before }, request: { kind: 'move', id: drag.id } },
          ]);
        } else {
          written({ date, title, moving: drag.id }, ctx.call(trainingCalendarMoveService, { key: chosen, id: drag.id, date }));
        }
      }
    } else if (ownEntriesOnly) {
      // The calendar of ridrs is this area's own: the workout becomes one of its entries.
      calendar((c) => addEntry(c, { day, kind: 'workout', title: drag.name }));
    } else if (remote) {
      const before = providerWorkouts.filter((workout) => workout.date === date).map((workout) => workout.id);
      setDraft((open) => [
        ...open,
        {
          key: nextKey.current++,
          change: { date, title: drag.name, before },
          request: { kind: 'plan', workoutId: drag.workoutId, from: drag.provider },
        },
      ]);
    } else {
      written(
        { date, title: drag.name },
        ctx.call(trainingCalendarPlanService, { key: chosen, date, workoutId: drag.workoutId, from: drag.provider }),
      );
    }
  };

  return {
    today,
    monday,
    offset,
    setOffset,
    dateOf,
    planned,
    done,
    droppable,
    drop,
    drag,
    setDrag,
    refusal,
    draft,
    saving,
    saveButton,
    saveDraft,
    discardDraft,
    ownEntriesOnly,
    favourites: state.favourites,
    change,
    calendar,
  };
}

export type Week = ReturnType<typeof useWeek>;

export const WEEK_CSS = `
.tw { display: flex; flex-direction: column; gap: 14px; }
.tw-bar { display: flex; align-items: center; gap: 10px; }
.tw-bar-range { flex: 1; font-size: 22px; letter-spacing: .02em; }
.tw-bar-range small { margin-left: 10px; color: var(--ridrs-text-muted, #8b9bb4); font-size: 12px; }
.tw-nav { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px;
  padding: 0; border: 1px solid var(--ridrs-line, #1b2a3c); border-radius: 10px;
  background: rgb(255 255 255 / .03); color: var(--ridrs-text, #f1f5f9); cursor: pointer; }
.tw-nav:hover { border-color: var(--ridrs-info, #00f0ff); color: var(--ridrs-info, #00f0ff); }
.tw-nav:focus-visible { outline: 3px solid var(--ridrs-focus, #00f0ff); outline-offset: 2px; }
.tw-grid { position: relative; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr));
  overflow: hidden; border: 1px solid var(--ridrs-line, #1b2a3c); border-radius: 14px;
  background: linear-gradient(180deg, rgb(0 240 255 / .045), transparent 40%), var(--ridrs-surface, #0d121c); }
.tw-day { position: relative; display: flex; flex-direction: column; gap: 8px; min-width: 0;
  min-height: var(--tw-day-height, 230px); padding: 0 8px 12px;
  border-left: 1px solid var(--ridrs-line, #1b2a3c); transition: background .15s; }
.tw-day:first-child { border-left: 0; }
.tw-day-head { display: flex; align-items: baseline; gap: 8px; padding: 12px 4px 8px;
  border-bottom: 1px solid var(--ridrs-line, #1b2a3c); }
.tw-day-name { font-size: 13px; letter-spacing: .14em; color: var(--ridrs-text-muted, #8b9bb4); }
.tw-date-name { margin-left: auto; font-size: 30px; line-height: 1; font-weight: 600; color: var(--ridrs-text, #f1f5f9); }
.tw-day[data-today] { background: linear-gradient(180deg, rgb(204 255 0 / .1), transparent 55%); }
.tw-day[data-today]::before { content: ""; position: absolute; inset: 0 0 auto; height: 3px;
  background: var(--ridrs-accent, #ccff00); box-shadow: 0 0 18px 2px rgb(204 255 0 / .55); }
.tw-day[data-today] .tw-day-name, .tw-day[data-today] .tw-date-name { color: var(--ridrs-accent, #ccff00); }
.tw-day[data-past] .tw-date-name { color: var(--ridrs-text-muted, #8b9bb4); }
.tw-day[data-over] { background: rgb(0 240 255 / .1); box-shadow: inset 0 0 0 2px var(--ridrs-info, #00f0ff); }
.tw-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.tw-entry { transition: background .25s, box-shadow .25s; position: relative; display: flex; flex-direction: column; gap: 2px; padding: 8px 10px 8px 14px;
  clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px)); }
.tw-entry-name { overflow-wrap: anywhere; font-size: 14px; line-height: 1.15; }
.tw-entry-label { font-size: 11px; letter-spacing: .06em; opacity: .75; }
/* Planned: a cut-corner outline with a cyan edge, like a slot waiting to be ridden. */
.tw-entry[data-state="planned"] { background: rgb(0 240 255 / .1); color: var(--ridrs-text, #f1f5f9); }
.tw-entry[data-state="planned"]::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px;
  background: var(--ridrs-info, #00f0ff); box-shadow: 0 0 12px rgb(0 240 255 / .7); }
.tw-entry[draggable="true"] { cursor: grab; }
.tw-entry[draggable="true"]:hover { background: rgb(0 240 255 / .2); }
.tw-entry[data-kind="rest"], .tw-entry[data-kind="note"] { background: rgb(255 255 255 / .05); }
.tw-entry[data-kind="rest"]::before, .tw-entry[data-kind="note"]::before { background: var(--ridrs-text-muted, #8b9bb4); box-shadow: none; }
.tw-entry[data-kind="outdoor"] { background: rgb(61 220 132 / .12); }
.tw-entry[data-kind="outdoor"]::before { background: var(--ridrs-ok, #3ddc84); box-shadow: 0 0 12px rgb(61 220 132 / .6); }
/* Done: solid volt, the way a finished ride should shine. */
.tw-entry[data-state="done"] { background: var(--ridrs-accent, #ccff00); color: var(--ridrs-accent-text, #07090e);
  box-shadow: 0 0 22px rgb(204 255 0 / .28); }
.tw-entry[data-state="done"] .tw-entry-name { display: flex; align-items: center; gap: 6px; }
.tw-entry[data-state="done"] .pv-glyph { width: 14px; height: 14px; }
.tw-entry[data-state="done"] .tw-entry-label { color: var(--ridrs-accent-text, #07090e) !important; opacity: .75; }
/* Not kept yet: a light sweeps across the entry until the provider has it. */
.tw-entry[data-pending] { overflow: hidden; }
.tw-entry[data-pending]::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%);
  background: linear-gradient(100deg, transparent 30%, rgb(0 240 255 / .35) 50%, transparent 70%);
  animation: tw-sweep 1.1s ease-in-out infinite; }
@keyframes tw-sweep { to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) { .tw-entry[data-pending]::after { animation: none; transform: none; opacity: .4; } }
.tw-note { margin: 0; color: var(--ridrs-text-muted, #8b9bb4); font-size: 13px; }
.tw[data-large] { --tw-day-height: 62vh; }
.tw[data-large] .tw-date-name { font-size: 44px; }
.tw[data-large] .tw-entry-name { font-size: 17px; }
.tw[data-large] .tw-bar-range { font-size: 30px; }
[data-breakpoint="compact"] .tw-grid { grid-template-columns: minmax(0, 1fr); }
[data-breakpoint="compact"] .tw-day { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: 4px 12px;
  min-height: 0; border-left: 0; border-top: 1px solid var(--ridrs-line, #1b2a3c); padding: 8px 12px; }
[data-breakpoint="compact"] .tw-day:first-child { border-top: 0; }
[data-breakpoint="compact"] .tw-day-head { border-bottom: 0; padding: 4px 0; flex-direction: column; gap: 0; }
[data-breakpoint="compact"] .tw-date-name { margin-left: 0; font-size: 24px; }
`;

/** The week as seven days from left to right: plans and rides together in each day. */
export function WeekCalendar({
  ctx,
  week,
  large = false,
  onOpenLarge,
}: {
  readonly ctx: UiContext;
  readonly week: Week;
  readonly large?: boolean;
  /** Offers the large calendar on its own page; the large calendar itself does not. */
  readonly onOpenLarge?: () => void;
}) {
  const text = useMessages(ctx, messages);
  const [over, setOver] = useState<Weekday>();
  const { today, offset, setOffset, drag, setDrag } = week;
  const short = new Intl.DateTimeFormat(text.dateLocale, { day: 'numeric', month: 'short' });
  const at = (date: string) => {
    const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const sunday = week.dateOf('Sunday');
  return (
    <div className="tw" data-large={large || undefined} data-week-start={week.monday}>
      <div className="tw-bar">
        <button type="button" className="tw-nav" aria-label={text.previousWeek} onClick={() => setOffset(offset - 1)}>
          <span className="pv-glyph" aria-hidden="true" style={iconStyle(CHEVRON_LEFT)} />
        </button>
        <button type="button" className="tw-nav" aria-label={text.nextWeek} onClick={() => setOffset(offset + 1)}>
          <span className="pv-glyph" aria-hidden="true" style={iconStyle(CHEVRON_RIGHT)} />
        </button>
        <h2 className="tw-bar-range tw-title" style={{ margin: 0 }}>
          {short.format(at(week.monday))} – {short.format(at(sunday))}
          {offset === 0 ? <small>{text.thisWeek}</small> : null}
        </h2>
        {offset !== 0 ? (
          <button type="button" className="pv-button" onClick={() => setOffset(0)}>
            {text.thisWeek}
          </button>
        ) : null}
        {onOpenLarge ? (
          <button type="button" className="tw-nav" aria-label={text.openLarge} onClick={onOpenLarge}>
            <span className="pv-glyph" aria-hidden="true" style={iconStyle(MAXIMIZE)} />
          </button>
        ) : null}
      </div>
      {week.draft.length > 0 ? (
        <div className="pv-row" data-testid="calendar-draft">
          <span role="status">{text.changesOpen(week.draft.length)}</span>
          <button ref={week.saveButton} type="button" className="pv-button" disabled={week.saving} onClick={() => void week.saveDraft()}>
            {text.save}
          </button>
          <button type="button" className="pv-button" disabled={week.saving} onClick={week.discardDraft}>
            {text.discard}
          </button>
        </div>
      ) : null}
      {week.refusal ? (
        <p className="tw-note" role="status">
          {week.refusal}
        </p>
      ) : null}
      {week.ownEntriesOnly && offset !== 0 ? <p className="tw-note">{text.thisWeekOnly}</p> : null}
      <div className="tw-grid">
        {WEEKDAYS.map((day) => {
          const date = week.dateOf(day);
          const past = date < today;
          const done = week.done(day);
          return (
            <div
              key={day}
              className="tw-day"
              data-calendar-day={day}
              data-date={date}
              data-today={date === today || undefined}
              data-past={past || undefined}
              data-over={(over === day && drag !== undefined) || undefined}
              onDragOver={(event) => {
                if (drag === undefined || !week.droppable(day)) return;
                event.preventDefault();
                // Over a day too: the pointer goes by where the workout comes from, not by where it is.
                if (event.dataTransfer) event.dataTransfer.dropEffect = effectOf(drag);
                setOver(day);
              }}
              onDragLeave={() => setOver((was) => (was === day ? undefined : was))}
              onDrop={(event) => {
                event.preventDefault();
                setOver(undefined);
                week.drop(day);
                setDrag(undefined);
              }}
            >
              <div className="tw-day-head">
                <span className="tw-day-name" title={text.weekdays[day]}>
                  {text.short(text.weekdays[day])}
                </span>
                <span className="tw-date-name">{at(date).getDate()}</span>
              </div>
              <ul className="tw-list">
                {week.planned(day).map((entry) => (
                  <li
                    key={entry.key}
                    className="tw-entry tr-entry"
                    data-state="planned"
                    data-kind={entry.kind}
                    data-pending={entry.pending || undefined}
                    draggable={!past && !entry.pending}
                    onDragStart={startDrag({ kind: 'entry', id: entry.id }, setDrag)}
                    onDragEnd={() => setDrag(undefined)}
                  >
                    <span className="tw-entry-name">{entry.kind === 'workout' ? entry.title : text.kinds[entry.kind]}</span>
                    {entry.pending ? (
                      <span className="tw-entry-label">{entry.draft && !week.saving ? text.notSaved : text.saving}</span>
                    ) : entry.detail ? (
                      <span className="tw-entry-label">{entry.detail}</span>
                    ) : null}
                  </li>
                ))}
                {done.map((ride) => (
                  <li key={ride.id} className="tw-entry" data-state="done" data-done>
                    <span className="tw-entry-name">
                      <span className="pv-glyph" aria-hidden="true" style={iconStyle(CHECK)} />
                      {ride.name}
                    </span>
                    {detailOf(ride) ? <span className="tw-entry-label">{detailOf(ride)}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
