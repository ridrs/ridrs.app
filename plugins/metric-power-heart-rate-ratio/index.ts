// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  type MetricReading,
  type MetricUnavailableReason,
  metricHeartRateCapability,
  metricHeartRateEvent,
  metricPowerCapability,
  metricPowerEvent,
  metricPowerHeartRateRatioCapability,
  metricPowerHeartRateRatioEvent,
  type PluginContext,
  type TemporalValue,
} from '@ridrs/contracts';

const UNIT = 'W/bpm';
/** Both inputs are averaged over this window, ending at the same time. */
const WINDOW_MS = 10_000;
/** Below this share of the window an input is still warming up. */
const MIN_COVERAGE = 0.8;

type Reading = MetricReading<typeof UNIT>;

const readings = new WeakMap<PluginContext, { current: Reading }>();

/** Why an input has no value at a time, as a metric reason. */
function reasonOf(value: TemporalValue | undefined): MetricUnavailableReason {
  if (value?.status !== 'unavailable') {
    return 'no-source';
  }
  // Out of range: the input has no data for that time yet.
  return value.reason === 'out-of-range' ? 'insufficient-data' : value.reason;
}

/**
 * Derived metric: 10 s average power divided by 10 s average heart rate, both evaluated at the
 * time of each actual measurement of either input. It knows metrics and their series only.
 */
export default definePlugin({
  initialize(ctx) {
    const reading = {
      current: {
        status: 'unavailable',
        unit: UNIT,
        reason: 'no-source',
        since: ctx.clock.now(),
      } as Reading,
    };
    readings.set(ctx, reading);
    ctx.capabilities.provide(metricPowerHeartRateRatioCapability, {
      latest: () => reading.current,
    });
  },

  start(ctx) {
    const reading = readings.get(ctx);
    if (!reading) {
      throw new Error('ratio state is not initialized');
    }
    const power = ctx.temporal.reader(metricPowerCapability);
    const heartRate = ctx.temporal.reader(metricHeartRateCapability);
    let published: Reading | undefined;

    const publish = (next: Reading): void => {
      reading.current = next;
      published = next;
      ctx.events.publish(metricPowerHeartRateRatioEvent, next);
    };

    // Available readings go out once per snapshot; an unavailability only when it changes.
    const publishUnavailable = (reason: MetricUnavailableReason, since: number): void => {
      if (published?.status === 'unavailable' && published.reason === reason) {
        return;
      }
      publish({ status: 'unavailable', unit: UNIT, reason, since });
    };

    ctx.temporal.combine([power, heartRate], ({ at, values }) => {
      const powerAt = values[power.series];
      const heartRateAt = values[heartRate.series];
      if (powerAt?.status !== 'available') {
        publishUnavailable(reasonOf(powerAt), at);
        return;
      }
      if (heartRateAt?.status !== 'available') {
        publishUnavailable(reasonOf(heartRateAt), at);
        return;
      }
      const averagePower = power.average({ window: WINDOW_MS, at });
      const averageHeartRate = heartRate.average({ window: WINDOW_MS, at });
      if (
        averagePower.coverage < MIN_COVERAGE ||
        averageHeartRate.coverage < MIN_COVERAGE ||
        averagePower.value === undefined ||
        !averageHeartRate.value
      ) {
        publishUnavailable('insufficient-data', at);
        return;
      }
      publish({
        status: 'available',
        value: averagePower.value / averageHeartRate.value,
        unit: UNIT,
        deviceId: ctx.manifest.id,
        measuredAt: at,
        receivedAt: at,
      });
    });

    // A lost or silent input makes the ratio unavailable right away, not at the next snapshot.
    const onInput = ({ payload }: { readonly payload: MetricReading }): void => {
      if (payload.status === 'unavailable') {
        publishUnavailable(payload.reason, payload.since);
      }
    };
    ctx.events.subscribe(metricPowerEvent, onInput);
    ctx.events.subscribe(metricHeartRateEvent, onInput);
  },
});
