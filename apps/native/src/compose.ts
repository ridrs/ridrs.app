// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityFinishRequestedEvent,
  activityStartRequestedEvent,
  activityStateChangedEvent,
  bleCentralCapability,
  type Clock,
  deviceConnectionChangedEvent,
  type EventDefinition,
  measurementCadenceEvent,
  measurementPowerEvent,
  metricCadenceCapability,
  metricCadenceEvent,
  metricPowerCapability,
  metricPowerEvent,
  type PluginLogger,
} from '@ridrs/contracts';
import { PluginHost, type PluginSource } from '@ridrs/core';
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
  metricPowerEvent,
  metricCadenceEvent,
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
  readonly clock?: Clock;
  readonly disabledPlugins?: Iterable<string>;
  /** Keeps the display on while a ride runs: nobody touches the screen while pedalling. */
  readonly keepAwake?: KeepAwakePort;
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
  const host = new PluginHost({
    sources: options.sources,
    disabledPlugins: options.disabledPlugins,
    clock: options.clock,
    logger: options.logger,
    capabilities: [bleCentralCapability, metricPowerCapability, metricCadenceCapability],
    events: RIDRS_EVENTS,
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
  const unmount = mountShell(options.root, bridge, { logger: options.uiLogger ?? console });
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
