// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityAthleteEvent,
  activityStateChangedEvent,
  athleteProfileState,
  DEFAULT_PROVIDER,
  type DrivetrainGearChangedPayload,
  dataSourceState,
  drivetrainGearChangedEvent,
  drivetrainShiftRequestedEvent,
  type EventDefinition,
  type MetricReading,
  metricCadenceEvent,
  metricHeartRateEvent,
  metricPowerEvent,
  type PhysicsState,
  physicsStateEvent,
  rideScreenshotCaptureState,
  trainerErgRequestedEvent,
  trainerTargetPowerEvent,
  workoutFinishedEvent,
  workoutIntensityChangedEvent,
  workoutStepChangedEvent,
} from '@ridrs/contracts';
import { formatDecimal, localizeNumber, type UiComponent, type UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Gauge } from './gauge.tsx';
import { messages } from './i18n/index.ts';
import { RouteBoxView } from './route-box.tsx';
import {
  cadenceScale,
  formatDuration,
  type GaugeTarget,
  heartRateScale,
  powerScale,
  RideAverage,
  WorkoutTargetTracker,
} from './model.ts';

/** The latest reading of a metric and, with `averaged`, its average over the ride. */
function useRideMetric<R extends MetricReading>(
  ctx: UiContext,
  event: EventDefinition<R>,
  averaged: boolean,
): { readonly reading: R | undefined; readonly average: number | undefined } {
  const [reading, setReading] = useState<R>();
  const [average, setAverage] = useState<number>();
  const ride = useRef(new RideAverage());

  useEffect(() => {
    if (!averaged) return undefined;
    return ctx.events.subscribe(activityStateChangedEvent, ({ payload, seq }) => {
      ride.current.activity(payload, seq);
      setAverage(ride.current.value);
    });
  }, [ctx, averaged]);

  useEffect(
    () =>
      ctx.events.subscribe(event, ({ payload, seq }) => {
        setReading(payload);
        if (averaged && ride.current.add(payload.status === 'available' ? payload.value : undefined, seq)) {
          setAverage(ride.current.value);
        }
      }),
    [ctx, event, averaged],
  );

  return { reading, average };
}

/** The athlete the scales colour by: the profile of the chosen source, the FTP of the ride first. */
function useAthlete(ctx: UiContext) {
  const profiles = useStateEntries(ctx, athleteProfileState);
  const chosen = useStateEntries(ctx, dataSourceState).get('athlete.profile')?.provider ?? DEFAULT_PROVIDER;
  const profile = profiles.get(chosen)?.data;
  const [rideFtp, setRideFtp] = useState<number>();
  useEffect(
    () => ctx.events.subscribe(activityAthleteEvent, ({ payload }) => setRideFtp(payload.athlete.ftp)),
    [ctx],
  );
  return { ...profile, ftp: rideFtp ?? profile?.ftp };
}

/** + and - shift without the focus: `=` is + without Shift on many keyboards. */
const PLUS_MINUS: Readonly<Record<string, 'up' | 'down'>> = { '+': 'up', '=': 'up', '-': 'down' };

/** Where a typed + or - is text, not a ride control. */
function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && target.type !== 'button') ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * The virtual gear, and whether ERG is on, as the trainer reports them. In the app the gauges take the
 * place of the gear widget and the target power widget, so they also take their keys: + and -
 * anywhere shift the gear while ERG is off and change the target in ERG, and Up and Down on the
 * gear in the cadence gauge shift. They only ask; a key another control took is left alone.
 */
function useTrainer(ctx: UiContext): {
  readonly gear: DrivetrainGearChangedPayload | undefined;
  readonly target: number | undefined;
  readonly shift: (change: 'up' | 'down') => void;
} {
  const [gear, setGear] = useState<DrivetrainGearChangedPayload>();
  const [target, setTarget] = useState<number>();
  useEffect(
    () => ctx.events.subscribe(drivetrainGearChangedEvent, ({ payload }) => setGear(payload)),
    [ctx],
  );
  useEffect(
    () =>
      ctx.events.subscribe(trainerTargetPowerEvent, ({ payload }) => setTarget(payload.watts ?? undefined)),
    [ctx],
  );
  const erg = target !== undefined;
  const shifts = gear !== undefined && !erg;
  useEffect(() => {
    if (!shifts && !erg) {
      return undefined;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const change = PLUS_MINUS[event.key];
      if (
        !change ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isTextEntry(event.target)
      ) {
        return;
      }
      event.preventDefault();
      if (erg) {
        ctx.events.publish(trainerErgRequestedEvent, { change });
      } else {
        ctx.events.publish(drivetrainShiftRequestedEvent, { change });
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [ctx, shifts, erg]);
  return {
    gear,
    target,
    shift: (change) => ctx.events.publish(drivetrainShiftRequestedEvent, { change }),
  };
}

/** The gear as the gear widget's large line: its positions with a drivetrain, else its number. */
function gearText(gear: DrivetrainGearChangedPayload): string {
  return gear.front !== undefined && gear.rear !== undefined
    ? `${gear.front}×${gear.rear}`
    : String(gear.index);
}

/**
 * The power and cadence targets of the ride's active workout step, gliding from the previous
 * step's target to the new one over `TARGET_TRANSITION_MS` when the step changes.
 */
function useWorkoutTargets(
  ctx: UiContext,
  ftp: number | undefined,
): { readonly power: GaugeTarget | undefined; readonly cadence: GaugeTarget | undefined } {
  const tracker = useRef(new WorkoutTargetTracker());
  const clock = useRef(0);
  const [state, setState] = useState<{
    readonly power: GaugeTarget | undefined;
    readonly cadence: GaugeTarget | undefined;
    readonly animating: boolean;
  }>({ power: undefined, cadence: undefined, animating: false });

  tracker.current.setFtp(ftp);

  useLayoutEffect(() => {
    const sync = (at: number) => {
      clock.current = Math.max(clock.current, at);
      setState(tracker.current.at(clock.current));
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
      stopIntensity();
    };
  }, [ctx]);

  useEffect(() => {
    setState(tracker.current.at(clock.current, ftp));
  }, [ftp]);

  useEffect(() => {
    if (!state.animating) return undefined;
    return ctx.frames.onFrame(({ time }) => {
      clock.current = time;
      setState(tracker.current.at(time));
    });
  }, [ctx, state.animating]);

  return state;
}

/**
 * The telemetry, a HUD element of its own: three round dials side by side at the bottom centre.
 * Only the gauges take pointer events.
 */
function TelemetryView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  const athlete = useAthlete(ctx);
  const power = useRideMetric(ctx, metricPowerEvent, true);
  const heartRate = useRideMetric(ctx, metricHeartRateEvent, true);
  const cadence = useRideMetric(ctx, metricCadenceEvent, false);
  const trainer = useTrainer(ctx);
  // While a screenshot is taken the gauges show their SVG (ADR 0102).
  const capturing = useStateEntries(ctx, rideScreenshotCaptureState).size > 0;

  const { ftp, powerZones, heartRateZones, lthr, maxHeartRate } = athlete;
  const workoutTargets = useWorkoutTargets(ctx, ftp);
  const scales = useMemo(
    () => ({
      power: powerScale(ftp, powerZones),
      heartRate: heartRateScale(heartRateZones, lthr, maxHeartRate),
      cadence: cadenceScale(),
    }),
    [ftp, powerZones, heartRateZones, lthr, maxHeartRate],
  );

  return (
    <div
      data-testid="gauges"
      style={{
        position: 'absolute',
        bottom: 'var(--ridrs-hud-inset-bottom)',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        // Not stretched: a stretched gauge sizes its dial from the row, and the row from the dial.
        alignItems: 'flex-end',
        gap: 12,
        pointerEvents: 'none',
      }}
    >
      <Gauge
        kind="power"
        label={text.power}
        unit="W"
        reading={power.reading}
        scale={scales.power}
        capturing={capturing}
        language={language}
        average={{ label: text.average, value: power.average }}
        ftp={ftp}
        target={workoutTargets.power}
        zoneName={text.zone}
      />
      <Gauge
        kind="heart-rate"
        label={text.heartRate}
        unit="bpm"
        reading={heartRate.reading}
        scale={scales.heartRate}
        capturing={capturing}
        language={language}
        average={{ label: text.average, value: heartRate.average }}
        zoneName={text.zone}
      />
      <Gauge
        kind="cadence"
        label={text.cadence}
        unit="rpm"
        reading={cadence.reading}
        scale={scales.cadence}
        capturing={capturing}
        language={language}
        target={workoutTargets.cadence}
        {...(trainer.gear !== undefined && trainer.target === undefined
          ? {
              gear: {
                label: text.gear,
                text: gearText(trainer.gear),
                index: trainer.gear.index,
                count: trainer.gear.count,
                onShift: trainer.shift,
              },
            }
          : {})}
        zoneName={text.zone}
      />
    </div>
  );
}

const EN_DASH = '–';

/** The physics steps 10 ms each, and only while the ride runs: the time ridden. */
const STEP_MS = 10;

/** s ridden: the steps since the ride began to roll; 0 while it waits for the rider. */
const riddenSeconds = (state: PhysicsState) => ((state.step - (state.timeFromStep ?? 0)) * STEP_MS) / 1000;

const FACT_LABEL = {
  fontFamily: 'var(--ridrs-font-mono)',
  fontSize: 'var(--ridrs-size-label)',
  fontWeight: 500,
  letterSpacing: '.12em',
  textTransform: 'uppercase',
  color: 'var(--ridrs-info)',
} as const;

/** One value of the ride: its name above, the number large, the unit beside it. */
function Fact({
  kind,
  label,
  value,
  unit,
}: {
  readonly kind: string;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
}) {
  return (
    <div data-testid={`ride-${kind}`} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 80 }}>
      <span style={FACT_LABEL}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 4, whiteSpace: 'nowrap' }}>
        <span
          data-testid="value"
          style={{ fontSize: 30, fontWeight: 500, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}
        >
          {value}
        </span>
        {unit === undefined ? null : (
          <span data-testid="unit" style={{ fontSize: 13, fontWeight: 500, color: 'var(--ridrs-text-muted)' }}>
            {unit}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * The ride at the top centre, a HUD element of its own drawn like a ride card: the time ridden,
 * the distance and the speed, from the physics. Dashes until the first physics state. The time
 * stands at 0:00 until the ride rolls with the rider's first pedal stroke.
 */
function RideFactsView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  const [state, setState] = useState<PhysicsState>();
  useEffect(() => ctx.events.subscribe(physicsStateEvent, ({ payload }) => setState(payload)), [ctx]);
  const number = (value: number, decimals: number) => localizeNumber(formatDecimal(value, decimals), language);

  return (
    <section
      data-testid="ride-facts"
      aria-label={[text.time, text.distance, text.speed].join(', ')}
      style={{
        position: 'absolute',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 20,
        padding: '10px 18px',
        borderRadius: 'var(--ridrs-radius-lg)',
        background: 'var(--ridrs-card)',
        boxShadow: 'var(--ridrs-edge), var(--ridrs-shadow)',
        color: 'var(--ridrs-text)',
        fontFamily: 'var(--ridrs-font-text)',
        pointerEvents: 'none',
      }}
    >
      <Fact kind="time" label={text.time} value={state ? formatDuration(riddenSeconds(state)) : EN_DASH} />
      <Fact
        kind="distance"
        label={text.distance}
        value={state ? number(state.distance / 1000, 2) : EN_DASH}
        unit="km"
      />
      <Fact kind="speed" label={text.speed} value={state ? number(state.speed * 3.6, 1) : EN_DASH} unit="km/h" />
    </section>
  );
}

/**
 * The gauge HUD's layer: the `hud/widget` slot of the plain HUD in the lower corners, above the
 * room the screen keeps at the bottom (`--ridrs-hud-inset-bottom`), so every
 * other widget keeps its place. It lets pointer events through; only the widgets take them.
 */
function GaugeHudView({ ctx }: { readonly ctx: UiContext }) {
  const widgets = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!widgets.current) return undefined;
    return ctx.slot('hud/widget', widgets.current);
  }, [ctx]);

  return (
    <div data-testid="hud" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <div
        data-testid="slot-hud-widget"
        ref={widgets}
        style={{
          position: 'absolute',
          left: 16,
          right: 16,
          bottom: 'var(--ridrs-hud-inset-bottom)',
          display: 'flex',
          // Widgets that do not fit wrap upwards, keeping the first ones in the bottom row.
          flexWrap: 'wrap-reverse',
          gap: 8,
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

export const GaugeHud: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<GaugeHudView ctx={ctx} />);
  return () => root.unmount();
};

export const Telemetry: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<TelemetryView ctx={ctx} />);
  return () => root.unmount();
};

export const RideFacts: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<RideFactsView ctx={ctx} />);
  return () => root.unmount();
};

export const RouteBox: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<RouteBoxView ctx={ctx} />);
  return () => root.unmount();
};
