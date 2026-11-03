// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityFinishRequestedEvent,
  activityStartRequestedEvent,
  activityStateChangedEvent,
  type BleTransport,
  bleBridgeConnectorCapability,
  bleCentralCapability,
  bleTransportRequestedEvent,
  bridgeCompanionsChangedEvent,
  bridgeConnectRequestedEvent,
  bridgeDisconnectRequestedEvent,
  bridgeForgetRequestedEvent,
  bridgePairingOfferEvent,
  bridgePairRequestedEvent,
  bridgeStateChangedEvent,
  configSnapshotCapability,
  deviceConnectionChangedEvent,
  deviceRawNotificationEvent,
  type EventDefinition,
  exportFitWrittenEvent,
  type HostPlatform,
  measurementCadenceEvent,
  measurementHeartRateEvent,
  measurementPowerEvent,
  metricCadenceCapability,
  metricCadenceEvent,
  metricHeartRateCapability,
  metricHeartRateEvent,
  metricPowerCapability,
  metricPowerEvent,
  metricPowerHeartRateRatioCapability,
  metricPowerHeartRateRatioEvent,
  type PluginLogger,
  physicsBicycleCapability,
  physicsEnvironmentCapability,
  physicsMotionCapability,
  physicsPowertrainCapability,
  physicsResistanceCapability,
  physicsRiderCapability,
  physicsRoadCapability,
  physicsStateBatchEvent,
  physicsStateEvent,
  physicsTotalResistanceCapability,
  recordingCompletedEvent,
  recordingFailedEvent,
  storageAppFilesCapability,
  type TimeSource,
} from '@ridrs/contracts';
import { PluginHost, type PluginSource } from '@ridrs/core';
import type { FrameSource } from '@ridrs/presentation';
import { createInProcessUiBridge } from '@ridrs/ui-bridge';
import type { UiLogger } from '@ridrs/ui-sdk';
import { mountShell } from '@ridrs/ui-shell';

/** Every event the host can resolve by id and the UI bridge may carry (subject to the allow-list). */
export const RIDRS_EVENTS: readonly EventDefinition[] = [
  activityStartRequestedEvent,
  activityFinishRequestedEvent,
  activityStateChangedEvent,
  deviceConnectionChangedEvent,
  measurementPowerEvent,
  measurementCadenceEvent,
  measurementHeartRateEvent,
  metricPowerEvent,
  metricCadenceEvent,
  metricHeartRateEvent,
  metricPowerHeartRateRatioEvent,
  physicsStateEvent,
  physicsStateBatchEvent,
  bridgeCompanionsChangedEvent,
  bridgePairingOfferEvent,
  bridgePairRequestedEvent,
  bridgeConnectRequestedEvent,
  bridgeDisconnectRequestedEvent,
  bridgeForgetRequestedEvent,
  bridgeStateChangedEvent,
  bleTransportRequestedEvent,
  deviceRawNotificationEvent,
  recordingCompletedEvent,
  recordingFailedEvent,
  exportFitWrittenEvent,
];

/**
 * `ble.central` has exactly one provider: the plugins of the transport not chosen are disabled.
 * The connector plugin is the platform half of the bridge (mDNS + sockets in Rust).
 */
const TRANSPORT_PLUGINS: Record<BleTransport, readonly string[]> = {
  local: ['transport-ble-tauri', 'transport-ble-noble'],
  bridge: ['transport-ble-bridge', 'bridge-connector-tauri'],
};

/** Port to the platform's "keep the display on" facility. */
export interface KeepAwakePort {
  setKeepAwake(on: boolean): void;
}

export interface RidrsAppOptions {
  readonly sources: readonly PluginSource[];
  readonly root: HTMLElement;
  readonly logger: PluginLogger;
  readonly uiLogger?: UiLogger;
  /** The live clock's time source; the OS's monotonic clock by default. */
  readonly timeSource?: TimeSource;
  readonly disabledPlugins?: Iterable<string>;
  /** Keeps the display on while a ride runs: nobody touches the screen while pedalling. */
  readonly keepAwake?: KeepAwakePort;
  /** Bluetooth of this device (default) or a companion phone in the same network. */
  readonly bleTransport?: BleTransport;
  /** The rider asked for the other transport; the app persists it and restarts. */
  readonly onBleTransportRequested?: (transport: BleTransport) => void;
  /** Paces the UI's render clock; requestAnimationFrame by default (tests pass a timer source). */
  readonly frameSource?: FrameSource;
  /** Who runs the host; recordings name it. */
  readonly platform?: HostPlatform;
}

export interface RidrsApp {
  readonly host: PluginHost;
  /** Unmounts the UI and disposes the host. */
  close(): Promise<void>;
}

/**
 * Composition root of the native app: host, in-process UI bridge and shell in one process. Shared
 * by the Tauri WebView (bundled plugins) and the Cucumber e2e scenarios (plugin folders).
 */
export async function startRidrsApp(options: RidrsAppOptions): Promise<RidrsApp> {
  const transport = options.bleTransport ?? 'local';
  const otherTransport: BleTransport = transport === 'local' ? 'bridge' : 'local';
  const host = new PluginHost({
    sources: options.sources,
    disabledPlugins: [...(options.disabledPlugins ?? []), ...TRANSPORT_PLUGINS[otherTransport]],
    timeSource: options.timeSource,
    logger: options.logger,
    capabilities: [
      bleCentralCapability,
      bleBridgeConnectorCapability,
      metricPowerCapability,
      metricCadenceCapability,
      metricHeartRateCapability,
      metricPowerHeartRateRatioCapability,
      physicsBicycleCapability,
      physicsRiderCapability,
      physicsEnvironmentCapability,
      physicsRoadCapability,
      physicsResistanceCapability,
      physicsTotalResistanceCapability,
      physicsPowertrainCapability,
      physicsMotionCapability,
      configSnapshotCapability,
      storageAppFilesCapability,
    ],
    events: RIDRS_EVENTS,
    platform: options.platform,
  });
  // Before start, so values published while plugins start (the initial activity state) are cached.
  const bridge = createInProcessUiBridge(host, RIDRS_EVENTS);
  const keepAwake = options.keepAwake;
  const rideWatch = keepAwake
    ? host.subscribeEvent('ridrs-app', activityStateChangedEvent, ({ payload }) =>
        keepAwake.setKeepAwake(payload.state === 'running'),
      )
    : undefined;
  const onTransport = options.onBleTransportRequested;
  const transportWatch = onTransport
    ? host.subscribeEvent('ridrs-app', bleTransportRequestedEvent, ({ payload }) => {
        if (payload.transport !== transport) {
          onTransport(payload.transport);
        }
      })
    : undefined;
  await host.start();
  const unmount = mountShell(options.root, bridge, {
    logger: options.uiLogger ?? console,
    frameSource: options.frameSource,
  });
  options.logger.info('ridrs app started');

  let closing: Promise<void> | undefined;
  return {
    host,
    close() {
      closing ??= (async () => {
        unmount();
        rideWatch?.unsubscribe();
        transportWatch?.unsubscribe();
        keepAwake?.setKeepAwake(false);
        bridge.dispose();
        await host.dispose();
        options.logger.info('host stopped');
      })();
      return closing;
    },
  };
}
