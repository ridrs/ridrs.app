// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityAthleteEvent,
  activityStateChangedEvent,
  athleteProfileState,
  DEFAULT_PROVIDER,
  dataSourceState,
  type EventDefinition,
  type MetricReading,
  metricCadenceEvent,
  metricHeartRateEvent,
  metricPowerEvent,
} from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Gauge } from './gauge.tsx';
import { messages } from './i18n/index.ts';
import { cadenceScale, heartRateScale, powerScale, RideAverage } from './model.ts';

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

/**
 * The gauge HUD: three round dials at the top left, below Pause, and the `hud/widget` slot of the
 * plain HUD in the lower corners, so every other widget keeps its place. The HUD lets pointer
 * events through; only the gauges and the widgets take them.
 */
function GaugeHudView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  const widgets = useRef<HTMLDivElement>(null);
  const athlete = useAthlete(ctx);
  const power = useRideMetric(ctx, metricPowerEvent, true);
  const heartRate = useRideMetric(ctx, metricHeartRateEvent, true);
  const cadence = useRideMetric(ctx, metricCadenceEvent, false);

  const { ftp, powerZones, heartRateZones, lthr, maxHeartRate } = athlete;
  const scales = useMemo(
    () => ({
      power: powerScale(ftp, powerZones),
      heartRate: heartRateScale(heartRateZones, lthr, maxHeartRate),
      cadence: cadenceScale(),
    }),
    [ftp, powerZones, heartRateZones, lthr, maxHeartRate],
  );

  useEffect(() => {
    if (!widgets.current) return undefined;
    return ctx.slot('hud/widget', widgets.current);
  }, [ctx]);

  return (
    <div data-testid="hud" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <div
        data-testid="gauges"
        style={{
          position: 'absolute',
          top: 76,
          left: 16,
          display: 'flex',
          flexWrap: 'wrap',
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
          language={language}
          average={{ label: text.average, value: power.average }}
          zoneName={text.zone}
        />
        <Gauge
          kind="heart-rate"
          label={text.heartRate}
          unit="bpm"
          reading={heartRate.reading}
          scale={scales.heartRate}
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
          language={language}
          zoneName={text.zone}
        />
      </div>
      <div
        data-testid="slot-hud-widget"
        ref={widgets}
        style={{
          position: 'absolute',
          left: 16,
          right: 16,
          bottom: 16,
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
