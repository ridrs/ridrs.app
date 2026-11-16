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
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Messages } from './i18n/en.ts';
import { messages } from './i18n/index.ts';
import {
  clock,
  countdownAt,
  cueAt,
  type EffortLevel,
  effortLevel,
  elapsedSeconds,
  inkOn,
  spanOf,
  type StepView,
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
  const [paused, setPaused] = useState(false);
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
      setPaused(payload.state === 'paused');
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
  return { ride, ftp, step: thisStep, finished: finished === true, elapsed, paused };
}

/** "288 W", "125 → 188 W", "Free ride", "150 bpm": what a segment asks, watts only. */
function targetText(step: StepView, text: Messages): string {
  const { effort } = step;
  switch (effort.kind) {
    case 'free':
      return text.freeRide;
    case 'max-effort':
      return text.maxEffort;
    case 'heart-rate':
      return text.heartRate(effort.bpm);
    case 'none':
      return '';
    case 'power':
      return effort.watts ? `${effort.watts}${NBSP}W` : effort.percent ? `${effort.percent}${NBSP}%` : '';
  }
}

/** "4 min", "1 min 30 s", "2.5 km": how long a segment lasts. */
function lengthText(step: StepView, text: Messages): string {
  const { duration } = step;
  switch (duration.kind) {
    case 'time':
      return text.span(spanOf(duration.seconds));
    case 'distance':
      return text.distance(duration.meters);
    case 'energy':
      return text.energy(duration.kilocalories);
    case 'open':
      return text.untilNext;
  }
}

/** How many segments follow the current one in the list. */
const COMING = 5;

/** The glass of the gauges (`ui-hud-gauges`), as a panel: the HUD lies over a video and is always dark. */
const WORKOUT_CSS = `
.wk { box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; padding: 12px 10px 10px;
  border-radius: 20px; border: 1px solid rgb(255 255 255 / .12); color: #f2f5fa;
  background: linear-gradient(165deg, rgb(22 34 56 / .88) 0%, rgb(11 18 32 / .93) 64%, rgb(8 13 24 / .96) 100%);
  box-shadow: 0 20px 45px -12px rgb(0 0 0 / .7), inset 0 1px 1px rgb(255 255 255 / .14), inset 0 -2px 8px rgb(0 0 0 / .6);
  font-family: var(--ridrs-font-text); font-variant-numeric: tabular-nums; line-height: 1.15; dynamic-range-limit: no-limit; }
.wk-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.wk-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 2px 12px; padding: 0 6px; }
.wk-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: rgb(242 245 250 / .62); }
.wk-total { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; color: rgb(242 245 250 / .72); }
.wk-total svg { width: 12px; height: 12px; opacity: .8; }
.wk-count { grid-column: 1 / -1; font-size: 30px; font-weight: 700; font-style: italic; letter-spacing: -.02em; line-height: 1; }
.wk-count-of { font-size: 15px; font-weight: 600; color: rgb(242 245 250 / .55); }
.wk-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.wk-row { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; grid-template-areas: "zone len target";
  align-items: center; column-gap: 12px; min-height: 30px; border-radius: 8px; overflow: hidden;
  background: rgb(255 255 255 / .05); font-size: 15px; font-weight: 600; }
/* Done: the row filled in its zone, a little calmer than the current one. */
.wk-row[data-state="done"] { background: color-mix(in oklab, var(--lit) 62%, rgb(70 80 96)); color: var(--ink); }
.wk-row[data-state="done"] .wk-zone { background: none; }
.wk-row[data-state="done"] .wk-len { color: inherit; opacity: .75; }
.wk-zone { grid-area: zone; align-self: stretch; display: grid; place-items: center;
  font-size: 13px; font-weight: 800; background: var(--lit); color: var(--ink); }
/* No zone (no FTP, heart rate, free ride): a quiet edge instead of an empty chip. */
.wk-zone:empty { background: linear-gradient(90deg, var(--lit) 0 3px, color-mix(in srgb, var(--hue) 16%, transparent) 3px); }
.wk-len { grid-area: len; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgb(242 245 250 / .82); }
.wk-target { grid-area: target; padding-right: 12px; white-space: nowrap; }
/*
 * The current row is its own bar: the zone's colour grows from the chip to the right edge as the
 * segment goes by. Its content lies twice: light on the glass below, in the zone's ink on the
 * colour above, cut at the edge of the fill, so every letter reads on either side of it.
 */
.wk-row[data-state="current"] { display: block; position: relative; overflow: visible; background: none; }
.wk-cur { position: relative; border-radius: 8px; overflow: hidden;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / .1), 0 0 20px -6px var(--lit); }
.wk-layer { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto;
  grid-template-areas: "zone clock target" "zone detail target"; align-items: center; column-gap: 12px; row-gap: 1px;
  min-height: 58px; background: color-mix(in srgb, var(--hue) 16%, rgb(255 255 255 / .07)); color: #f2f5fa; }
.wk-layer .wk-zone { font-size: 15px; }
.wk-layer .wk-target { font-size: 21px; font-weight: 700; }
.wk-fill-layer { position: absolute; inset: 0; background: var(--lit); color: var(--ink);
  clip-path: inset(0 calc((100% - 38px) * (1 - var(--p, 0))) 0 0); transition: clip-path 1s linear; }
.wk-fill-layer .wk-zone { background: none; color: inherit; }
.wk-clock { grid-area: clock; align-self: end; position: relative; font-size: 26px; font-weight: 800;
  letter-spacing: -.01em; line-height: 1; padding-top: 8px; }
.wk-detail { grid-area: detail; align-self: start; padding-bottom: 8px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-size: 12px; font-weight: 600; opacity: .72; }
.wk-detail .wk-len { color: inherit; }
.wk-cad:not(:empty)::before { content: " · "; }
.wk-countdown { position: absolute; left: 0; bottom: 0; }
.wk-countdown:empty { display: none; }
.wk-cur[data-counting] .wk-left { visibility: hidden; }
.wk-cur[data-counting] .wk-countdown { animation: wk-tick 1s ease-out infinite; transform-origin: left bottom; }
@keyframes wk-tick { from { transform: scale(1.3); } to { transform: scale(1); } }
/* A cue: for its time in the middle of the screen, a card like the one of a pause. */
.wk-cue { position: absolute; top: 40%; left: 50%; transform: translateX(-50%); box-sizing: border-box;
  width: max-content; max-width: min(70%, 760px); pointer-events: none; text-align: center; }
.wk-cue:empty { display: none; }
.wk-cue-card { display: block; padding: 14px 28px 14px 32px; border-radius: var(--ridrs-radius-lg, 18px);
  background: var(--ridrs-card, rgb(14 22 38 / .92)); color: var(--ridrs-text, #f2f5fa);
  box-shadow: inset 4px 0 0 var(--lit), var(--ridrs-edge, inset 0 1px 1px rgb(255 255 255 / .14)), var(--ridrs-shadow, 0 20px 45px -12px rgb(0 0 0 / .7));
  font-family: var(--ridrs-font-display, var(--ridrs-font-text)); font-style: italic; font-weight: 600;
  font-size: clamp(22px, 2.4vw, 34px); line-height: 1.2; text-wrap: balance;
  animation: wk-cue-in .28s ease-out; }
@keyframes wk-cue-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .wk-cue-card { animation: none; }
  .wk-fill-layer { transition: none; }
  .wk-cur[data-counting] .wk-countdown { animation: none; }
}
.wk-done { padding: 6px; font-size: 22px; font-weight: 600; }
`;

/** No zone (no FTP, heart rate, free ride): the gauges' neutral blue. */
const NEUTRAL = '#38bdf8';

/** The hue of a zone (dimmed, for `color-mix`), its light in Display P3 and the ink on it. */
function zoneStyle(zone: number | undefined, count: number): CSSProperties {
  const hex = zone === undefined ? NEUTRAL : zoneColour(zone, count);
  return { '--hue': hex, '--lit': vivid(hex), '--ink': inkOn(hex) } as CSSProperties;
}

/** The power zones the steps are coloured by: those of the chosen profile, else Coggan's. */
function usePowerZones(ctx: UiContext) {
  const profiles = useStateEntries(ctx, athleteProfileState);
  const chosen = useStateEntries(ctx, dataSourceState).get('athlete.profile')?.provider ?? DEFAULT_PROVIDER;
  const zones = profiles.get(chosen)?.data?.powerZones;
  return useMemo(() => zones ?? defaultPowerZones(), [zones]);
}

/** Where the ride stands in the current segment: the time left in it, its fill and 3-2-1. */
interface Live {
  readonly remaining: number | undefined;
  readonly percent: number;
  readonly countdown: number | undefined;
}

/** One segment: its zone, length and target; the current one also its cadence and its fill. */
function Row({
  step,
  state,
  zone,
  zoneCount,
  live,
  text,
}: {
  readonly step: StepView;
  readonly state: 'done' | 'current' | 'coming';
  readonly zone: number | undefined;
  readonly zoneCount: number;
  readonly live?: Live;
  readonly text: Messages;
}) {
  const parts = (
    <>
      <span className="wk-zone" data-part="zone">
        {zone === undefined ? '' : `Z${zone}`}
      </span>{' '}
      <span className="wk-len" data-part="length">
        {lengthText(step, text)}
      </span>{' '}
      <span className="wk-target" data-part="target">
        {targetText(step, text)}
      </span>
    </>
  );
  if (!live) {
    return (
      <li className="wk-row" data-state={state} style={zoneStyle(zone, zoneCount)}>
        {parts}
      </li>
    );
  }
  const { remaining, percent, countdown } = live;
  const zoneText = zone === undefined ? '' : `Z${zone}`;
  const cadence = step.cadence ? `${step.cadence}${NBSP}${text.rpm}` : '';
  // The same content twice; only the lower one is read out and tested, the upper one is paint.
  const layer = (marked: boolean) => (
    <>
      <span className="wk-zone" {...(marked ? { 'data-part': 'zone' } : {})}>
        {zoneText}
      </span>
      <span className="wk-clock">
        <span className="wk-left" {...(marked ? { 'data-testid': 'workout-time-left', 'aria-hidden': true } : {})}>
          {remaining === undefined ? lengthText(step, text) : clock(remaining)}
        </span>
        <span
          className="wk-countdown"
          {...(marked
            ? {
                'data-testid': 'workout-countdown',
                role: 'status',
                'aria-label': countdown === undefined ? undefined : text.countdown(countdown),
              }
            : {})}
        >
          {countdown}
        </span>
      </span>
      <span className="wk-target" {...(marked ? { 'data-part': 'target' } : {})}>
        {targetText(step, text)}
      </span>
      <span className="wk-detail">
        <span className="wk-len" {...(marked ? { 'data-part': 'length' } : {})}>
          {remaining === undefined ? '' : lengthText(step, text)}
        </span>
        <span className="wk-cad" {...(marked ? { 'data-testid': 'workout-cadence' } : {})}>
          {cadence}
        </span>
      </span>
    </>
  );
  return (
    <li
      className="wk-row"
      data-state={state}
      data-testid="workout-step"
      {...(zone === undefined ? {} : { 'data-zone': String(zone) })}
      style={zoneStyle(zone, zoneCount)}
    >
      <div
        className="wk-cur"
        data-testid="workout-now"
        {...(countdown === undefined ? {} : { 'data-counting': '' })}
        style={{ '--p': String(percent / 100) } as CSSProperties}
        {...(remaining === undefined
          ? {}
          : {
              role: 'progressbar',
              'aria-label': text.barLabel,
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': percent,
              'aria-valuetext': text.left(clock(remaining)),
            })}
      >
        <div className="wk-layer">{layer(true)}</div>
        <div className="wk-layer wk-fill-layer" aria-hidden="true">
          {layer(false)}
        </div>
      </div>
    </li>
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
  const { ride, ftp, step, finished, elapsed, paused } = useWorkoutRide(ctx);
  const powerZones = usePowerZones(ctx);
  const timeline = useMemo(() => (ride ? workoutTimeline(ride.workout) : undefined), [ride]);
  const levels = useMemo<readonly EffortLevel[]>(
    () => timeline?.segments.map((segment) => effortLevel(segment.effort, ftp)) ?? [],
    [timeline, ftp],
  );
  const zones = useMemo(
    () => levels.map((level) => (level.percentFtp === undefined ? undefined : zoneOf(level.percentFtp, powerZones))),
    [levels, powerZones],
  );
  if (!ride || !timeline) return null;

  const zoneCount = powerZones.length;
  const { segments } = timeline;
  const current: TimelineSegment | undefined = finished || !step ? undefined : segments[step.index];
  const at = finished ? segments.length : current ? current.index + 1 : 0;
  // The segment just ridden, the current one and the next five.
  const first = current ? Math.max(0, current.index - 1) : at;
  const shown = finished ? [] : segments.slice(first, at + COMING);

  const currentZone = current ? zones[current.index] : undefined;
  const timed = current?.duration.kind === 'time';
  const inStep = current ? Math.min(elapsed, current.durationSeconds) : 0;
  const remaining = current && timed ? current.durationSeconds - inStep : undefined;
  const live: Live | undefined = current
    ? {
        remaining,
        percent: timed && current.durationSeconds > 0 ? Math.round((inStep / current.durationSeconds) * 100) : 0,
        countdown: countdownAt(remaining, current.index + 1 < segments.length),
      }
    : undefined;
  // A cue shows for its time in the middle of the screen; a pause has that place to itself.
  const note = current && !paused ? cueAt(current.cues, elapsed)?.text : undefined;
  const progress = finished ? timeline.durationSeconds : (current?.startSeconds ?? 0) + inStep;
  const totalLeft = Math.max(0, timeline.durationSeconds - progress);

  return (
    <>
      <style>{WORKOUT_CSS}</style>
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
        width: 'clamp(260px, 21vw, 310px)',
        maxHeight: 'calc(100% - var(--ridrs-page-top, 40px) - 16px)',
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <header className="wk-head">
        <span className="wk-name" data-testid="workout-name">
          {ride.workout.name}
        </span>
        <span className="wk-total" title={text.totalLeft}>
          {CLOCK_ICON}
          <span className="wk-hidden">{text.totalLeft}</span>
          <span data-testid="workout-total-left">{clock(totalLeft)}</span>
        </span>
        <span className="wk-count" data-testid="workout-position" aria-label={text.positionLabel(at, segments.length)}>
          {at}
          <span className="wk-count-of">{`/${segments.length}`}</span>
        </span>
      </header>

      {finished ? (
        <div data-testid="workout-done" role="status" className="wk-done">
          {text.done}
        </div>
      ) : (
        <ol className="wk-list" data-testid="workout-segments" aria-label={text.segmentsLabel}>
          {shown.map((segment) => (
            <Row
              key={segment.index}
              step={stepView(segment, ftp)}
              state={segment === current ? 'current' : segment.index < at ? 'done' : 'coming'}
              zone={zones[segment.index]}
              zoneCount={zoneCount}
              {...(segment === current && live ? { live } : {})}
              text={text}
            />
          ))}
        </ol>
      )}
    </section>
    <div className="wk-cue" data-testid="workout-note" role="status" style={zoneStyle(currentZone, zoneCount)}>
      {note ? (
        <span key={note} className="wk-cue-card">
          {note}
        </span>
      ) : null}
    </div>
    </>
  );
}

export const WorkoutWidget: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<WorkoutView ctx={ctx} />);
  return () => root.unmount();
};
