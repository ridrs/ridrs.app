// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  activityAthleteEvent,
  activityEquipmentEvent,
  activityFinishRequestedEvent,
  activityInterruptedEvent,
  activityPauseRequestedEvent,
  activityResumeRequestedEvent,
  activityStartRequestedEvent,
  activityStateChangedEvent,
  appLanguageSetService,
  appLanguageState,
  athleteProfileChangedEvent,
  athleteProfileState,
  athleteProfileUpdateService,
  bleCentralCapability,
  type CapabilityContract,
  configSnapshotCapability,
  controllerButtonsChangedEvent,
  dataArchiveCapability,
  dataFetchCapability,
  dataSelectService,
  dataSourceState,
  deviceConnectionChangedEvent,
  deviceConnectService,
  deviceDiscoverService,
  deviceForgetService,
  deviceRawNotificationEvent,
  deviceRawReadEvent,
  deviceRawWriteEvent,
  deviceRawWriteFailedEvent,
  deviceStatusState,
  drivetrainGearChangedEvent,
  drivetrainShiftRequestedEvent,
  drivetrainVirtualGearCapability,
  type EventDefinition,
  equipmentBicycleChangedEvent,
  exportFitState,
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
  type RecoverableRide,
  recordingContinueService,
  recordingDeleteService,
  recordingFinishService,
  recordingRecoverableState,
  recordingRideState,
  routeCancelService,
  routeFetchService,
  routeOfferState,
  routeRemoveService,
  type ServiceDefinition,
  type StateDefinition,
  spatialTerrainCapability,
  storageAppFilesCapability,
  storageMediaCapability,
  trainerCommandEvent,
  trainerControlChangedEvent,
  trainerErgRequestedEvent,
  trainerTargetPowerEvent,
  trainingAccountState,
  trainingCalendarHandOverService,
  trainingCalendarState,
  trainingConnectService,
  trainingDisconnectService,
  trainingRefreshService,
  trainingUploadService,
  trainingUploadState,
  uiPositionObservedEvent,
  uiTerrainObservedEvent,
  videoImporterCapability,
  worldPositionEvent,
  worldTerrainPreviewEvent,
} from '@ridrs/contracts';
import { PluginHost, type PluginHostOptions } from '@ridrs/core';
import { createFileSystemPluginSource } from '@ridrs/core/node';
import { continueRecording } from '@ridrs/replay';
import pino from 'pino';
import pretty from 'pino-pretty';
import { runRecordingCommand } from './recording-cli.ts';

/**
 * Plugins that need a runtime this host does not have (the Tauri WebView). Excluded like `--disable`,
 * mirroring how `apps/native` leaves Node-only plugins out of its bundle.
 */
const PLUGINS_FOR_OTHER_RUNTIMES = [
  'transport-ble-tauri',
  'bridge-connector-tauri',
  // The bridge transport needs a connector; this host has none (the companion bridge is native-only).
  'transport-ble-bridge',
  'storage-files-tauri',
  // intervals.icu needs HTTP, the browser sign-in and the secret store: native-only providers.
  'planner-intervals-icu',
  // Media, downloads and archives in Rust (crates/ridrs-media); headless has the Node providers.
  'storage-media-tauri',
  'data-fetch-tauri',
  'data-archive-tauri',
  'net-http-tauri',
  'auth-sign-in-tauri',
  'storage-secrets-tauri',
];

const CAPABILITIES: readonly CapabilityContract[] = [
  bleCentralCapability,
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
  storageMediaCapability,
  dataFetchCapability,
  dataArchiveCapability,
  videoImporterCapability,
];

/** Every app state topic the host knows (ADR 0068): owned and watched beside the bus. */
const STATES: readonly StateDefinition[] = [
  appLanguageState,
  dataSourceState,
  athleteProfileState,
  routeOfferState,
  deviceStatusState,
  recordingRideState,
  recordingRecoverableState,
  exportFitState,
  trainingAccountState,
  trainingCalendarState,
  trainingUploadState,
];

/** Every service the host knows (ADR 0068): provided and called beside the bus. */
const SERVICES: readonly ServiceDefinition[] = [
  appLanguageSetService,
  dataSelectService,
  athleteProfileUpdateService,
  routeFetchService,
  routeCancelService,
  deviceConnectService,
  deviceForgetService,
  deviceDiscoverService,
  recordingContinueService,
  recordingFinishService,
  recordingDeleteService,
  routeRemoveService,
  trainingCalendarHandOverService,
  trainingConnectService,
  trainingDisconnectService,
  trainingRefreshService,
  trainingUploadService,
];

/** Events the host resolves by id: what a replay republishes and validates. */
const EVENTS: readonly EventDefinition[] = [
  activityStartRequestedEvent,
  activityFinishRequestedEvent,
  activityPauseRequestedEvent,
  activityResumeRequestedEvent,
  activityInterruptedEvent,
  activityStateChangedEvent,
  deviceConnectionChangedEvent,
  controllerButtonsChangedEvent,
  deviceRawNotificationEvent,
  deviceRawReadEvent,
  deviceRawWriteEvent,
  deviceRawWriteFailedEvent,
  drivetrainGearChangedEvent,
  drivetrainShiftRequestedEvent,
  equipmentBicycleChangedEvent,
  activityEquipmentEvent,
  athleteProfileChangedEvent,
  activityAthleteEvent,
  trainerCommandEvent,
  trainerControlChangedEvent,
  trainerErgRequestedEvent,
  trainerTargetPowerEvent,
  measurementPowerEvent,
  measurementCadenceEvent,
  measurementHeartRateEvent,
  metricPowerEvent,
  metricCadenceEvent,
  metricHeartRateEvent,
  metricPowerHeartRateRatioEvent,
  physicsStateEvent,
  physicsStateBatchEvent,
  uiPositionObservedEvent,
  uiTerrainObservedEvent,
  worldPositionEvent,
  worldTerrainPreviewEvent,
];

function versionOf(packageJson: URL): string {
  return (JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string }).version;
}

function resolvePluginDir(requestedDir: string): string {
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const resolvedFromBase = resolve(baseDir, requestedDir);
  return existsSync(resolvedFromBase) ? resolvedFromBase : resolve(process.cwd(), requestedDir);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--');
  if (rawArgs[0] === 'recording') {
    const code = await runRecordingCommand(rawArgs.slice(1), {
      capabilities: CAPABILITIES,
      events: EVENTS,
      states: STATES,
      services: SERVICES,
      resolvePluginDir,
      resolveFile: (file) => resolve(process.env.INIT_CWD ?? process.cwd(), file),
      out: (line) => process.stdout.write(`${line}\n`),
    });
    process.exit(code);
  }
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      plugins: {
        type: 'string',
        short: 'p',
        multiple: true,
      },
      disable: {
        type: 'string',
        short: 'd',
        multiple: true,
      },
    },
    strict: true,
  });

  const requestedDirs = values.plugins && values.plugins.length > 0 ? values.plugins : ['plugins'];
  const pluginsDirs = requestedDirs.map(resolvePluginDir);
  const disabledPlugins = [...PLUGINS_FOR_OTHER_RUNTIMES, ...(values.disable ?? [])];

  const stream = process.stdout.isTTY ? pretty({ sync: true }) : pino.destination({ sync: true });
  const logger = pino({ name: 'ridrs-headless' }, stream);

  const hostOptions: PluginHostOptions = {
    sources: pluginsDirs.map(createFileSystemPluginSource),
    disabledPlugins,
    logger,
    capabilities: CAPABILITIES,
    events: EVENTS,
    states: STATES,
    services: SERVICES,
    platform: {
      ridrsVersion: versionOf(new URL('../../../package.json', import.meta.url)),
      runtime: 'node',
      os: process.platform,
      appVersion: versionOf(new URL('../package.json', import.meta.url)),
    },
  };
  let host = new PluginHost(hostOptions);

  /**
   * Headless continues an interrupted ride on its own (ADR 0057): the ride goes on paused, in a
   * continuing host that replaces the first one, until `activity.resume-requested` arrives.
   */
  host.watchState('ridrs-headless', recordingRecoverableState.id, ({ entries }) => {
    const ride = [...entries.values()][0] as RecoverableRide | undefined;
    const storage = host.getProvider(storageAppFilesCapability);
    if (!ride || !storage) {
      return;
    }
    void (async () => {
      const text = new TextDecoder().decode(await storage.read(ride.file));
      await host.dispose();
      host = await continueRecording(text, { ...hostOptions, file: ride.file });
      logger.info(
        { file: ride.file, sessionId: ride.sessionId },
        'interrupted ride continued, paused',
      );
    })().catch((error: unknown) => {
      logger.error({ err: error, file: ride.file }, 'the interrupted ride could not be continued');
    });
  });

  const keepAlive = setInterval(() => {}, 60_000);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(keepAlive);
    await host.dispose();
    logger.info('host stopped');
    logger.flush();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  await host.start();

  const startedPlugins = host
    .getKnownPlugins()
    .map((m) => m.id)
    .filter((id) => host.getPluginState(id) === 'started');

  logger.info({ startedPlugins }, `host started (${startedPlugins.join(', ')})`);
}

main().catch((error: unknown) => {
  const logger = pino({ name: 'ridrs-headless' }, pino.destination({ sync: true }));
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ err: error }, `Fatal error starting headless host: ${message}`);
  logger.flush();
  process.exit(1);
});
