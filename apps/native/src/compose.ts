// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityFinishRequestedEvent,
  activityStartRequestedEvent,
  activityStateChangedEvent,
  authBrowserSignInCapability,
  bleBridgeConnectorCapability,
  bleCentralCapability,
  bridgeCompanionsChangedEvent,
  bridgeConnectRequestedEvent,
  bridgeDisconnectRequestedEvent,
  bridgeForgetRequestedEvent,
  bridgePairingOfferEvent,
  bridgePairRequestedEvent,
  bridgeStateChangedEvent,
  configSnapshotCapability,
  controllerButtonsChangedEvent,
  deviceCandidatesChangedEvent,
  deviceConnectionChangedEvent,
  deviceConnectRequestedEvent,
  deviceDiscoveryRequestedEvent,
  deviceForgetRequestedEvent,
  deviceRawNotificationEvent,
  deviceScanChangedEvent,
  deviceStatusChangedEvent,
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
  netHttpCapability,
  type PluginLogger,
  physicsBicycleCapability,
  physicsEnvironmentCapability,
  physicsMotionCapability,
  physicsPowertrainCapability,
  physicsResistanceCapability,
  physicsRiderCapability,
  physicsStateBatchEvent,
  physicsStateEvent,
  physicsTotalResistanceCapability,
  recordingCompletedEvent,
  recordingFailedEvent,
  spatialTerrainCapability,
  storageAppFilesCapability,
  storageSecretsCapability,
  type TimeSource,
  trainingAccountChangedEvent,
  trainingConnectRequestedEvent,
  trainingDisconnectRequestedEvent,
  trainingPlanChangedEvent,
  trainingRefreshRequestedEvent,
  uiTerrainObservedEvent,
  worldTerrainPreviewEvent,
} from '@ridrs/contracts';
import { PluginHost, type PluginSource } from '@ridrs/core';
import type { FrameSource } from '@ridrs/presentation';
import { createInProcessUiBridge } from '@ridrs/ui-bridge';
import type { UiLogger } from '@ridrs/ui-sdk';
import { mountShell, type ShellOptions } from '@ridrs/ui-shell';

/** Every event the host can resolve by id and the UI bridge may carry (subject to the allow-list). */
export const RIDRS_EVENTS: readonly EventDefinition[] = [
  activityStartRequestedEvent,
  activityFinishRequestedEvent,
  activityStateChangedEvent,
  deviceConnectionChangedEvent,
  deviceCandidatesChangedEvent,
  deviceConnectRequestedEvent,
  deviceForgetRequestedEvent,
  deviceDiscoveryRequestedEvent,
  deviceScanChangedEvent,
  deviceStatusChangedEvent,
  controllerButtonsChangedEvent,
  measurementPowerEvent,
  measurementCadenceEvent,
  measurementHeartRateEvent,
  metricPowerEvent,
  metricCadenceEvent,
  metricHeartRateEvent,
  metricPowerHeartRateRatioEvent,
  physicsStateEvent,
  physicsStateBatchEvent,
  uiTerrainObservedEvent,
  worldTerrainPreviewEvent,
  bridgeCompanionsChangedEvent,
  bridgePairingOfferEvent,
  bridgePairRequestedEvent,
  bridgeConnectRequestedEvent,
  bridgeDisconnectRequestedEvent,
  bridgeForgetRequestedEvent,
  bridgeStateChangedEvent,
  deviceRawNotificationEvent,
  recordingCompletedEvent,
  recordingFailedEvent,
  exportFitWrittenEvent,
  trainingConnectRequestedEvent,
  trainingDisconnectRequestedEvent,
  trainingRefreshRequestedEvent,
  trainingAccountChangedEvent,
  trainingPlanChangedEvent,
];

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
  /** Paces the UI's render clock; requestAnimationFrame by default (tests pass a timer source). */
  readonly frameSource?: FrameSource;
  /** The platform's back button (Android's); it goes back like Escape. */
  readonly backButton?: ShellOptions['backButton'];
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
 * by the Tauri WebView (bundled plugins) and the Cucumber e2e scenarios (plugin folders). This
 * device's Bluetooth and the companion bridge both provide `ble.central`: they run at once.
 */
export async function startRidrsApp(options: RidrsAppOptions): Promise<RidrsApp> {
  const host = new PluginHost({
    sources: options.sources,
    disabledPlugins: options.disabledPlugins,
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
      physicsResistanceCapability,
      physicsTotalResistanceCapability,
      physicsPowertrainCapability,
      physicsMotionCapability,
      configSnapshotCapability,
      storageAppFilesCapability,
      spatialTerrainCapability,
      netHttpCapability,
      authBrowserSignInCapability,
      storageSecretsCapability,
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
  await host.start();
  const unmount = mountShell(options.root, bridge, {
    logger: options.uiLogger ?? console,
    frameSource: options.frameSource,
    backButton: options.backButton,
  });
  options.logger.info('ridrs app started');

  let closing: Promise<void> | undefined;
  return {
    host,
    close() {
      closing ??= (async () => {
        unmount();
        rideWatch?.unsubscribe();
        keepAwake?.setKeepAwake(false);
        bridge.dispose();
        await host.dispose();
        options.logger.info('host stopped');
      })();
      return closing;
    },
  };
}
