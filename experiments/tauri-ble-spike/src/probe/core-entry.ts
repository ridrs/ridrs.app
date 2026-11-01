// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Portability probe, stage 3: can `@ridrs/core` be bundled for a WebView at all?
 * Built with `vite.probe-core.config.ts`; never part of the spike app bundle.
 */

import { measurementPowerEvent } from '@ridrs/contracts';
import { CapabilityRegistry, DiagnosticCollector, EventBus, PluginHost } from '@ridrs/core';

type CoreLogger = ConstructorParameters<typeof DiagnosticCollector>[0];

export function exerciseCore(): string[] {
  const results: string[] = [];
  const logger = { warn: console.warn, error: console.error, info: console.info } as unknown as CoreLogger;
  const diagnostics = new DiagnosticCollector(logger);
  results.push(`CapabilityRegistry constructed: ${new CapabilityRegistry() instanceof CapabilityRegistry}`);

  const bus = new EventBus({ clock: { now: () => Date.now() }, diagnostics, canPluginPublish: () => true });
  const ctx = bus.createPluginEventsContext('probe');
  ctx.subscribe(measurementPowerEvent, (envelope) => {
    results.push(`EventBus delivered ${envelope.type} id=${envelope.id}`);
  });
  ctx.publish(measurementPowerEvent, {
    deviceId: 'probe',
    value: 150,
    measuredAt: 0,
    receivedAt: 0,
    timestampOrigin: 'receive',
  });

  // Filesystem discovery and file-URL imports cannot work in a WebView, whatever the bundler does.
  results.push(`PluginHost class present: ${typeof PluginHost === 'function'}`);
  return results;
}

const output = document.getElementById('out');
try {
  const lines = exerciseCore();
  if (output) output.textContent = lines.join('\n');
} catch (error) {
  if (output) output.textContent = `stage 3 runtime failure: ${error}`;
}
