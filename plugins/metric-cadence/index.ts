// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  deviceConnectionChangedEvent,
  type MeasurementPayload,
  type MetricReading,
  type MetricUnavailableReason,
  measurementCadenceEvent,
  metricCadenceCapability,
  metricCadenceEvent,
  type PluginContext,
} from '@ridrs/contracts';
import { EMPTY, Subject, switchMap, timer } from 'rxjs';

const UNIT = 'rpm';
const STALE_AFTER_MS = 3000;

type Reading = MetricReading<typeof UNIT>;

interface MetricState {
  reading: Reading;
  /** Device currently feeding the metric; undefined while the metric is unavailable. */
  activeDeviceId?: string;
  readonly reportedExtraDevices: Set<string>;
}

const states = new WeakMap<PluginContext, MetricState>();

function stateOf(ctx: PluginContext): MetricState {
  const state = states.get(ctx);
  if (!state) {
    throw new Error('metric state is not initialized');
  }
  return state;
}

export default definePlugin({
  initialize(ctx) {
    const state: MetricState = {
      reading: { status: 'unavailable', unit: UNIT, reason: 'no-source', since: ctx.clock.now() },
      reportedExtraDevices: new Set(),
    };
    states.set(ctx, state);
    ctx.capabilities.provide(metricCadenceCapability, { latest: () => state.reading });
  },

  start(ctx) {
    const state = stateOf(ctx);
    // Each accepted measurement re-arms the staleness timer; 'disarm' cancels it.
    const staleness = new Subject<'arm' | 'disarm'>();

    const publish = (reading: Reading): void => {
      state.reading = reading;
      ctx.events.publish(metricCadenceEvent, reading);
    };

    const becomeUnavailable = (reason: MetricUnavailableReason): void => {
      state.activeDeviceId = undefined;
      staleness.next('disarm');
      publish({ status: 'unavailable', unit: UNIT, reason, since: ctx.clock.now() });
    };

    const staleTimer = staleness
      .pipe(switchMap((action) => (action === 'arm' ? timer(STALE_AFTER_MS) : EMPTY)))
      .subscribe(() => becomeUnavailable('stale'));

    const onMeasurement = ({ payload }: { payload: MeasurementPayload }): void => {
      if (state.activeDeviceId !== undefined && state.activeDeviceId !== payload.deviceId) {
        if (!state.reportedExtraDevices.has(payload.deviceId)) {
          state.reportedExtraDevices.add(payload.deviceId);
          ctx.reportDiagnostic(
            'multiple-sources',
            `Ignoring cadence from device "${payload.deviceId}": "${state.activeDeviceId}" is the active source`,
            { activeDeviceId: state.activeDeviceId, ignoredDeviceId: payload.deviceId },
          );
        }
        return;
      }
      state.activeDeviceId = payload.deviceId;
      staleness.next('arm');
      publish({
        status: 'available',
        value: payload.value,
        unit: UNIT,
        deviceId: payload.deviceId,
        measuredAt: payload.measuredAt,
        receivedAt: payload.receivedAt,
      });
    };

    ctx.events.subscribe(measurementCadenceEvent, onMeasurement);
    ctx.events.subscribe(deviceConnectionChangedEvent, ({ payload }) => {
      const lost = payload.state === 'reconnecting' || payload.state === 'disconnected';
      if (lost && payload.deviceId === state.activeDeviceId) {
        becomeUnavailable('disconnected');
      }
    });

    ctx.signal.addEventListener('abort', () => staleTimer.unsubscribe(), { once: true });
  },
});
