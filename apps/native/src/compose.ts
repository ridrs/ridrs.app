// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityFinishRequestedEvent,
  activityInterruptedEvent,
  activityPauseRequestedEvent,
  activityResumeRequestedEvent,
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
  deviceRawReadEvent,
  deviceRawWriteEvent,
  deviceRawWriteFailedEvent,
  deviceScanChangedEvent,
  deviceStatusChangedEvent,
  drivetrainGearChangedEvent,
  drivetrainVirtualGearCapability,
  type EventDefinition,
  type EventSubscription,
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
  physicsTrainerLoadCapability,
  recordingCompletedEvent,
  recordingContinueRequestedEvent,
  recordingFailedEvent,
  recordingFinishRequestedEvent,
  recordingRecoverableChangedEvent,
  spatialTerrainCapability,
  storageAppFilesCapability,
  storageSecretsCapability,
  type TimeSource,
  trainerCommandEvent,
  trainerControlChangedEvent,
  trainerErgRequestedEvent,
  trainerTargetPowerEvent,
  trainingAccountChangedEvent,
  trainingConnectRequestedEvent,
  trainingDisconnectRequestedEvent,
  trainingPlanChangedEvent,
  trainingRefreshRequestedEvent,
  uiTerrainObservedEvent,
  worldTerrainPreviewEvent,
} from '@ridrs/contracts';
import { PluginHost, type PluginHostOptions, type PluginSource } from '@ridrs/core';
import type { FrameSource } from '@ridrs/presentation';
import { continueRecording } from '@ridrs/replay';
import { createInProcessUiBridge, type InProcessUiBridge } from '@ridrs/ui-bridge';
import type { UiLogger } from '@ridrs/ui-sdk';
import { mountShell, type ShellOptions } from '@ridrs/ui-shell';

/** Every event the host can resolve by id and the UI bridge may carry (subject to the allow-list). */
export const RIDRS_EVENTS: readonly EventDefinition[] = [
  activityStartRequestedEvent,
  activityFinishRequestedEvent,
  activityPauseRequestedEvent,
  activityResumeRequestedEvent,
  activityInterruptedEvent,
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
  deviceRawReadEvent,
  deviceRawWriteEvent,
  deviceRawWriteFailedEvent,
  drivetrainGearChangedEvent,
  trainerCommandEvent,
  trainerControlChangedEvent,
  trainerErgRequestedEvent,
  trainerTargetPowerEvent,
  recordingCompletedEvent,
  recordingFailedEvent,
  recordingRecoverableChangedEvent,
  recordingContinueRequestedEvent,
  recordingFinishRequestedEvent,
  exportFitWrittenEvent,
  trainingConnectRequestedEvent,
  trainingDisconnectRequestedEvent,
  trainingRefreshRequestedEvent,
  trainingAccountChangedEvent,
  trainingPlanChangedEvent,
];

/** Every capability the host resolves. */
const CAPABILITIES = [
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
  physicsTrainerLoadCapability,
  drivetrainVirtualGearCapability,
  configSnapshotCapability,
  storageAppFilesCapability,
  spatialTerrainCapability,
  netHttpCapability,
  authBrowserSignInCapability,
  storageSecretsCapability,
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
  /** The running host; another one once an interrupted ride was continued (ADR 0057). */
  readonly host: PluginHost;
  /** Unmounts the UI and disposes the host. */
  close(): Promise<void>;
}

/** One host with its UI bridge, shell and the root's own subscriptions. */
interface Composed {
  readonly host: PluginHost;
  readonly bridge: InProcessUiBridge;
  readonly subscriptions: readonly EventSubscription[];
  unmount?: () => void;
}

/**
 * Composition root of the native app: host, in-process UI bridge and shell in one process. Shared
 * by the Tauri WebView (bundled plugins) and the Cucumber e2e scenarios (plugin folders). This
 * device's Bluetooth and the companion bridge both provide `ble.central`: they run at once.
 * When the rider continues an interrupted ride, the root composes a continuing host in place of
 * the running one (ADR 0057).
 */
export async function startRidrsApp(options: RidrsAppOptions): Promise<RidrsApp> {
  const hostOptions: PluginHostOptions = {
    sources: options.sources,
    disabledPlugins: options.disabledPlugins,
    timeSource: options.timeSource,
    logger: options.logger,
    capabilities: CAPABILITIES,
    events: RIDRS_EVENTS,
    platform: options.platform,
  };
  const keepAwake = options.keepAwake;
  let current: Composed | undefined;
  let continuing: Promise<void> | undefined;
  /** The host composed last; `attach` sets it, also from inside `continueRecording`. */
  const latest = (): Composed | undefined => current;

  // Before start, so values published while plugins start (the initial activity state) are cached.
  const attach = (host: PluginHost): Composed => {
    const subscriptions = [
      host.subscribeEvent('ridrs-app', recordingContinueRequestedEvent, ({ payload }) => {
        continuing ??= continueRide(payload.file).finally(() => {
          continuing = undefined;
        });
      }),
      ...(keepAwake
        ? [
            host.subscribeEvent('ridrs-app', activityStateChangedEvent, ({ payload }) =>
              keepAwake.setKeepAwake(payload.state === 'running'),
            ),
          ]
        : []),
    ];
    const composed: Composed = {
      host,
      bridge: createInProcessUiBridge(host, RIDRS_EVENTS),
      subscriptions,
    };
    current = composed;
    return composed;
  };

  const mount = (composed: Composed): void => {
    composed.unmount = mountShell(options.root, composed.bridge, {
      logger: options.uiLogger ?? console,
      frameSource: options.frameSource,
      backButton: options.backButton,
    });
  };

  const teardown = async (composed: Composed): Promise<void> => {
    composed.unmount?.();
    for (const subscription of composed.subscriptions) {
      subscription.unsubscribe();
    }
    keepAwake?.setKeepAwake(false);
    composed.bridge.dispose();
    await composed.host.dispose();
  };

  const startFresh = async (): Promise<void> => {
    const composed = attach(new PluginHost(hostOptions));
    await composed.host.start();
    mount(composed);
  };

  /** Reads the journal, closes the running host and continues the ride in a new one. */
  async function continueRide(file: string): Promise<void> {
    const running = current;
    const storage = running?.host.getProvider(storageAppFilesCapability);
    if (!running || !storage) {
      return;
    }
    let text: string;
    try {
      text = new TextDecoder().decode(await storage.read(file));
    } catch (error) {
      options.logger.error({ err: error, file }, 'the interrupted ride could not be read');
      return;
    }
    await teardown(running);
    current = undefined;
    try {
      // The continuing host's bridge and subscriptions are attached before it starts.
      await continueRecording(text, { ...hostOptions, file, beforeStart: attach });
      const composed = latest();
      if (!composed) {
        throw new Error('no continuing host');
      }
      mount(composed);
      options.logger.info({ file }, 'interrupted ride continued');
    } catch (error) {
      // The ride stays in its journal; the app goes on without it.
      options.logger.error({ err: error, file }, 'the interrupted ride could not be continued');
      const failed = latest();
      if (failed) {
        await teardown(failed);
      }
      await startFresh();
    }
  }

  await startFresh();
  options.logger.info('ridrs app started');

  let closing: Promise<void> | undefined;
  return {
    get host() {
      const composed = latest();
      if (!composed) {
        throw new Error('The ridrs app has no host');
      }
      return composed.host;
    },
    close() {
      closing ??= (async () => {
        await continuing?.catch(() => undefined);
        const composed = latest();
        if (composed) {
          await teardown(composed);
        }
        options.logger.info('host stopped');
      })();
      return closing;
    },
  };
}
