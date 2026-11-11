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
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { INITIAL_TRAINING, TRAINING_DOCUMENT } from '../document.ts';
import {
  addDays,
  addEntry,
  addMonths,
  arrivedEntry,
  type Calendar,
  FIRST_WEEK,
  localToday,
  matchDone,
  mergeCompleted,
  monthDays,
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
  // The entry a plan became takes over the key of its pending entry for good: one entry, updated.
  const claims = useRef(new Map<string, string>());
  for (const change of pending) {
    const entry = change.moving === undefined ? arrivedEntry(change, providerWorkouts) : undefined;
    if (entry) claims.current.set(entry.id, `pending-${change.key}`);
  }
  useEffect(() => {
    if (shownPending.length !== pending.length) setPending(shownPending);
  }, [pending, shownPending]);
  /** The weekday a date has in this week; none for a date of another week. */
  const thisWeeksDay = (date: string): Weekday | undefined => WEEKDAYS.find((day) => weekDate(day, today) === date);
  const planned = (date: string): readonly PlannedItem[] => {
    if (ownEntriesOnly) {
      const day = thisWeeksDay(date);
      return day === undefined
        ? []
        : state.calendar.entries.filter((entry) => entry.day === day).map((entry) => ({ ...entry, key: entry.id }));
    }
    const entries = providerWorkouts
      .filter((workout) => workout.date === date)
      .map((workout) => ({
        id: workout.id,
        kind: 'workout' as const,
        title: workout.name,
        ...(minutes(workout.durationSeconds) ? { detail: minutes(workout.durationSeconds) as string } : {}),
        ...(workout.durationSeconds === undefined ? {} : { durationSeconds: workout.durationSeconds }),
        ...(workout.trainingLoad === undefined ? {} : { trainingLoad: workout.trainingLoad }),
      }));
    return withPending(entries, date, shownPending, claims.current);
  };

  const completed = mergeCompleted(
    [...useStateEntries(ctx, trainingHistoryState).values()].map((source) => source.data?.workouts ?? []),
  );
  /**
   * What a day lists: the plans not yet ridden, and the rides, each with the plan it did. A plan
   * that was ridden is listed once, as its ride.
   */
  const day = (date: string) =>
    matchDone(
      planned(date),
      completed.filter((ride) => ride.date === date),
    );

  /** Only today and the days after it take a workout; the calendar of ridrs only this week's. */
  const droppable = (date: string) => date >= today && (!ownEntriesOnly || thisWeeksDay(date) !== undefined);

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
  const drop = (date: string) => {
    if (drag === undefined || !droppable(date)) return;
    const day = thisWeeksDay(date) ?? 'Monday';
    setRefusal(undefined);
    if (drag.kind === 'entry') {
      if (ownEntriesOnly) calendar((c) => moveEntry(c, drag.id, day));
      else {
        const title = (calendars.get(chosen)?.data?.workouts ?? []).find((workout) => workout.id === drag.id)?.name ?? '';
        written({ date, title, moving: drag.id }, ctx.call(trainingCalendarMoveService, { key: chosen, id: drag.id, date }));
      }
    } else if (ownEntriesOnly) {
      // The calendar of ridrs is this area's own: the workout becomes one of its entries.
      calendar((c) => addEntry(c, { day, kind: 'workout', title: drag.name }));
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
    day,
    droppable,
    drop,
    drag,
    setDrag,
    refusal,
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
/* The way back to today's week or month: a link beside what is shown. */
.tw-current { margin-left: 10px; padding: 2px 4px; border: 0; border-radius: 4px; background: none;
  color: var(--ridrs-info, #00f0ff); font: inherit; font-size: 12px; letter-spacing: .02em; text-transform: inherit;
  text-decoration: underline; text-underline-offset: 3px; cursor: pointer; vertical-align: middle; }
.tw-current:hover { color: var(--ridrs-text, #f1f5f9); }
.tw-current:focus-visible { outline: 3px solid var(--ridrs-focus, #00f0ff); outline-offset: 2px; }
/* The month: whole weeks, each day a cell with its number and what it lists. */
.tm .tw-bar-range { font-size: 30px; }
.tm-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); overflow: hidden;
  border: 1px solid var(--ridrs-line, #1b2a3c); border-radius: 14px; background: var(--ridrs-surface, #0d121c); }
.tm-weekday { padding: 10px 10px 8px; font-size: 12px; letter-spacing: .14em; color: var(--ridrs-text-muted, #8b9bb4);
  border-bottom: 1px solid var(--ridrs-line, #1b2a3c); }
.tm-day { position: relative; display: flex; flex-direction: column; gap: 6px; min-width: 0; min-height: 118px;
  padding: 8px; border-top: 1px solid var(--ridrs-line, #1b2a3c); border-left: 1px solid var(--ridrs-line, #1b2a3c);
  transition: background .15s; }
.tm-day:nth-child(7n + 1) { border-left: 0; }
.tm-day:nth-child(-n + 14) { border-top: 0; }
.tm-date { align-self: flex-end; font-size: 18px; line-height: 1; font-weight: 600; color: var(--ridrs-text, #f1f5f9); }
.tm-day[data-past] .tm-date { color: var(--ridrs-text-muted, #8b9bb4); }
.tm-day[data-outside] { background: rgb(0 0 0 / .25); }
.tm-day[data-outside] .tm-date { opacity: .45; }
.tm-day[data-today] { background: linear-gradient(180deg, rgb(204 255 0 / .1), transparent 70%); }
.tm-day[data-today]::before { content: ""; position: absolute; inset: 0 0 auto; height: 3px;
  background: var(--ridrs-accent, #ccff00); box-shadow: 0 0 18px 2px rgb(204 255 0 / .55); }
.tm-day[data-today] .tm-date { color: var(--ridrs-accent, #ccff00); }
.tm-day[data-over] { background: rgb(0 240 255 / .1); box-shadow: inset 0 0 0 2px var(--ridrs-info, #00f0ff); }
.tm-day .tw-list { gap: 4px; }
.tm-day .tw-entry { padding: 4px 6px 4px 10px; clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px)); }
.tm-day .tw-entry-name { font-size: 12px; }
.tm-day .tw-entry-label { font-size: 10px; }
[data-breakpoint="compact"] .tm-day { min-height: 72px; padding: 4px; }
[data-breakpoint="compact"] .tm-day .tw-entry-label { display: none; }
[data-breakpoint="compact"] .tw-grid { grid-template-columns: minmax(0, 1fr); }
[data-breakpoint="compact"] .tw-day { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: 4px 12px;
  min-height: 0; border-left: 0; border-top: 1px solid var(--ridrs-line, #1b2a3c); padding: 8px 12px; }
[data-breakpoint="compact"] .tw-day:first-child { border-top: 0; }
[data-breakpoint="compact"] .tw-day-head { border-bottom: 0; padding: 4px 0; flex-direction: column; gap: 0; }
[data-breakpoint="compact"] .tw-date-name { margin-left: 0; font-size: 24px; }
`;

/** A local date (`YYYY-MM-DD`) as a `Date` at local midnight, for formatting. */
const at = (date: string) => {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/**
 * A day of the calendar: a drop target with what it lists, the plans not yet ridden and the
 * rides, a plan that was ridden once, as its ride ("as planned").
 */
function Day({
  ctx,
  week,
  date,
  className,
  head,
  attributes,
}: {
  readonly ctx: UiContext;
  readonly week: Week;
  readonly date: string;
  readonly className: string;
  readonly head: ReactNode;
  readonly attributes?: Readonly<Record<string, string | boolean | undefined>>;
}) {
  const text = useMessages(ctx, messages);
  const [over, setOver] = useState(false);
  const { today, drag, setDrag } = week;
  const past = date < today;
  const { open, done } = week.day(date);
  return (
    <div
      className={className}
      data-date={date}
      data-today={date === today || undefined}
      data-past={past || undefined}
      data-over={(over && drag !== undefined) || undefined}
      {...attributes}
      onDragOver={(event) => {
        if (drag === undefined || !week.droppable(date)) return;
        event.preventDefault();
        // Over a day too: the pointer goes by where the workout comes from, not by where it is.
        if (event.dataTransfer) event.dataTransfer.dropEffect = effectOf(drag);
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        week.drop(date);
        setDrag(undefined);
      }}
    >
      {head}
      <ul className="tw-list">
        {open.map((entry) => (
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
              <span className="tw-entry-label">{text.saving}</span>
            ) : entry.detail ? (
              <span className="tw-entry-label">{entry.detail}</span>
            ) : null}
          </li>
        ))}
        {done.map(({ ride, plan }) => (
          <li
            key={ride.id}
            className="tw-entry"
            data-state="done"
            data-done
            data-as-planned={plan ? true : undefined}
            title={plan ? text.ridAsPlanned(plan.title) : undefined}
          >
            <span className="tw-entry-name">
              <span className="pv-glyph" aria-hidden="true" style={iconStyle(CHECK)} />
              {ride.name}
            </span>
            {plan || detailOf(ride) ? (
              <span className="tw-entry-label">
                {[plan ? text.asPlanned : undefined, detailOf(ride) || undefined].filter(Boolean).join(' · ')}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The bar above a calendar: back and forth, what is shown, and the way back to today's week or
 * month. "This week" names the week that is today's; on another one it is the link back to it.
 */
function Bar({
  ctx,
  title,
  current,
  currentLabel,
  previous,
  next,
  onPrevious,
  onNext,
  onCurrent,
  children,
}: {
  readonly ctx: UiContext;
  readonly title: string;
  readonly current: boolean;
  readonly currentLabel: string;
  readonly previous: string;
  readonly next: string;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly onCurrent: () => void;
  readonly children?: ReactNode;
}) {
  useMessages(ctx, messages);
  return (
    <div className="tw-bar">
      <button type="button" className="tw-nav" aria-label={previous} onClick={onPrevious}>
        <span className="pv-glyph" aria-hidden="true" style={iconStyle(CHEVRON_LEFT)} />
      </button>
      <button type="button" className="tw-nav" aria-label={next} onClick={onNext}>
        <span className="pv-glyph" aria-hidden="true" style={iconStyle(CHEVRON_RIGHT)} />
      </button>
      <h2 className="tw-bar-range tw-title" style={{ margin: 0 }}>
        {title}
        {current ? (
          <small>{currentLabel}</small>
        ) : (
          <button type="button" className="tw-current" onClick={onCurrent}>
            {currentLabel}
          </button>
        )}
      </h2>
      {children}
    </div>
  );
}

/** The week as seven days from left to right: plans and rides together in each day. */
export function WeekCalendar({
  ctx,
  week,
  onOpenLarge,
}: {
  readonly ctx: UiContext;
  readonly week: Week;
  /** Offers the large calendar on its own page. */
  readonly onOpenLarge: () => void;
}) {
  const text = useMessages(ctx, messages);
  const { offset, setOffset } = week;
  const short = new Intl.DateTimeFormat(text.dateLocale, { day: 'numeric', month: 'short' });
  const sunday = week.dateOf('Sunday');
  return (
    <div className="tw" data-week-start={week.monday}>
      <Bar
        ctx={ctx}
        title={`${short.format(at(week.monday))} – ${short.format(at(sunday))}`}
        current={offset === 0}
        currentLabel={text.thisWeek}
        previous={text.previousWeek}
        next={text.nextWeek}
        onPrevious={() => setOffset(offset - 1)}
        onNext={() => setOffset(offset + 1)}
        onCurrent={() => setOffset(0)}
      >
        <button type="button" className="tw-nav" aria-label={text.openLarge} onClick={onOpenLarge}>
          <span className="pv-glyph" aria-hidden="true" style={iconStyle(MAXIMIZE)} />
        </button>
      </Bar>
      {week.refusal ? (
        <p className="tw-note" role="status">
          {week.refusal}
        </p>
      ) : null}
      {week.ownEntriesOnly && offset !== 0 ? <p className="tw-note">{text.thisWeekOnly}</p> : null}
      <div className="tw-grid">
        {WEEKDAYS.map((day) => {
          const date = week.dateOf(day);
          return (
            <Day
              key={day}
              ctx={ctx}
              week={week}
              date={date}
              className="tw-day"
              attributes={{ 'data-calendar-day': day }}
              head={
                <div className="tw-day-head">
                  <span className="tw-day-name" title={text.weekdays[day]}>
                    {text.short(text.weekdays[day])}
                  </span>
                  <span className="tw-date-name">{at(date).getDate()}</span>
                </div>
              }
            />
          );
        })}
      </div>
    </div>
  );
}

/** The month as whole weeks, Monday first: the large calendar, paged by month. */
export function MonthCalendar({ ctx, week }: { readonly ctx: UiContext; readonly week: Week }) {
  const text = useMessages(ctx, messages);
  const [offset, setOffset] = useState(0);
  const month = addMonths(week.today.slice(0, 7), offset);
  const title = new Intl.DateTimeFormat(text.dateLocale, { month: 'long', year: 'numeric' }).format(at(`${month}-01`));
  return (
    <div className="tw tm" data-month={month}>
      <Bar
        ctx={ctx}
        title={title}
        current={offset === 0}
        currentLabel={text.thisMonth}
        previous={text.previousMonth}
        next={text.nextMonth}
        onPrevious={() => setOffset(offset - 1)}
        onNext={() => setOffset(offset + 1)}
        onCurrent={() => setOffset(0)}
      />
      {week.refusal ? (
        <p className="tw-note" role="status">
          {week.refusal}
        </p>
      ) : null}
      {week.ownEntriesOnly ? <p className="tw-note">{text.thisWeekOnly}</p> : null}
      <div className="tm-grid">
        {WEEKDAYS.map((day) => (
          <span key={day} className="tm-weekday" title={text.weekdays[day]}>
            {text.short(text.weekdays[day])}
          </span>
        ))}
        {monthDays(month).map((date) => (
          <Day
            key={date}
            ctx={ctx}
            week={week}
            date={date}
            className="tm-day"
            attributes={{ 'data-calendar-date': date, 'data-outside': !date.startsWith(month) || undefined }}
            head={<span className="tm-date">{at(date).getDate()}</span>}
          />
        ))}
      </div>
    </div>
  );
}
