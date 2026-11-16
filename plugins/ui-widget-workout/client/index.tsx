// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityAthleteEvent,
  activityStateChangedEvent,
  athleteProfileState,
  DEFAULT_PROVIDER,
  dataSourceState,
  type Workout,
  workoutFinishedEvent,
  workoutStepChangedEvent,
} from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { defaultPowerZones, type TimelineSegment, workoutTimeline, zoneOf } from '@ridrs/workout';
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Messages } from './i18n/en.ts';
import { messages } from './i18n/index.ts';
import {
  clock,
  countdownAt,
  cueAt,
  type EffortLevel,
  effortBars,
  effortLevel,
  elapsedSeconds,
  type StepView,
  setOf,
  stepView,
  vivid,
  zoneColour,
} from './model.ts';

/** The ride this widget follows: the workout is frozen at the start, the rest is read as it comes. */
interface Ride {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly workout: Workout;
}

interface StepEvent {
  readonly index: number;
  readonly startedAt: number;
}

/** Where the ride's clock stands in the step; refs, because frames must not wait for a render. */
interface Track {
  sessionId?: string;
  stepStartedAt?: number;
  pausedAt?: number;
  pausedMs: number;
}

const NBSP = ' ';

/**
 * Reads the workout of the ride and where the player is in it, and counts the time in the step
 * from the frames' clock. It never drives: the player decides when a step changes.
 */
function useWorkoutRide(ctx: UiContext) {
  const [ride, setRide] = useState<Ride>();
  const [ftpOf, setFtpOf] = useState<{ sessionId: string; ftp: number }>();
  const [step, setStep] = useState<StepEvent>();
  const [finishedAt, setFinishedAt] = useState<number>();
  const [elapsed, setElapsed] = useState(0);
  const track = useRef<Track>({ pausedMs: 0 });

  useEffect(() => {
    const stopState = ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if (payload.state === 'idle' || payload.state === 'finished') {
        track.current = { pausedMs: 0 };
        setRide(undefined);
        return;
      }
      if (track.current.sessionId !== payload.sessionId) {
        track.current = { sessionId: payload.sessionId, pausedMs: 0 };
        setStep(undefined);
        setFinishedAt(undefined);
        setElapsed(0);
      }
      const now = track.current;
      if (payload.state === 'paused') {
        now.pausedAt ??= payload.pausedAt;
      } else if (now.pausedAt !== undefined && payload.resumedAt !== undefined) {
        // The step held while the ride stood: its clock does not count that time.
        now.pausedMs += Math.max(0, payload.resumedAt - now.pausedAt);
        now.pausedAt = undefined;
      }
      const workout = payload.workout?.workout;
      setRide((was) =>
        !workout
          ? undefined
          : was?.sessionId === payload.sessionId
            ? was
            : { sessionId: payload.sessionId, startedAt: payload.startedAt, workout },
      );
    });
    const stopAthlete = ctx.events.subscribe(activityAthleteEvent, ({ payload }) => {
      if (payload.athlete.ftp !== undefined) {
        setFtpOf({ sessionId: payload.sessionId, ftp: payload.athlete.ftp });
      }
    });
    const stopStep = ctx.events.subscribe(workoutStepChangedEvent, ({ payload }) => {
      track.current.stepStartedAt = payload.startedAt;
      track.current.pausedMs = 0;
      setStep({ index: payload.index, startedAt: payload.startedAt });
      setElapsed(0);
    });
    const stopFinished = ctx.events.subscribe(workoutFinishedEvent, ({ payload }) =>
      setFinishedAt(payload.at),
    );
    const stopFrames = ctx.frames.onFrame(({ time }) => {
      const { stepStartedAt, pausedAt, pausedMs } = track.current;
      if (stepStartedAt === undefined) return;
      // Whole seconds only: the chart and the clock need no more, and React skips an equal state.
      setElapsed(elapsedSeconds({ now: time, stepStartedAt, pausedAt, pausedMs }));
    });
    return () => {
      stopState();
      stopAthlete();
      stopStep();
      stopFinished();
      stopFrames();
    };
  }, [ctx]);

  // An event of an earlier ride, replayed to a widget that mounts late, is not this ride's.
  const thisStep = ride && step && step.startedAt >= ride.startedAt ? step : undefined;
  const finished = ride && finishedAt !== undefined && finishedAt >= ride.startedAt;
  const ftp = ride && ftpOf?.sessionId === ride.sessionId ? ftpOf.ftp : undefined;
  return { ride, ftp, step: thisStep, finished: finished === true, elapsed };
}

/**
 * "at 115 % 288 W", "Free ride": what the step asks. Power reads in that order and is spoken so;
 * the eye gets the watts first and large, the % beside them, the "at" not at all.
 */
function Target({ step, text }: { readonly step: StepView; readonly text: Messages }) {
  const { effort } = step;
  if (effort.kind !== 'power') {
    const said = targetText(step, text);
    return said ? <span className="wk-target wk-said">{said}</span> : null;
  }
  return (
    <span className="wk-target">
      <span className="wk-hidden">{text.at}</span>{' '}
      {effort.percent ? <span className="wk-percent">{`${effort.percent}${NBSP}%`}</span> : null}{' '}
      {effort.watts ? <span className="wk-watts">{`${effort.watts}${NBSP}W`}</span> : null}
    </span>
  );
}

function targetText(step: StepView, text: Messages): string | undefined {
  const { effort } = step;
  switch (effort.kind) {
    case 'free':
      return text.freeRide;
    case 'max-effort':
      return text.maxEffort;
    case 'heart-rate':
      return `${text.at} ${text.heartRate(effort.bpm)}`;
    case 'none':
      return undefined;
    case 'power': {
      const percent = effort.percent ? `${effort.percent}${NBSP}%` : undefined;
      const watts = effort.watts ? `${effort.watts}${NBSP}W` : undefined;
      return `${text.at} ${[percent, watts].filter(Boolean).join(' ')}`;
    }
  }
}

function lengthText(step: StepView, text: Messages): string {
  const { duration } = step;
  switch (duration.kind) {
    case 'time':
      return clock(duration.seconds);
    case 'distance':
      return text.distance(duration.meters);
    case 'energy':
      return text.energy(duration.kilocalories);
    case 'open':
      return text.untilNext;
  }
}

/** How many coming steps the ladder lists. */
const LADDER = 4;

/** The glass of the gauges (`ui-hud-gauges`), as a panel: the HUD lies over a video and is always dark. */
const WORKOUT_CSS = `
.wk { box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; padding: 14px 14px 12px;
  border-radius: 22px; border: 1px solid rgb(255 255 255 / .12); color: #f2f5fa;
  background: linear-gradient(165deg, rgb(22 34 56 / .88) 0%, rgb(11 18 32 / .93) 64%, rgb(8 13 24 / .96) 100%);
  box-shadow: 0 20px 45px -12px rgb(0 0 0 / .7), inset 0 1px 1px rgb(255 255 255 / .14), inset 0 -2px 8px rgb(0 0 0 / .6);
  font-family: var(--ridrs-font-text); font-variant-numeric: tabular-nums; line-height: 1.15; dynamic-range-limit: no-limit; }
.wk-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.wk-head { display: flex; align-items: baseline; gap: 10px; padding: 0 4px; }
.wk-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: rgb(242 245 250 / .72); }
.wk-total { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; color: rgb(242 245 250 / .72); }
.wk-total svg { width: 12px; height: 12px; opacity: .8; }
.wk-ribbon { display: flex; align-items: flex-end; gap: 1px; height: 28px; padding: 0 4px; }
.wk-seg { position: relative; flex-basis: 0; min-width: 1px; border-radius: 2px 2px 1px 1px; overflow: hidden;
  background: color-mix(in srgb, var(--hue) 34%, transparent); }
.wk-seg-lit { position: absolute; inset: 0 auto 0 0; background: var(--lit); }
.wk-seg[data-current] { overflow: visible; box-shadow: 0 0 10px -1px var(--lit); }
.wk-seg[data-current]::after { content: ""; position: absolute; left: 0; right: 0; top: -4px; height: 2px;
  border-radius: 1px; background: #f2f5fa; }
.wk-step { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: "now set" "now left" "bar bar"; column-gap: 12px; row-gap: 2px;
  padding: 12px 14px 12px 18px; border-radius: 16px; overflow: hidden;
  background: linear-gradient(100deg, color-mix(in srgb, var(--hue) 24%, transparent), rgb(255 255 255 / .03) 72%);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / .06); }
.wk-step::before { content: ""; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px;
  border-radius: 0 3px 3px 0; background: var(--lit); box-shadow: 0 0 12px var(--lit); }
/* The step reads "NOW 4:00 at 115 % 288 W 95–105 rpm"; the eye gets the watts large, the rest below. */
.wk-now { grid-area: now; display: grid; grid-template-columns: auto auto minmax(0, 1fr);
  grid-template-areas: "tag tag tag" "watts watts watts" "percent len cad"; align-content: start; white-space: nowrap; }
.wk-now .wk-tag { grid-area: tag; margin-bottom: 6px; }
.wk-now .wk-target { display: contents; }
.wk-now .wk-said { display: block; grid-area: watts; font-size: 24px; font-weight: 600; }
.wk-now .wk-watts { grid-area: watts; font-size: 40px; font-weight: 600; letter-spacing: -.02em; line-height: 1; }
.wk-now .wk-percent, .wk-now .wk-len, .wk-now .wk-cad { margin-top: 5px; font-size: 13px; color: rgb(242 245 250 / .72); }
.wk-now .wk-percent { grid-area: percent; }
.wk-now .wk-len { grid-area: len; }
.wk-now .wk-cad { grid-area: cad; overflow: hidden; text-overflow: ellipsis; }
.wk-now:has(.wk-percent) .wk-len::before { content: "\u00a0·\u00a0"; }
.wk-now .wk-cad::before { content: "\u00a0·\u00a0"; }
.wk-tag { font-size: 11px; font-weight: 700; letter-spacing: .12em; color: color-mix(in srgb, var(--hue) 55%, #fff); }
.wk-set { grid-area: set; justify-self: end; font-size: 15px; font-weight: 600; }
.wk-set-of { color: rgb(242 245 250 / .55); }
.wk-left { grid-area: left; justify-self: end; align-self: end; display: flex; align-items: baseline; gap: 5px;
  transition: opacity .2s; }
.wk-left-clock { font-size: 40px; font-weight: 600; letter-spacing: -.02em; line-height: 1; }
.wk-left-word { font-size: 12px; color: rgb(242 245 250 / .6); }
.wk-countdown { position: absolute; right: 14px; bottom: 22px; font-size: 64px; font-weight: 700; line-height: 1;
  color: var(--lit); text-shadow: 0 0 18px var(--lit); }
.wk-step[data-counting] .wk-left { opacity: 0; }
.wk-track { grid-area: bar; height: 6px; margin-top: 10px; border-radius: 3px; overflow: hidden;
  background: color-mix(in srgb, var(--hue) 26%, rgb(255 255 255 / .08)); }
.wk-fill { height: 100%; border-radius: 3px; background: var(--lit); box-shadow: 0 0 10px var(--lit); }
.wk-done { grid-area: now; font-size: 26px; font-weight: 600; }
.wk-note:not(:empty) { margin: -2px 4px 0; padding-left: 10px; border-left: 2px solid var(--lit, #f2f5fa);
  font-size: 15px; font-weight: 500; }
.wk-ladder { list-style: none; margin: 0; padding: 0 4px; display: flex; flex-direction: column; gap: 7px; }
.wk-rung { display: grid; grid-template-columns: 44px minmax(36px, 1fr) auto minmax(54px, auto); align-items: center;
  column-gap: 10px; font-size: 13px; }
.wk-rung:nth-child(2) { opacity: .8; } .wk-rung:nth-child(3) { opacity: .62; } .wk-rung:nth-child(4) { opacity: .46; }
.wk-rung .wk-tag { color: rgb(242 245 250 / .6); }
.wk-rail { height: 8px; border-radius: 4px; background: rgb(255 255 255 / .06); overflow: hidden; }
.wk-bar { height: 100%; border-radius: 4px; background: color-mix(in srgb, var(--hue) 62%, transparent); }
.wk-rung .wk-len { color: rgb(242 245 250 / .72); }
.wk-rung .wk-target { display: flex; justify-content: flex-end; align-items: baseline; gap: 6px; }
.wk-rung .wk-watts { order: -1; font-weight: 600; font-size: 14px; }
.wk-rung .wk-percent { color: rgb(242 245 250 / .55); font-size: 12px; }
.wk-more { padding: 0 4px; font-size: 12px; color: rgb(242 245 250 / .55); }
`;

/** No zone (no FTP, heart rate, free ride): the gauges' neutral blue. */
const NEUTRAL = '#38bdf8';

/** The hue of a zone (dimmed, for `color-mix`) and its light in Display P3. */
function zoneStyle(zone: number | undefined, count: number): CSSProperties {
  const hex = zone === undefined ? NEUTRAL : zoneColour(zone, count);
  return { '--hue': hex, '--lit': vivid(hex) } as CSSProperties;
}

/** The power zones the steps are coloured by: those of the chosen profile, else Coggan's. */
function usePowerZones(ctx: UiContext) {
  const profiles = useStateEntries(ctx, athleteProfileState);
  const chosen = useStateEntries(ctx, dataSourceState).get('athlete.profile')?.provider ?? DEFAULT_PROVIDER;
  const zones = profiles.get(chosen)?.data?.powerZones;
  return useMemo(() => zones ?? defaultPowerZones(), [zones]);
}

/** "1:47 left", "noch 1:47": the clock large and the words small, in the language's order. */
function TimeLeft({ seconds, text }: { readonly seconds: number; readonly text: Messages }) {
  const time = clock(seconds);
  const [before = '', after = ''] = text.left('\u0000').split('\u0000');
  return (
    <div className="wk-left" data-testid="workout-time-left">
      {before.trim() ? <span className="wk-left-word">{before.trim()}</span> : null}{' '}
      <span className="wk-left-clock">{time}</span>{' '}
      {after.trim() ? <span className="wk-left-word">{after.trim()}</span> : null}
    </div>
  );
}

/** One rung of the ladder: a coming step, its bar as long as it is hard. */
function Rung({
  step,
  tag,
  bar,
  zone,
  zoneCount,
  text,
}: {
  readonly step: StepView;
  readonly tag: string | undefined;
  readonly bar: number | undefined;
  readonly zone: number | undefined;
  readonly zoneCount: number;
  readonly text: Messages;
}) {
  return (
    <li className="wk-rung" style={zoneStyle(zone, zoneCount)} {...(tag ? { 'data-testid': 'workout-next' } : {})}>
      <span className="wk-tag">{tag}</span>{' '}
      <span className="wk-rail" aria-hidden="true">
        {bar === undefined ? null : <span className="wk-bar" data-effort-bar="" style={{ display: 'block', width: `${bar}%` }} />}
      </span>{' '}
      <span className="wk-len">{lengthText(step, text)}</span>{' '}
      <Target step={step} text={text} />
    </li>
  );
}

/**
 * The whole workout as a ribbon: each step as wide as it lasts and as high as it is hard, in its
 * zone's colour dimmed, lit up to where the ride is, like the scale of a gauge.
 */
function Ribbon({
  segments,
  bars,
  zones,
  zoneCount,
  progress,
  current,
  label,
}: {
  readonly segments: readonly TimelineSegment[];
  readonly bars: readonly (number | undefined)[];
  readonly zones: readonly (number | undefined)[];
  readonly zoneCount: number;
  readonly progress: number;
  readonly current: number | undefined;
  readonly label: string;
}) {
  return (
    <div className="wk-ribbon" data-testid="workout-ribbon" data-seconds={String(progress)} role="img" aria-label={label}>
      {segments.map((segment, at) => {
        const lit =
          segment.durationSeconds > 0
            ? Math.min(1, Math.max(0, (progress - segment.startSeconds) / segment.durationSeconds))
            : progress >= segment.startSeconds ? 1 : 0;
        return (
          <div
            key={segment.index}
            className="wk-seg"
            data-ribbon-step=""
            data-step-id={segment.stepId}
            data-start-seconds={String(segment.startSeconds)}
            {...(segment.index === current ? { 'data-current': '' } : {})}
            style={{
              ...zoneStyle(zones[at], zoneCount),
              flexGrow: segment.durationSeconds,
              height: `${Math.max(18, bars[at] ?? 30)}%`,
            }}
          >
            {lit > 0 ? <div className="wk-seg-lit" style={{ width: `${lit * 100}%` }} /> : null}
          </div>
        );
      })}
    </div>
  );
}

const CLOCK_ICON = (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M6 3.2V6l1.9 1.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

function WorkoutView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const { ride, ftp, step, finished, elapsed } = useWorkoutRide(ctx);
  const powerZones = usePowerZones(ctx);
  const timeline = useMemo(() => (ride ? workoutTimeline(ride.workout) : undefined), [ride]);
  const levels = useMemo<readonly EffortLevel[]>(
    () => timeline?.segments.map((segment) => effortLevel(segment.effort, ftp)) ?? [],
    [timeline, ftp],
  );
  const bars = useMemo(() => effortBars(levels), [levels]);
  const zones = useMemo(
    () => levels.map((level) => (level.percentFtp === undefined ? undefined : zoneOf(level.percentFtp, powerZones))),
    [levels, powerZones],
  );
  if (!ride || !timeline) return null;

  const zoneCount = powerZones.length;
  const { segments } = timeline;
  const current: TimelineSegment | undefined = step ? segments[step.index] : undefined;
  const firstComing = finished ? segments.length : current ? current.index + 1 : 0;
  const coming = segments.slice(firstComing, firstComing + LADDER);
  const more = segments.length - firstComing - coming.length;
  const upcoming = coming[0];
  const shown = current ?? segments[0];
  const set = shown ? setOf(shown, segments.length) : undefined;
  const view = current ? stepView(current, ftp) : undefined;
  const zone = current ? zones[current.index] : undefined;

  const timed = current?.duration.kind === 'time';
  const inStep = current ? Math.min(elapsed, current.durationSeconds) : 0;
  const remaining = current && timed ? current.durationSeconds - inStep : undefined;
  const cue = current && !finished ? cueAt(current.cues, elapsed) : undefined;
  const countdown = finished ? undefined : countdownAt(remaining, upcoming !== undefined);
  const progress = finished ? timeline.durationSeconds : (current?.startSeconds ?? 0) + inStep;
  const percent = current && timed && current.durationSeconds > 0 ? Math.round((inStep / current.durationSeconds) * 100) : 0;
  const totalLeft = Math.max(0, timeline.durationSeconds - progress);

  let body: ReactNode;
  if (finished) {
    body = (
      <div data-testid="workout-done" role="status" className="wk-done">
        {text.done}
      </div>
    );
  } else {
    body = (
      <>
        {view ? (
          <div data-testid="workout-now" className="wk-now">
            <span className="wk-tag">{text.now}</span>{' '}
            <span className="wk-len">{lengthText(view, text)}</span>{' '}
            <Target step={view} text={text} />{' '}
            {view.cadence ? <span className="wk-cad">{`${view.cadence}${NBSP}${text.rpm}`}</span> : null}
          </div>
        ) : (
          <div data-testid="workout-now" className="wk-now">
            <span className="wk-target" style={{ fontSize: 24 }}>{text.starting}</span>
          </div>
        )}
        {remaining !== undefined ? <TimeLeft seconds={remaining} text={text} /> : null}
        {remaining !== undefined ? (
          <div
            className="wk-track"
            role="progressbar"
            aria-label={text.barLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="wk-fill" data-testid="workout-bar" style={{ width: `${percent}%` }} />
          </div>
        ) : null}
      </>
    );
  }

  return (
    <section
      data-testid="widget-workout"
      data-status="available"
      aria-label={text.title}
      className="wk"
      style={{
        position: 'absolute',
        // Top left, below the window's own buttons, which the Mac app has over the page.
        top: 'var(--ridrs-page-top, 40px)',
        left: 16,
        width: 'clamp(290px, 24vw, 350px)',
        maxHeight: 'calc(100% - var(--ridrs-page-top, 40px) - 16px)',
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <style>{WORKOUT_CSS}</style>
      <header className="wk-head">
        <span className="wk-name" data-testid="workout-name">
          {ride.workout.name}
        </span>
        <span className="wk-total" title={text.totalLeft}>
          {CLOCK_ICON}
          <span className="wk-hidden">{text.totalLeft}</span>
          <span data-testid="workout-total-left">{clock(totalLeft)}</span>
        </span>
      </header>

      <Ribbon
        segments={segments}
        bars={bars}
        zones={zones}
        zoneCount={zoneCount}
        progress={progress}
        current={finished ? undefined : current?.index}
        label={text.ribbonLabel}
      />

      <div
        className="wk-step"
        data-testid="workout-step"
        {...(zone === undefined ? {} : { 'data-zone': String(zone) })}
        {...(countdown === undefined ? {} : { 'data-counting': '' })}
        style={zoneStyle(zone, zoneCount)}
      >
        {body}
        {set && !finished ? (
          <span className="wk-set" data-testid="workout-set" aria-label={text.setLabel(set.at, set.of)}>
            {set.at}
            <span className="wk-set-of">{`/${set.of}`}</span>
          </span>
        ) : null}
        <div
          data-testid="workout-countdown"
          className="wk-countdown"
          role="status"
          aria-label={countdown === undefined ? undefined : text.countdown(countdown)}
        >
          {countdown}
        </div>
      </div>

      <div data-testid="workout-note" role="status" className="wk-note" style={zoneStyle(zone, zoneCount)}>
        {cue?.text}
      </div>

      {coming.length > 0 ? (
        <ol className="wk-ladder" data-testid="workout-coming">
          {coming.map((segment, at) => (
            <Rung
              key={segment.index}
              step={stepView(segment, ftp)}
              tag={at === 0 ? text.next : undefined}
              bar={bars[segment.index]}
              zone={zones[segment.index]}
              zoneCount={zoneCount}
              text={text}
            />
          ))}
        </ol>
      ) : null}
      {more > 0 ? (
        <div className="wk-more" data-testid="workout-more">
          {text.more(more)}
        </div>
      ) : null}
    </section>
  );
}

export const WorkoutWidget: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<WorkoutView ctx={ctx} />);
  return () => root.unmount();
};
