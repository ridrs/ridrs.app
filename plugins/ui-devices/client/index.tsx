// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  bridgeStateChangedEvent,
  controllerButtonsChangedEvent,
  type DeviceStatus,
  deviceStatusChangedEvent,
  metricHeartRateEvent,
  metricPowerEvent,
} from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BridgeStatus, Readings } from './devices.ts';
import { DeviceIndicatorView } from './indicator.tsx';
import { DeviceSetupView } from './setup.tsx';

/**
 * The latest device status; the bridge replays it to every component that mounts later. A layout
 * effect takes the replayed status before the first paint, so "Not set up" never flashes.
 */
function useDevices(ctx: UiContext): readonly DeviceStatus[] {
  const [devices, setDevices] = useState<readonly DeviceStatus[]>([]);
  useLayoutEffect(
    () => ctx.events.subscribe(deviceStatusChangedEvent, ({ payload }) => setDevices(payload.devices)),
    [ctx],
  );
  return devices;
}

/**
 * The power, heart rate and controller buttons, for the proofs in the setup rows. Power and heart
 * rate come from their metrics: a reading leaves once the device falls silent.
 */
function useReadings(ctx: UiContext): Readings {
  const [readings, setReadings] = useState<Readings>({});
  useLayoutEffect(() => {
    const subscriptions = [
      ctx.events.subscribe(metricPowerEvent, ({ payload }) =>
        setReadings(({ power: _, ...r }) =>
          payload.status === 'available'
            ? { ...r, power: { deviceId: payload.deviceId, watts: payload.value } }
            : r,
        ),
      ),
      ctx.events.subscribe(metricHeartRateEvent, ({ payload }) =>
        setReadings(({ heartRate: _, ...r }) =>
          payload.status === 'available'
            ? { ...r, heartRate: { deviceId: payload.deviceId, bpm: payload.value } }
            : r,
        ),
      ),
      ctx.events.subscribe(controllerButtonsChangedEvent, ({ payload }) =>
        setReadings((r) => ({ ...r, buttons: { ...r.buttons, [payload.deviceId]: payload.buttons } })),
      ),
    ];
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }, [ctx]);
  return readings;
}

/** The companion bridge's state; none while its transport does not run. */
function useBridge(ctx: UiContext): BridgeStatus | undefined {
  const [bridge, setBridge] = useState<BridgeStatus>();
  useLayoutEffect(
    () => ctx.events.subscribe(bridgeStateChangedEvent, ({ payload }) => setBridge(payload)),
    [ctx],
  );
  return bridge;
}

function Indicator({ ctx }: { readonly ctx: UiContext }) {
  return <DeviceIndicatorView ctx={ctx} devices={useDevices(ctx)} />;
}

function Setup({ ctx }: { readonly ctx: UiContext }) {
  // A ride started elsewhere (a second window) leads into the ride, as on the main screen.
  useEffect(
    () =>
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
        if (payload.state === 'running') {
          ctx.navigate('activity');
        }
      }),
    [ctx],
  );
  return (
    <DeviceSetupView
      ctx={ctx}
      devices={useDevices(ctx)}
      readings={useReadings(ctx)}
      bridge={useBridge(ctx)}
    />
  );
}

export const DeviceIndicator: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<Indicator ctx={ctx} />);
  return () => root.unmount();
};

export const DeviceSetup: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<Setup ctx={ctx} />);
  return () => root.unmount();
};
