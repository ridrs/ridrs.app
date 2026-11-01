// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Portability probe, stage 2: the real `device-ftms-trainer` plugin, unchanged, driven by a
 * minimal hand-written plugin context with `ble.central` = TauriBleCentral. Experiment code only;
 * this is not the host adapter Phase 3 needs (see FINDINGS.md).
 */

import {
  type BleCentral,
  bleCentralCapability,
  type CapabilityContract,
  deviceConnectionChangedEvent,
  type EventDefinition,
  measurementCadenceEvent,
  measurementPowerEvent,
  type PluginContext,
  type PluginLogger,
  parseManifestJson,
} from '@ridrs/contracts';
import ftmsTrainerPlugin from '@ridrs-shared/ftms-trainer-plugin';
import manifestJson from '../../../../plugins/device-ftms-trainer/manifest.json?raw';

export interface ProbeEvent {
  readonly type: string;
  readonly payload: unknown;
}

function consoleLogger(onLine: (line: string) => void): PluginLogger {
  const log =
    (level: string) =>
    (objOrMsg: unknown, msg?: string): void => {
      const text = typeof objOrMsg === 'string' ? objOrMsg : `${msg ?? ''} ${JSON.stringify(objOrMsg)}`;
      onLine(`[${level}] ${text}`);
    };
  const logger = {
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    child: () => logger,
  };
  // PluginLogger is pino's Logger type; the probe only provides what the plugin calls.
  return logger as unknown as PluginLogger;
}

export interface FtmsPluginProbe {
  stop(): Promise<void>;
}

export async function startFtmsPluginProbe(
  central: BleCentral,
  onEvent: (event: ProbeEvent) => void,
  onLog: (line: string) => void,
): Promise<FtmsPluginProbe> {
  const parsed = parseManifestJson(manifestJson);
  if (!parsed.success) {
    throw new Error(`device-ftms-trainer manifest invalid: ${parsed.message}`);
  }
  const abortController = new AbortController();
  const forwarded = new Set<string>([
    deviceConnectionChangedEvent.id,
    measurementPowerEvent.id,
    measurementCadenceEvent.id,
  ]);

  const ctx: PluginContext = {
    manifest: parsed.data,
    logger: consoleLogger(onLog),
    clock: { now: () => Date.now() },
    events: {
      publish<TPayload, TType extends string>(event: EventDefinition<TPayload, TType>, payload: TPayload) {
        const valid = event.schema.safeParse(payload);
        if (!valid.success) {
          onLog(`[probe] invalid ${event.id} payload: ${valid.error.message}`);
          return;
        }
        if (forwarded.has(event.id)) {
          onEvent({ type: event.id, payload });
        }
      },
      subscribe() {
        return { unsubscribe() {} };
      },
    },
    capabilities: {
      provide() {
        throw new Error('probe plugins provide no capabilities');
      },
      get<T>(contract: CapabilityContract<T, 'single'>) {
        if (contract.id !== bleCentralCapability.id) {
          throw new Error(`probe provides only ble.central, not ${contract.id}`);
        }
        return central as T;
      },
      getAll() {
        return [];
      },
    },
    signal: abortController.signal,
    reportDiagnostic(code, message) {
      onLog(`[diagnostic ${code}] ${message}`);
    },
  };

  await ftmsTrainerPlugin.initialize?.(ctx);
  await ftmsTrainerPlugin.start?.(ctx);

  return {
    async stop() {
      abortController.abort();
      await ftmsTrainerPlugin.stop?.(ctx);
      await ftmsTrainerPlugin.dispose?.(ctx);
    },
  };
}
