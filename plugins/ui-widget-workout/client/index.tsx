// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityAthleteEvent,
  activityStateChangedEvent,
  type UiCapabilityInput,
  type Workout,
  workoutChartCapability,
  workoutFinishedEvent,
  workoutStepChangedEvent,
} from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { type TimelineSegment, workoutTimeline } from '@ridrs/workout';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Messages } from './i18n/en.ts';
import { messages } from './i18n/index.ts';
import {
  clock,
  countdownAt,
  cueAt,
  elapsedSeconds,
  type StepView,
  setOf,
  stepView,
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

/** "at 115 % 288 W", "Free ride": what the step asks. */
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

/** One line of the plan: the label, how long, what at, and the cadence beside it. */
function StepLine({
  label,
  step,
  text,
  testId,
  size,
  withCadence,
}: {
  readonly label: string;
  readonly step: StepView;
  readonly text: Messages;
  readonly testId: string;
  readonly size: number;
  readonly withCadence: boolean;
}) {
  const target = targetText(step, text);
  const cadence = withCadence && step.cadence ? `${step.cadence}${NBSP}${text.rpm}` : undefined;
  return (
    <div data-testid={testId} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 14px' }}>
      <span className="wk-label" style={{ fontSize: Math.max(13, size * 0.55), opacity: 0.75, minWidth: 64 }}>
        {label}
      </span>{' '}
      <span style={{ fontSize: size, fontWeight: 600 }}>{lengthText(step, text)}</span>{' '}
      {target ? <span style={{ fontSize: size, fontWeight: 600 }}>{target}</span> : null}{' '}
      {cadence ? <span style={{ fontSize: size * 0.8, opacity: 0.9 }}>{cadence}</span> : null}
    </div>
  );
}

type ChartInput = UiCapabilityInput<typeof workoutChartCapability>;

/** The small chart (`ui.workout-chart`, variant `hud`); the mark is where the bus says the ride is. */
function HudChart({
  ctx,
  workout,
  ftp,
  progressSeconds,
}: {
  readonly ctx: UiContext;
  readonly workout: Workout;
  readonly ftp: number | undefined;
  readonly progressSeconds: number;
}) {
  const place = useRef<HTMLDivElement>(null);
  const handle = useRef<ReturnType<typeof ctx.render<typeof workoutChartCapability>>>(undefined);
  const input = useMemo<ChartInput>(
    () => ({ workout, ...(ftp ? { athlete: { ftp } } : {}), variant: 'hud', progressSeconds }),
    [workout, ftp, progressSeconds],
  );
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    const container = place.current;
    if (!container) return undefined;
    try {
      const drawing = ctx.render(workoutChartCapability, container, latest.current);
      handle.current = drawing;
      return () => {
        drawing.release();
        handle.current = undefined;
      };
    } catch (error) {
      ctx.logger.warn(`The workout chart could not be drawn: ${String(error)}`);
      return undefined;
    }
  }, [ctx]);

  // Not on the first render: the drawing was made with this input.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    try {
      handle.current?.update(input);
    } catch (error) {
      ctx.logger.warn(`The workout chart refused its input: ${String(error)}`);
    }
  }, [ctx, input]);

  return <div ref={place} data-testid="workout-hud-chart" style={{ marginTop: 10 }} />;
}

function WorkoutView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const { ride, ftp, step, finished, elapsed } = useWorkoutRide(ctx);
  const timeline = useMemo(() => (ride ? workoutTimeline(ride.workout) : undefined), [ride]);
  if (!ride || !timeline) return null;

  const { segments } = timeline;
  const current: TimelineSegment | undefined = step ? segments[step.index] : undefined;
  const upcoming = finished ? undefined : segments[current ? current.index + 1 : 0];
  const shown = current ?? segments[0];
  const set = shown ? setOf(shown, segments.length) : undefined;
  const view = current ? stepView(current, ftp) : undefined;

  const timed = current?.duration.kind === 'time';
  const inStep = current ? Math.min(elapsed, current.durationSeconds) : 0;
  const remaining = current && timed ? current.durationSeconds - inStep : undefined;
  const cue = current && !finished ? cueAt(current.cues, elapsed) : undefined;
  const countdown = finished ? undefined : countdownAt(remaining, upcoming !== undefined);
  const progress = finished ? timeline.durationSeconds : (current?.startSeconds ?? 0) + inStep;
  const percent = current && timed && current.durationSeconds > 0 ? Math.round((inStep / current.durationSeconds) * 100) : 0;

  const row = (children: ReactNode) => <div style={{ marginTop: 8 }}>{children}</div>;

  return (
    <section
      data-testid="widget-workout"
      data-status="available"
      aria-label={text.title}
      style={{
        position: 'relative',
        pointerEvents: 'none',
        flex: '1 1 420px',
        maxWidth: 640,
        padding: '14px 20px 16px',
        borderRadius: 'var(--ridrs-radius, 14px)',
        background: 'rgba(10, 14, 20, 0.82)',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif',
        boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.08)',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <span className="wk-name" data-testid="workout-name" style={{ fontSize: 18, fontWeight: 500 }}>
          {ride.workout.name}
        </span>
        {set ? (
          <span
            className="wk-label"
            data-testid="workout-set"
            aria-label={text.setLabel(set.at, set.of)}
            style={{ fontSize: 22, fontWeight: 500, color: 'var(--ridrs-accent, #00e5ff)' }}
          >
            {`${set.at}/${set.of}`}
          </span>
        ) : null}
      </header>

      {finished ? (
        row(
          <div data-testid="workout-done" role="status" style={{ fontSize: 34, fontWeight: 500 }}>
            {text.done}
          </div>,
        )
      ) : (
        <>
          {row(
            view ? (
              <StepLine label={text.now} step={view} text={text} testId="workout-now" size={32} withCadence />
            ) : (
              <div data-testid="workout-now" style={{ fontSize: 32, fontWeight: 600 }}>
                {text.starting}
              </div>
            ),
          )}
          {remaining !== undefined ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8 }}>
              <div
                role="progressbar"
                aria-label={text.barLabel}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                style={{ flex: 1, height: 12, borderRadius: 6, background: 'rgba(255,255,255,0.18)', overflow: 'hidden' }}
              >
                <div
                  data-testid="workout-bar"
                  style={{ width: `${percent}%`, height: '100%', background: 'var(--ridrs-accent, #00e5ff)' }}
                />
              </div>
              <span data-testid="workout-time-left" style={{ fontSize: 26, fontWeight: 600, minWidth: 120, textAlign: 'right' }}>
                {text.left(clock(remaining))}
              </span>
            </div>
          ) : null}
          {upcoming ? (
            row(<StepLine label={text.next} step={stepView(upcoming, ftp)} text={text} testId="workout-next" size={20} withCadence={false} />)
          ) : null}
        </>
      )}

      <HudChart ctx={ctx} workout={ride.workout} ftp={ftp} progressSeconds={progress} />

      <div
        data-testid="workout-note"
        role="status"
        style={cue ? { marginTop: 10, fontSize: 24, fontWeight: 500, color: '#ccff00' } : undefined}
      >
        {cue?.text}
      </div>
      <div
        data-testid="workout-countdown"
        role="status"
        aria-label={countdown === undefined ? undefined : text.countdown(countdown)}
        style={
          countdown === undefined
            ? undefined
            : { position: 'absolute', right: 28, top: 10, fontSize: 72, fontWeight: 600, lineHeight: 1, color: '#ccff00' }
        }
      >
        {countdown}
      </div>
    </section>
  );
}

export const WorkoutWidget: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<WorkoutView ctx={ctx} />);
  return () => root.unmount();
};
