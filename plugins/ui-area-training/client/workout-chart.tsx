// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AthleteProfile,
  athleteProfileState,
  DEFAULT_PROVIDER,
  dataSourceState,
  type PlannedWorkout,
  type UiCapabilityInput,
  type Workout,
  workoutChartCapability,
} from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { useStateEntries } from '@ridrs/ui-sdk/react';
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

type Chartable = Pick<PlannedWorkout, 'id' | 'name' | 'sport' | 'description' | 'steps'> & {
  readonly workout?: Workout;
};

const made = new WeakMap<object, Workout | null>();

/**
 * The canonical workout to draw: the library's whole workout where it has one, else the steps of
 * the entry. None without steps: nothing to draw. Remembered per object, so an unchanged
 * calendar costs nothing on the next render.
 */
export function chartWorkout(item: Chartable): Workout | undefined {
  const known = made.get(item);
  if (known !== undefined) return known ?? undefined;
  const workout =
    item.workout ??
    (item.steps.length === 0
      ? null
      : ({
          format: 'ridrs-workout',
          version: 1,
          id: item.id,
          name: item.name,
          sport: item.sport,
          source: { kind: 'provider' },
          steps: item.steps,
        } satisfies Workout));
  made.set(item, workout);
  return workout ?? undefined;
}

/** What colours and labels the chart: the athlete's FTP, thresholds and zones. */
export type ChartAthlete = NonNullable<UiCapabilityInput<typeof workoutChartCapability>['athlete']>;

export function chartAthlete(profile: AthleteProfile | undefined): ChartAthlete | undefined {
  if (!profile) return undefined;
  const { ftp, lthr, maxHeartRate, powerZones, heartRateZones } = profile;
  const athlete = {
    ...(ftp === undefined ? {} : { ftp }),
    ...(lthr === undefined ? {} : { lthr }),
    ...(maxHeartRate === undefined ? {} : { maxHeartRate }),
    ...(powerZones === undefined ? {} : { powerZones }),
    ...(heartRateZones === undefined ? {} : { heartRateZones }),
  };
  return Object.keys(athlete).length === 0 ? undefined : athlete;
}

/** The chart of a workout, or `fallback` while the chart plugin is not there (ADR 0083). */
export const WorkoutChartSlot = memo(function WorkoutChartSlot({
  ctx,
  workout,
  athlete,
  variant,
  fallback,
  onAvailability,
}: {
  readonly ctx: UiContext;
  readonly workout: Workout;
  readonly athlete: ChartAthlete | undefined;
  readonly variant: 'micro' | 'mini';
  readonly fallback?: ReactNode;
  /** Told whether the chart is drawn, so the caller can leave out what the chart says itself. */
  readonly onAvailability?: (available: boolean) => void;
}) {
  const place = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(false);
  const handle = useRef<ReturnType<typeof ctx.render<typeof workoutChartCapability>>>(undefined);
  const input = useMemo(
    () => ({ workout, ...(athlete ? { athlete } : {}), variant }),
    [workout, athlete, variant],
  );
  const told = useRef(onAvailability);
  told.current = onAvailability;
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    const container = place.current;
    if (!container) return undefined;
    try {
      const drawing = ctx.render(workoutChartCapability, container, latest.current);
      handle.current = drawing;
      const stop = drawing.onAvailability((now) => {
        setAvailable(now);
        told.current?.(now);
      });
      return () => {
        stop();
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

  return (
    <>
      <div ref={place} className="tr-chart" data-variant={variant} data-available={available} />
      {available ? null : fallback}
    </>
  );
});

/** The athlete the charts colour by: the profile of the chosen source (ADR 0075). */
export function useChartAthlete(ctx: UiContext): ChartAthlete | undefined {
  const profiles = useStateEntries(ctx, athleteProfileState);
  const chosen = useStateEntries(ctx, dataSourceState).get('athlete.profile')?.provider ?? DEFAULT_PROVIDER;
  const profile = profiles.get(chosen)?.data;
  return useMemo(() => chartAthlete(profile), [profile]);
}

export const CHART_SLOT_CSS = `
.tr-chart { pointer-events: none; }
.tr-chart:empty { display: none; }
.tw-entry .tr-chart { margin: 2px 0; }
.tr-filters { display: flex; flex-direction: column; gap: 8px; }
.tr-filter-group { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.tr-filter-group > span { min-width: 5.5em; color: var(--ridrs-text-muted, #93a1b8); font-size: 13px; }
.tr-library-open { width: 100%; }
.tr-library-open h4 { margin: 0; font-size: 16px; font-weight: 400; }
`;
