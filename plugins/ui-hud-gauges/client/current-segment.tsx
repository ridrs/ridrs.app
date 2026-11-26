// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  type Language,
  type PhysicsState,
  type RouteOffer,
  type TerrainPreview,
  type WorldPosition,
  workoutFinishedEvent,
  workoutHaltChangedEvent,
  workoutIntensityChangedEvent,
  workoutStepChangedEvent,
} from '@ridrs/contracts';
import type { TrackPosition } from '@ridrs/ride';
import { formatDecimal, localizeNumber, type UiContext } from '@ridrs/ui-sdk';
import { type CSSProperties, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HUD_LABEL, HUD_UNIT } from './hud-style.ts';
import type { Messages } from './i18n/en.ts';
import {
  type ActiveWorkoutStepInfo,
  formatDuration,
  type GaugeTarget,
  WorkoutTargetTracker,
} from './model.ts';
import { useTrackOffset } from './ride-route.ts';
import { gradeTextColour, measureTrack, polyline } from './route.ts';
import {
  type ActiveClimb,
  activeClimbOf,
  elevationAt,
  elevationPointsOf,
  isFlatTerrain,
  LOCAL_LOOKAHEAD_M,
  LOCAL_LOOKBACK_M,
  type LocalProfile,
  localProfileOf,
  perimeterRing,
  type RouteClimb,
  WORKOUT_RING_SEGMENTS,
} from './segment.ts';

const PROFILE = { width: 320, height: 36 } as const;
const RING_STROKE = 2.5;
const RING_RADIUS = 14;
const FALLBACK_RING_SIZE = { width: 356, height: 124 } as const;
const EN_DASH = '–';

const VALUE_SECONDARY: CSSProperties = {
  fontSize: 20,
  fontWeight: 500,
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: '-.015em',
  lineHeight: 1.08,
  color: '#ffffff',
};

export interface WorkoutSegmentState {
  readonly power: GaugeTarget | undefined;
  readonly cadence: GaugeTarget | undefined;
  readonly step: ActiveWorkoutStepInfo | undefined;
}

/**
 * Tracks the active workout step's targets, remaining/total time and ring progress for the central
 * HUD, updating on step/intensity/state events and on animation frames while a step is running.
 */
export function useWorkoutSegment(
  ctx: UiContext,
  ftp: number | undefined,
): WorkoutSegmentState {
  const tracker = useRef(new WorkoutTargetTracker());
  const clock = useRef(0);
  const [snapshot, setSnapshot] = useState<WorkoutSegmentState>({
    power: undefined,
    cadence: undefined,
    step: undefined,
  });

  tracker.current.setFtp(ftp);

  const commit = useCallback((at: number, currentFtp?: number) => {
    const targets = tracker.current.at(at, currentFtp);
    const step = tracker.current.stepAt(at);
    setSnapshot((prev) => {
      if (
        prev.step?.index === step?.index &&
        prev.step?.elapsedSeconds === step?.elapsedSeconds &&
        prev.step?.durationSeconds === step?.durationSeconds &&
        prev.step?.running === step?.running &&
        Math.round((prev.step?.progress ?? 0) * WORKOUT_RING_SEGMENTS) ===
          Math.round((step?.progress ?? 0) * WORKOUT_RING_SEGMENTS) &&
        Math.round(prev.power?.low ?? -1) === Math.round(targets.power?.low ?? -1) &&
        Math.round(prev.power?.high ?? -1) === Math.round(targets.power?.high ?? -1) &&
        Math.round(prev.cadence?.low ?? -1) === Math.round(targets.cadence?.low ?? -1) &&
        Math.round(prev.cadence?.high ?? -1) === Math.round(targets.cadence?.high ?? -1)
      ) {
        return prev;
      }
      return { power: targets.power, cadence: targets.cadence, step };
    });
  }, []);

  useLayoutEffect(() => {
    const sync = (at: number) => {
      clock.current = Math.max(clock.current, at);
      commit(clock.current);
    };
    const stopState = ctx.events.subscribe(activityStateChangedEvent, ({ payload, timestamp }) => {
      tracker.current.activity(payload);
      if (payload.state !== 'idle' && payload.state !== 'finished') {
        clock.current = payload.startedAt;
      }
      sync(timestamp);
    });
    const stopStep = ctx.events.subscribe(workoutStepChangedEvent, ({ payload }) => {
      tracker.current.stepChanged(payload);
      sync(payload.startedAt);
    });
    const stopFinished = ctx.events.subscribe(workoutFinishedEvent, ({ payload }) => {
      tracker.current.finished(payload);
      sync(payload.at);
    });
    const stopHalt = ctx.events.subscribe(workoutHaltChangedEvent, ({ payload, timestamp }) => {
      tracker.current.haltChanged(payload, timestamp);
      sync(timestamp);
    });
    const stopIntensity = ctx.events.subscribe(
      workoutIntensityChangedEvent,
      ({ payload, timestamp }) => {
        tracker.current.intensityChanged(payload, timestamp);
        sync(timestamp);
      },
    );
    return () => {
      stopState();
      stopStep();
      stopFinished();
      stopHalt();
      stopIntensity();
    };
  }, [ctx, commit]);

  useEffect(() => {
    commit(clock.current, ftp);
  }, [ftp, commit]);

  const running = snapshot.step?.running === true;
  useEffect(() => {
    if (!running) return undefined;
    return ctx.frames.onFrame(({ time }) => {
      clock.current = time;
      commit(time);
    });
  }, [ctx, running, commit]);

  return snapshot;
}

/** Formats a target value or range (e.g. `288` or `95–105`). */
function formatTarget(target: GaugeTarget): string {
  const low = Math.round(target.low);
  const high = Math.round(target.high);
  return low === high ? String(low) : `${low}–${high}`;
}

/** Formats a signed gradient percentage (`+4.5`, `-8.0`, `0.0`). */
function formatGrade(percent: number, language: Language): string {
  const rounded = Number(percent.toFixed(1));
  const abs = localizeNumber(formatDecimal(Math.abs(rounded), 1), language);
  if (rounded > 0) return `+${abs}`;
  if (rounded < 0) return `-${abs}`;
  return abs;
}

/** Formats remaining climb distance (`1.4 km` or `320 m`) before the 10 s countdown begins. */
function formatClimbDistance(meters: number, language: Language): string {
  if (meters >= 1000) {
    return `${localizeNumber(formatDecimal(meters / 1000, 1), language)} km`;
  }
  return `${Math.round(meters)} m`;
}

/** Flat typographic accent colour by climb category (HC / 1 coral-red, 2 / 3 amber, 4 cyan). */
function climbCategoryColour(category: RouteClimb['category']): string {
  if (category === 'HC' || category === '1') return '#ff7a8a';
  if (category === '2' || category === '3') return 'var(--ridrs-warn)';
  return 'var(--ridrs-info)';
}

/** Fine-segmented rounded-rectangle progress ring hugging the outer border of `ride-facts`. */
export function WorkoutProgressRing({
  hostRef,
  progress,
}: {
  readonly hostRef: React.RefObject<HTMLElement | null>;
  readonly progress: number;
}) {
  const [size, setSize] = useState<{ readonly width: number; readonly height: number }>(
    FALLBACK_RING_SIZE,
  );

  useLayoutEffect(() => {
    const node = hostRef.current;
    if (!node) return undefined;
    const measure = () => {
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      if (width > 0 && height > 0) {
        setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [hostRef]);

  const width = size.width + RING_STROKE * 2;
  const height = size.height + RING_STROKE * 2;
  const ring = useMemo(
    () => perimeterRing(width, height, RING_RADIUS, RING_STROKE, WORKOUT_RING_SEGMENTS, progress),
    [width, height, progress],
  );

  return (
    <svg
      data-testid="workout-progress-ring"
      data-segments={String(ring.segments)}
      data-filled={String(ring.filled)}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: -RING_STROKE,
        width: `calc(100% + ${RING_STROKE * 2}px)`,
        height: `calc(100% + ${RING_STROKE * 2}px)`,
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      {Array.from({ length: ring.segments }, (_, i) => {
        const offset = i * (ring.segmentLength + ring.gap);
        const lit = i < ring.filled;
        return (
          <path
            key={offset}
            d={ring.path}
            fill="none"
            stroke={lit ? 'var(--ridrs-accent)' : 'rgb(255 255 255 / .14)'}
            strokeWidth={RING_STROKE}
            strokeLinecap="butt"
            strokeDasharray={`${ring.segmentLength.toFixed(1)} ${ring.perimeter.toFixed(1)}`}
            strokeDashoffset={(-offset).toFixed(1)}
          />
        );
      })}
    </svg>
  );
}

/** Frameless local elevation profile whose terrain dissolves cleanly into the glass via a vertical mask. */
function LocalElevationProfile({
  profile,
  summitEdge,
}: {
  readonly profile: LocalProfile;
  readonly summitEdge: boolean;
}) {
  const id = useId().replace(/[^A-Za-z0-9-]/g, '');
  const fadeId = `seg-fade-${id}`;
  const maskId = `seg-mask-${id}`;
  const riderShare = profile.rider.x / PROFILE.width;

  return (
    <svg
      data-testid="segment-profile"
      {...(summitEdge ? { 'data-summit-edge': 'true' } : {})}
      viewBox={`0 0 ${PROFILE.width} ${PROFILE.height}`}
      width="100%"
      height={PROFILE.height}
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <defs>
        <linearGradient id={fadeId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity={0.72} />
          <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
        </linearGradient>
        <mask id={maskId}>
          <rect x={0} y={0} width={PROFILE.width} height={PROFILE.height} fill={`url(#${fadeId})`} />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        {profile.stretches.map((stretch) => (
          <polygon
            key={stretch.from}
            points={stretch.polygon}
            fill={stretch.colour}
            stroke={stretch.colour}
            strokeWidth={0.6}
            opacity={stretch.to <= riderShare ? 0.96 : 0.62}
          />
        ))}
      </g>
      <polyline
        points={polyline(profile.line)}
        fill="none"
        stroke="rgb(255 255 255 / .9)"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      <line
        x1={profile.rider.x}
        y1={0}
        x2={profile.rider.x}
        y2={PROFILE.height}
        stroke="var(--ridrs-accent)"
        strokeWidth={1.4}
      />
      <circle
        cx={profile.rider.x}
        cy={profile.rider.y}
        r={3.2}
        fill="var(--ridrs-accent)"
        stroke="#080d16"
        strokeWidth={1.5}
      />
      {summitEdge ? (
        <g data-testid="summit-marker">
          <line
            x1={PROFILE.width - 2}
            y1={0}
            x2={PROFILE.width - 2}
            y2={PROFILE.height}
            stroke="var(--ridrs-info)"
            strokeWidth={1.5}
          />
          <polygon
            points={`${PROFILE.width - 2},1 ${PROFILE.width - 10},4.5 ${PROFILE.width - 2},8`}
            fill="var(--ridrs-info)"
          />
        </g>
      ) : null}
    </svg>
  );
}

/** Workout step segment: 3 labelled columns aligned directly with TIME / DISTANCE / SPEED above. */
function WorkoutSegment({
  workout,
  text,
}: {
  readonly workout: WorkoutSegmentState;
  readonly text: Messages;
}) {
  const { step, power, cadence } = workout;
  if (!step) return null;
  const remaining =
    step.durationSeconds !== undefined
      ? formatDuration(Math.max(0, step.durationSeconds - step.elapsedSeconds))
      : formatDuration(step.elapsedSeconds);
  const total = step.durationSeconds !== undefined ? `/ ${formatDuration(step.durationSeconds)}` : undefined;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        columnGap: 20,
        alignItems: 'start',
      }}
    >
      <div
        data-testid="segment-workout-time"
        style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}
      >
        <span data-testid="label" style={HUD_LABEL}>
          {text.step}
        </span>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 4, whiteSpace: 'nowrap' }}>
          <span data-testid="remaining" style={VALUE_SECONDARY}>
            {remaining}
          </span>
          {total ? (
            <span data-testid="total" style={HUD_UNIT}>
              {total}
            </span>
          ) : null}
        </span>
      </div>

      {power ? (
        <div
          data-testid="segment-workout-power"
          style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}
        >
          <span data-testid="label" style={{ ...HUD_LABEL, color: 'var(--ridrs-accent)' }}>
            {text.target}
          </span>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 4, whiteSpace: 'nowrap' }}>
            <span
              data-testid="value"
              style={{
                ...VALUE_SECONDARY,
                fontSize: 22,
                color: 'var(--ridrs-accent)',
              }}
            >
              {formatTarget(power)}
            </span>
            <span data-testid="unit" style={HUD_UNIT}>
              W
            </span>
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={HUD_LABEL}>{text.target}</span>
          <span style={{ ...VALUE_SECONDARY, color: 'var(--ridrs-text-muted)' }}>{EN_DASH}</span>
        </div>
      )}

      {cadence ? (
        <div
          data-testid="segment-workout-cadence"
          style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}
        >
          <span data-testid="label" style={HUD_LABEL}>
            {text.cadence}
          </span>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 4, whiteSpace: 'nowrap' }}>
            <span data-testid="value" style={VALUE_SECONDARY}>
              {formatTarget(cadence)}
            </span>
            <span data-testid="unit" style={HUD_UNIT}>
              rpm
            </span>
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={HUD_LABEL}>{text.cadence}</span>
          <span style={{ ...VALUE_SECONDARY, color: 'var(--ridrs-text-muted)' }}>{EN_DASH}</span>
        </div>
      )}
    </div>
  );
}

/** Labelled gradient metric shared by summit and hilly route snippet modes. */
function GradientMetric({
  gradePercent,
  language,
  label,
}: {
  readonly gradePercent: number;
  readonly language: Language;
  readonly label: string;
}) {
  return (
    <div data-testid="segment-gradient" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span data-testid="label" style={HUD_LABEL}>
        {label}
      </span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 4, whiteSpace: 'nowrap' }}>
        <span
          data-testid="value"
          style={{
            ...VALUE_SECONDARY,
            color: gradeTextColour(gradePercent),
          }}
        >
          {formatGrade(gradePercent, language)}
        </span>
        <span data-testid="unit" style={HUD_UNIT}>
          %
        </span>
      </span>
    </div>
  );
}

/** Summit segment: flat countdown left, peak + category right, frameless climb profile, labelled grade + climb gain. */
function SummitSegment({
  active,
  profile,
  summitEdge,
  gradePercent,
  language,
  text,
}: {
  readonly active: ActiveClimb;
  readonly profile: LocalProfile | undefined;
  readonly summitEdge: boolean;
  readonly gradePercent: number | undefined;
  readonly language: Language;
  readonly text: Messages;
}) {
  const counting = active.countdownSeconds !== undefined;
  const leftText = counting
    ? text.secondsShort(active.countdownSeconds as number)
    : formatClimbDistance(active.remainingMeters, language);

  return (
    <>
      <div
        data-testid="segment-summit-header"
        style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}
      >
        <span
          data-testid="segment-countdown"
          style={
            counting
              ? {
                  flexShrink: 0,
                  fontFamily: 'var(--ridrs-font-display)',
                  fontStyle: 'italic',
                  fontSize: 15,
                  fontWeight: 600,
                  lineHeight: 1.1,
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--ridrs-accent)',
                }
              : {
                  flexShrink: 0,
                  fontFamily: 'var(--ridrs-font-mono)',
                  fontSize: 13,
                  fontWeight: 500,
                  lineHeight: 1.1,
                  fontVariantNumeric: 'tabular-nums',
                  color: '#f1f5f9',
                }
          }
        >
          {leftText}
        </span>
        <div
          data-testid="segment-summit-info"
          style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}
        >
          {active.climb.name ? (
            <span
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: '#f1f5f9',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {active.climb.name}
            </span>
          ) : null}
          <span
            data-testid="segment-climb-category"
            style={{
              flexShrink: 0,
              fontFamily: 'var(--ridrs-font-display)',
              fontStyle: 'italic',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: climbCategoryColour(active.climb.category),
            }}
          >
            {text.climbCategory(active.climb.category)}
          </span>
        </div>
      </div>

      {profile ? <LocalElevationProfile profile={profile} summitEdge={summitEdge} /> : null}

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        {gradePercent !== undefined ? (
          <GradientMetric gradePercent={gradePercent} language={language} label={text.gradient} />
        ) : (
          <span />
        )}
        <div
          data-testid="segment-climb"
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}
        >
          <span data-testid="label" style={HUD_LABEL}>
            {text.climb}
          </span>
          <span
            data-testid="segment-climb-gain"
            style={{
              ...VALUE_SECONDARY,
              fontSize: 18,
              whiteSpace: 'nowrap',
            }}
          >
            {`${active.climbedGain} / ${active.totalGain} hm`}
          </span>
        </div>
      </div>
    </>
  );
}

/** Local route snippet: frameless profile, labelled gradient and labelled local elevation. */
function LocalSnippetSegment({
  profile,
  gradePercent,
  elevation,
  language,
  text,
}: {
  readonly profile: LocalProfile | undefined;
  readonly gradePercent: number | undefined;
  readonly elevation: number | undefined;
  readonly language: Language;
  readonly text: Messages;
}) {
  return (
    <>
      {profile ? <LocalElevationProfile profile={profile} summitEdge={false} /> : null}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        {gradePercent !== undefined ? (
          <GradientMetric gradePercent={gradePercent} language={language} label={text.gradient} />
        ) : (
          <span />
        )}
        {elevation !== undefined ? (
          <div
            data-testid="segment-elevation"
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}
          >
            <span data-testid="label" style={HUD_LABEL}>
              {text.elevation}
            </span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 4, whiteSpace: 'nowrap' }}>
              <span data-testid="value" style={VALUE_SECONDARY}>
                {String(Math.round(elevation))}
              </span>
              <span data-testid="unit" style={HUD_UNIT}>
                m
              </span>
            </span>
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * The context-aware "Current Segment" section below TIME / DISTANCE / SPEED, sitting flat on the
 * same glass surface (separated only by a 1 px hairline, with no nested boxes):
 * - Workout step: labelled step timer, target watts and target cadence aligned with the 3 columns.
 * - Summit / climb: flat countdown left, peak & category right, frameless climb-only profile,
 *   labelled gradient and climbed / total gain (`hm`).
 * - Local snippet: frameless local elevation profile, labelled gradient, and labelled elevation.
 * - Flat road (no workout step or climb): hidden completely.
 */
export function CurrentSegmentView({
  workout,
  offer,
  track,
  state,
  position,
  terrainPreview,
  language,
  text,
}: {
  readonly workout: WorkoutSegmentState;
  readonly offer: RouteOffer | undefined;
  readonly track: readonly TrackPosition[] | undefined;
  readonly state: PhysicsState | undefined;
  readonly position: WorldPosition | undefined;
  readonly terrainPreview: TerrainPreview | undefined;
  readonly language: Language;
  readonly text: Messages;
}) {
  const measured = useMemo(() => (track ? measureTrack(track) : undefined), [track]);
  const offset = useTrackOffset(measured, position);
  const points = useMemo(
    () => elevationPointsOf(track, offer, terrainPreview),
    [track, offer, terrainPreview],
  );
  const distance = (state?.distance ?? 0) + offset;
  const speed = state?.speed ?? 0;
  const gradePercent = state ? state.road.gradient * 100 : undefined;

  const activeClimb = useMemo(
    () =>
      workout.step
        ? undefined
        : activeClimbOf(offer?.climbs, distance, speed, points, position?.altitude),
    [workout.step, offer?.climbs, distance, speed, points, position?.altitude],
  );

  const summitWindow = useMemo(() => {
    if (!activeClimb) return undefined;
    const windowStart = Math.max(activeClimb.climb.start, distance - LOCAL_LOOKBACK_M);
    const windowEnd = Math.min(activeClimb.climb.end, Math.max(distance + LOCAL_LOOKAHEAD_M, windowStart + 100));
    const clampedEnd = Math.min(windowEnd, activeClimb.climb.end);
    const start = Math.min(windowStart, Math.max(activeClimb.climb.start, clampedEnd - 100));
    return {
      profile: localProfileOf(points, distance, start, clampedEnd, PROFILE.width, PROFILE.height),
      summitEdge: clampedEnd >= activeClimb.climb.end - 0.5,
    };
  }, [activeClimb, distance, points]);

  const localProfile = useMemo(() => {
    if (workout.step || activeClimb) return undefined;
    const windowStart = Math.max(0, distance - LOCAL_LOOKBACK_M);
    const windowEnd = windowStart + LOCAL_LOOKBACK_M + LOCAL_LOOKAHEAD_M;
    return localProfileOf(points, distance, windowStart, windowEnd, PROFILE.width, PROFILE.height);
  }, [workout.step, activeClimb, distance, points]);

  const mode: 'workout' | 'summit' | 'snippet' | 'hidden' = workout.step
    ? 'workout'
    : activeClimb
      ? 'summit'
      : state && !isFlatTerrain(localProfile, gradePercent)
        ? 'snippet'
        : 'hidden';

  if (mode === 'hidden') return null;

  const localElevation = position?.altitude ?? elevationAt(points, distance);

  return (
    <div
      data-testid="current-segment"
      data-mode={mode}
      style={{
        borderTop: '1px solid rgb(255 255 255 / .08)',
        padding: '9px 16px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {mode === 'workout' ? <WorkoutSegment workout={workout} text={text} /> : null}
      {mode === 'summit' && activeClimb ? (
        <SummitSegment
          active={activeClimb}
          profile={summitWindow?.profile}
          summitEdge={summitWindow?.summitEdge ?? false}
          gradePercent={gradePercent}
          language={language}
          text={text}
        />
      ) : null}
      {mode === 'snippet' ? (
        <LocalSnippetSegment
          profile={localProfile}
          gradePercent={gradePercent}
          elevation={localElevation}
          language={language}
          text={text}
        />
      ) : null}
    </div>
  );
}
