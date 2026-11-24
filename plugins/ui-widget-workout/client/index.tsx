// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityAthleteEvent,
  activityStateChangedEvent,
  athleteProfileState,
  DEFAULT_PROVIDER,
  dataSourceState,
  WORKOUT_INTENSITY,
  type Workout,
  workoutFinishedEvent,
  workoutIntensityChangedEvent,
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
  scaledEffort,
  spanOf,
  type StepView,
  stepView,
  vivid,
  zoneColour,
} from './model.ts';

/** The ride this widget follows: its workout may be loaded or switched during the ride (ADR 0108). */
interface Ride {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly loadedAt: number;
  readonly key: string;
  readonly workout: Workout;
}

interface StepEvent {
  readonly index: number;
  readonly startedAt: number;
}

/** Where the ride's clock stands in the step; refs, because frames must not wait for a render. */
interface Track {
  sessionId?: string;
  workoutKey?: string;
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
  const [intensity, setIntensity] = useState<{ at: number; percent: number }>();
  const track = useRef<Track>({ pausedMs: 0 });

  useEffect(() => {
    const stopState = ctx.events.subscribe(activityStateChangedEvent, ({ payload, timestamp }) => {
      if (payload.state === 'idle' || payload.state === 'finished') {
        track.current = { pausedMs: 0 };
        setRide(undefined);
        return;
      }
      const workout = payload.workout?.workout;
      const key = workout ? JSON.stringify(workout) : undefined;
      const newSession = track.current.sessionId !== payload.sessionId;
      if (newSession || track.current.workoutKey !== key) {
        track.current = {
          sessionId: payload.sessionId,
          ...(key === undefined ? {} : { workoutKey: key }),
          pausedMs: 0,
        };
        setStep(undefined);
        setFinishedAt(undefined);
        setIntensity(undefined);
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
      setRide((was) =>
        !workout || !key
          ? undefined
          : was?.sessionId === payload.sessionId && was.key === key
            ? was
            : {
                sessionId: payload.sessionId,
                startedAt: payload.startedAt,
                loadedAt: was?.sessionId === payload.sessionId ? timestamp : payload.startedAt,
                key,
                workout,
              },
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
    const stopIntensity = ctx.events.subscribe(workoutIntensityChangedEvent, ({ payload, timestamp }) =>
      setIntensity({ at: timestamp, percent: payload.percent }),
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
      stopIntensity();
      stopFrames();
    };
  }, [ctx]);

  // An event of an earlier ride or an earlier workout in this ride is ignored.
  const thisStep = ride && step && step.startedAt >= ride.loadedAt ? step : undefined;
  const finished =
    ride &&
    finishedAt !== undefined &&
    finishedAt >= ride.loadedAt &&
    (thisStep === undefined || finishedAt >= thisStep.startedAt);
  const ftp = ride && ftpOf?.sessionId === ride.sessionId ? ftpOf.ftp : undefined;
  // Every loaded workout starts at 100 %; an intensity of an earlier workout is ignored.
  const percent =
    ride && intensity && intensity.at >= ride.loadedAt ? intensity.percent : WORKOUT_INTENSITY.default;
  return { ride, ftp, step: thisStep, finished: finished === true, elapsed, paused, intensity: percent };
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

/**
 * Shared frosted dark HUD cockpit look matching `ui-hud-gauges` (`HUD_PANEL_GLASS`):
 * 16 px outer radius (`--ridrs-radius-lg`), 11 px mono labels, tabular Sans values, Chakra Petch
 * italic gaming accents on zone badges and countdowns, and a single crisp readable text layer on
 * the active interval row.
 */
const WORKOUT_CSS = `
.wk { box-sizing: border-box; display: flex; flex-direction: column; gap: 9px; padding: 11px 10px 10px;
  color: var(--ridrs-text, #f1f5f9); font-family: var(--ridrs-font-text); font-variant-numeric: tabular-nums;
  line-height: 1.15; dynamic-range-limit: no-limit; }
.wk-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.wk-kicker { font-family: var(--ridrs-font-mono); font-size: var(--ridrs-size-label, 11px); font-weight: 500;
  letter-spacing: .1em; text-transform: uppercase; color: var(--ridrs-info, #00f0ff); line-height: 1.15; }
.wk-head { display: flex; flex-direction: column; gap: 4px; padding: 0 4px 2px; }
.wk-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.wk-step-group { display: inline-flex; align-items: baseline; gap: 6px; }
.wk-pos { font-family: var(--ridrs-font-display, var(--ridrs-font-text)); font-style: italic; font-size: 14px;
  font-weight: 600; letter-spacing: .02em; color: #ffffff; line-height: 1; }
.wk-pos-of { font-size: 12px; font-weight: 500; color: var(--ridrs-text-muted, #b0bdd1); }
.wk-total { display: inline-flex; align-items: center; gap: 5px; font-family: var(--ridrs-font-mono);
  font-size: 12px; font-weight: 500; color: var(--ridrs-text-muted, #b0bdd1); }
.wk-total svg { width: 12px; height: 12px; opacity: .82; }
.wk-heading { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 14px; font-weight: 500; line-height: 1.25; color: #f1f5f9; }
.wk-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.wk-row { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; grid-template-areas: "zone len target";
  align-items: center; column-gap: 10px; min-height: 30px; border-radius: var(--ridrs-radius-sm, 8px); overflow: hidden;
  background: rgb(5 9 18 / .52); box-shadow: inset 0 0 0 1px rgb(255 255 255 / .07); font-size: 13px; font-weight: 500; }
.wk-row[data-state="done"] { background: rgb(5 9 18 / .34); box-shadow: inset 0 0 0 1px rgb(255 255 255 / .04);
  opacity: .52; }
.wk-row[data-state="done"] .wk-zone { background: color-mix(in srgb, var(--hue) 28%, rgb(15 23 42));
  color: #e2e8f0; box-shadow: inset 3px 0 0 var(--lit); }
.wk-zone { grid-area: zone; align-self: stretch; display: grid; place-items: center;
  font-family: var(--ridrs-font-display, var(--ridrs-font-text)); font-style: italic; font-size: 12px; font-weight: 600;
  letter-spacing: .03em; background: var(--lit); color: var(--ink); }
.wk-zone:empty { background: linear-gradient(90deg, var(--lit) 0 3px, color-mix(in srgb, var(--hue) 18%, transparent) 3px); }
.wk-len { grid-area: len; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--ridrs-text-muted, #b0bdd1); }
.wk-target { grid-area: target; padding-right: 10px; white-space: nowrap; font-size: 14px; font-weight: 500;
  color: #f1f5f9; }
/*
 * The active interval row: dark glass card accented in the step's zone, a single high-contrast
 * white text layer (never split across two colours), and a glowing Display-P3 progress bar along
 * its bottom edge.
 */
.wk-row[data-state="current"] { display: block; position: relative; overflow: visible; background: none; box-shadow: none; }
.wk-cur { position: relative; border-radius: 10px; overflow: hidden;
  background: linear-gradient(90deg, color-mix(in srgb, var(--hue) 24%, rgb(14 22 38 / .94)) 0%, rgb(9 15 28 / .9) 100%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 56%, rgb(255 255 255 / .2)), 0 8px 20px -6px rgb(0 0 0 / .55); }
.wk-wash { position: absolute; inset: 0 auto 0 36px; width: calc((100% - 36px) * var(--p, 0));
  background: linear-gradient(90deg, color-mix(in srgb, var(--hue) 22%, transparent), color-mix(in srgb, var(--hue) 8%, transparent));
  transition: width 1s linear; pointer-events: none; }
.wk-bar { position: absolute; left: 36px; bottom: 0; height: 3px; width: calc((100% - 36px) * var(--p, 0));
  background: var(--lit); box-shadow: 0 0 10px var(--lit); transition: width 1s linear; pointer-events: none; }
.wk-layer { position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr) auto;
  grid-template-areas: "zone clock target" "zone detail target"; align-items: center; column-gap: 11px; row-gap: 2px;
  min-height: 54px; color: #ffffff; }
.wk-layer .wk-zone { font-size: 14px; }
.wk-layer .wk-target { font-size: 20px; font-weight: 500; letter-spacing: -.015em; color: #ffffff; padding-right: 12px; }
.wk-clock { grid-area: clock; align-self: end; position: relative; font-size: 20px; font-weight: 500;
  letter-spacing: -.015em; line-height: 1.05; padding-top: 7px; color: #ffffff; }
.wk-detail { grid-area: detail; align-self: start; padding-bottom: 8px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-size: 12px; font-weight: 500; color: var(--ridrs-text-muted, #b0bdd1); }
.wk-detail .wk-len { color: inherit; }
.wk-cad:not(:empty)::before { content: " · "; }
.wk-countdown { position: absolute; left: 0; bottom: 0; font-family: var(--ridrs-font-display, var(--ridrs-font-text));
  font-style: italic; font-size: 22px; font-weight: 600; color: var(--ridrs-accent, #ccff00); }
.wk-countdown:empty { display: none; }
.wk-cur[data-counting] .wk-left { visibility: hidden; }
.wk-cur[data-counting] .wk-countdown { animation: wk-tick 1s ease-out infinite; transform-origin: left bottom; }
@keyframes wk-tick { from { transform: scale(1.28); } to { transform: scale(1); } }
/* A cue: for its time in the middle of the screen, a frosted cockpit banner with zone bar. */
.wk-cue { position: absolute; top: 40%; left: 50%; transform: translateX(-50%); box-sizing: border-box;
  width: max-content; max-width: min(70%, 760px); pointer-events: none; text-align: center; }
.wk-cue:empty { display: none; }
.wk-cue-card { display: block; padding: 14px 28px 14px 32px; border-radius: var(--ridrs-radius-lg, 16px);
  background-color: rgb(10 16 28 / .78);
  background-image: linear-gradient(180deg, rgb(28 44 72 / .34) 0%, rgb(5 9 18 / .42) 100%);
  backdrop-filter: blur(16px) saturate(145%); -webkit-backdrop-filter: blur(16px) saturate(145%);
  color: #ffffff;
  box-shadow: inset 4px 0 0 var(--lit), inset 0 1px 0 rgb(255 255 255 / .2), inset 0 0 0 1px rgb(255 255 255 / .12), 0 20px 45px -12px rgb(0 0 0 / .65);
  font-family: var(--ridrs-font-display, var(--ridrs-font-text)); font-style: italic; font-weight: 600;
  font-size: clamp(22px, 2.4vw, 34px); line-height: 1.2; text-wrap: balance;
  animation: wk-cue-in .28s ease-out; }
@keyframes wk-cue-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .wk-cue-card { animation: none; }
  .wk-wash, .wk-bar { transition: none; }
  .wk-cur[data-counting] .wk-countdown { animation: none; }
}
.wk-done { padding: 8px 6px; font-family: var(--ridrs-font-display, var(--ridrs-font-text)); font-style: italic;
  font-size: 18px; font-weight: 600; color: var(--ridrs-accent, #ccff00); }
/* The workout's intensity, below the last segment: quiet at 100 %, volt pill when adjusted. */
.wk-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 4px 0;
  border-top: 1px solid rgb(255 255 255 / .1); }
.wk-int-val { font-size: 13px; font-weight: 500; color: var(--ridrs-text-muted, #b0bdd1); }
.wk-foot[data-changed] .wk-int-val { padding: 2px 8px; border-radius: var(--ridrs-radius-pill, 999px);
  background: rgb(204 255 0 / .14); box-shadow: inset 0 0 0 1px rgb(204 255 0 / .38);
  color: var(--ridrs-accent, #ccff00); }
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

/** One segment: its zone, length and target; the current one also its cadence and bottom progress bar. */
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
  if (!live) {
    return (
      <li className="wk-row" data-state={state} style={zoneStyle(zone, zoneCount)}>
        <span className="wk-zone" data-part="zone">
          {zone === undefined ? '' : `Z${zone}`}
        </span>{' '}
        <span className="wk-len" data-part="length">
          {lengthText(step, text)}
        </span>{' '}
        <span className="wk-target" data-part="target">
          {targetText(step, text)}
        </span>
      </li>
    );
  }
  const { remaining, percent, countdown } = live;
  const zoneText = zone === undefined ? '' : `Z${zone}`;
  const cadence = step.cadence ? `${step.cadence}${NBSP}${text.rpm}` : '';

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
        <div className="wk-wash" aria-hidden="true" />
        <div className="wk-layer">
          <span className="wk-zone" data-part="zone">
            {zoneText}
          </span>
          <span className="wk-clock">
            <span className="wk-left" data-testid="workout-time-left" aria-hidden={true}>
              {remaining === undefined ? lengthText(step, text) : clock(remaining)}
            </span>
            <span
              className="wk-countdown"
              data-testid="workout-countdown"
              role="status"
              aria-label={countdown === undefined ? undefined : text.countdown(countdown)}
            >
              {countdown}
            </span>
          </span>
          <span className="wk-target" data-part="target">
            {targetText(step, text)}
          </span>
          <span className="wk-detail">
            <span className="wk-len" data-part="length">
              {remaining === undefined ? '' : lengthText(step, text)}
            </span>
            <span className="wk-cad" data-testid="workout-cadence">
              {cadence}
            </span>
          </span>
        </div>
        <div className="wk-bar" aria-hidden="true" />
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
  const { ride, ftp, step, finished, elapsed, paused, intensity } = useWorkoutRide(ctx);
  const powerZones = usePowerZones(ctx);
  const timeline = useMemo(() => {
    if (!ride) return undefined;
    // The targets as the trainer holds them: at the workout's intensity.
    const plain = workoutTimeline(ride.workout);
    return {
      ...plain,
      segments: plain.segments.map((segment) => ({ ...segment, effort: scaledEffort(segment.effort, intensity) })),
    };
  }, [ride, intensity]);
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
          width: 'clamp(268px, 21vw, 304px)',
          maxHeight: 'calc(100% - var(--ridrs-page-top, 40px) - 16px)',
          overflow: 'hidden',
          borderRadius: 'var(--ridrs-radius-lg)',
          backgroundColor: 'rgb(10 16 28 / .68)',
          backgroundImage:
            'linear-gradient(180deg, rgb(28 44 72 / .34) 0%, rgb(11 18 32 / .18) 44%, rgb(5 9 18 / .38) 100%)',
          backdropFilter: 'blur(16px) saturate(145%)',
          WebkitBackdropFilter: 'blur(16px) saturate(145%)',
          boxShadow:
            '0 18px 42px -10px rgb(0 0 0 / .58), inset 0 1px 0 rgb(255 255 255 / .2), inset 0 0 0 1px rgb(255 255 255 / .12)',
          pointerEvents: 'none',
        }}
      >
        <header className="wk-head">
          <div className="wk-meta">
            <span className="wk-step-group">
              <span className="wk-kicker" data-testid="workout-step-label">
                {text.step}
              </span>
              <span
                className="wk-pos"
                data-testid="workout-position"
                aria-label={text.positionLabel(at, segments.length)}
              >
                {at}
                <span className="wk-pos-of">{`/${segments.length}`}</span>
              </span>
            </span>
            <span className="wk-total" title={text.totalLeft}>
              {CLOCK_ICON}
              <span className="wk-hidden">{text.totalLeft}</span>
              <span data-testid="workout-total-left">{clock(totalLeft)}</span>
            </span>
          </div>
          <span className="wk-heading" data-testid="workout-name">
            {ride.workout.name}
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
        <footer
          className="wk-foot"
          data-testid="workout-intensity"
          {...(intensity === WORKOUT_INTENSITY.default ? {} : { 'data-changed': '' })}
        >
          <span className="wk-kicker">{text.intensity}</span>{' '}
          <span className="wk-int-val">{`${intensity}${NBSP}%`}</span>
        </footer>
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
