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
import { type BridgeStatus, describeDevices, type Readings } from './devices.ts';
import { DeviceSetupView } from './setup.tsx';
import { DevicesTileView, overall } from './tile.tsx';

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

function Tile({ ctx }: { readonly ctx: UiContext }) {
  return <DevicesTileView ctx={ctx} devices={useDevices(ctx)} />;
}

/** From Lucide (ISC, see the folder's LICENSE), painted as a mask in the text colour. */
const BLUETOOTH = new URL('./assets/icons/bluetooth.svg', import.meta.url).href;

/**
 * The device status among the global actions (`main/action`, ADR 0059): opens the device setup,
 * its dot in the tone of the device that needs the rider most.
 */
function StatusAction({ ctx }: { readonly ctx: UiContext }) {
  const [shown, setShown] = useState<string>();
  useEffect(() => ctx.onNavigated(setShown), [ctx]);
  const devices = useDevices(ctx);
  const tone = devices.length === 0 ? 'none' : overall(describeDevices(devices).filter((row) => row !== undefined));
  return (
    <button
      type="button"
      data-action
      aria-label="Devices"
      aria-current={shown === 'setup' ? 'page' : undefined}
      onClick={() => ctx.navigate('setup')}
    >
      <span data-action-icon aria-hidden="true" style={{ '--icon': `url("${BLUETOOTH}")` } as object} />
      <span data-action-tone={tone} aria-hidden="true" />
    </button>
  );
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

export const DevicesTile: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<Tile ctx={ctx} />);
  return () => root.unmount();
};

export const DevicesAction: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<StatusAction ctx={ctx} />);
  return () => root.unmount();
};

export const DeviceSetup: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<Setup ctx={ctx} />);
  return () => root.unmount();
};
