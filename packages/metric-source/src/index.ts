// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type CapabilityContract,
  definePlugin,
  deviceConnectionChangedEvent,
  type EstimationStrategy,
  type EventDefinition,
  type MeasurementPayload,
  type MetricCapability,
  type MetricReading,
  type MetricUnavailableReason,
  type MetricUnit,
  type PluginContext,
  type PluginDefinition,
  type TemporalSeriesWriter,
} from '@ridrs/contracts';

export interface MetricPluginOptions<TUnit extends MetricUnit> {
  readonly unit: TUnit;
  /** Lower-case name for messages, e.g. "power". */
  readonly name: string;
  readonly measurementEvent: EventDefinition<MeasurementPayload>;
  readonly metricEvent: EventDefinition<MetricReading<TUnit>>;
  readonly capability: CapabilityContract<MetricCapability<TUnit>, 'single'>;
  /** How the metric's series estimates values after the last measurement. */
  readonly strategy: EstimationStrategy;
}

interface MetricState<TUnit extends MetricUnit> {
  reading: MetricReading<TUnit>;
  /** Device currently feeding the metric; undefined while the metric is unavailable. */
  activeDeviceId?: string;
  /** Device whose measurements the series holds; another device resets the series. */
  recordedDeviceId?: string;
  readonly reportedExtraDevices: Set<string>;
  readonly writer: TemporalSeriesWriter;
}

/**
 * A device-agnostic metric plugin: the first delivering device is the source while it is
 * available, every accepted measurement goes into the metric's temporal series, and the metric
 * becomes unavailable when the series goes stale or the device is lost. It never invents values.
 */
export function defineMetricPlugin<TUnit extends MetricUnit>(
  options: MetricPluginOptions<TUnit>,
): PluginDefinition {
  const { unit } = options;
  const states = new WeakMap<PluginContext, MetricState<TUnit>>();

  function stateOf(ctx: PluginContext): MetricState<TUnit> {
    const state = states.get(ctx);
    if (!state) {
      throw new Error('metric state is not initialized');
    }
    return state;
  }

  return definePlugin({
    initialize(ctx) {
      const state: MetricState<TUnit> = {
        reading: { status: 'unavailable', unit, reason: 'no-source', since: ctx.clock.now() },
        reportedExtraDevices: new Set(),
        writer: ctx.temporal.writer(options.capability, { strategy: options.strategy }),
      };
      states.set(ctx, state);
      ctx.capabilities.provide(options.capability, { latest: () => state.reading });
    },

    start(ctx) {
      const state = stateOf(ctx);
      const { writer } = state;

      const publish = (reading: MetricReading<TUnit>): void => {
        state.reading = reading;
        ctx.events.publish(options.metricEvent, reading);
      };

      const becomeUnavailable = (reason: MetricUnavailableReason): void => {
        state.activeDeviceId = undefined;
        publish({ status: 'unavailable', unit, reason, since: ctx.clock.now() });
      };

      // Staleness comes from the series: its silence threshold fits the source's own rate.
      ctx.temporal.reader(options.capability).onFreshnessChange((freshness) => {
        if (freshness === 'stale' && state.activeDeviceId !== undefined) {
          becomeUnavailable('stale');
        }
      });

      ctx.events.subscribe(options.measurementEvent, ({ payload }) => {
        if (state.activeDeviceId !== undefined && state.activeDeviceId !== payload.deviceId) {
          if (!state.reportedExtraDevices.has(payload.deviceId)) {
            state.reportedExtraDevices.add(payload.deviceId);
            ctx.reportDiagnostic(
              'multiple-sources',
              `Ignoring ${options.name} from device "${payload.deviceId}": "${state.activeDeviceId}" is the active source`,
              { activeDeviceId: state.activeDeviceId, ignoredDeviceId: payload.deviceId },
            );
          }
          return;
        }
        if (state.recordedDeviceId !== undefined && state.recordedDeviceId !== payload.deviceId) {
          writer.reset();
        }
        state.recordedDeviceId = payload.deviceId;
        const result = writer.record({
          value: payload.value,
          measuredAt: payload.measuredAt,
          receivedAt: payload.receivedAt,
          sourceId: payload.deviceId,
        });
        // A late or duplicate measurement changes nothing: the metric never moves backwards.
        if (result !== 'accepted') {
          return;
        }
        state.activeDeviceId = payload.deviceId;
        publish({
          status: 'available',
          value: payload.value,
          unit,
          deviceId: payload.deviceId,
          measuredAt: payload.measuredAt,
          receivedAt: payload.receivedAt,
        });
      });

      ctx.events.subscribe(deviceConnectionChangedEvent, ({ payload }) => {
        const lost = payload.state === 'reconnecting' || payload.state === 'disconnected';
        if (lost && payload.deviceId === state.activeDeviceId) {
          writer.markUnavailable('disconnected', ctx.clock.now());
          becomeUnavailable('disconnected');
        }
      });
    },
  });
}
