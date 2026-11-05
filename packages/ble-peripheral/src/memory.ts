// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type PluginContext,
  type RememberedDevice,
  rememberedDeviceSchema,
} from '@ridrs/contracts';

/** A link's memory: read once before it scans, saved whenever it changes. */
export interface DeviceMemory {
  readonly remembered: RememberedDevice | undefined;
  save(remembered: RememberedDevice): void;
}

/**
 * Reads the link's settings document `name` (`device-<kind>`, with a number for each further
 * link of the kind). Needs `"persistence": ["machine"]` in the plugin's manifest.
 */
export async function loadDeviceMemory(ctx: PluginContext, name: string): Promise<DeviceMemory> {
  const settings = ctx.settings.machine({ name, version: 1, schema: rememberedDeviceSchema });
  const remembered = await settings.read();
  return {
    remembered,
    save(next) {
      void settings.write(next).catch((error: unknown) => {
        ctx.logger.warn({ err: error, document: name }, 'the remembered device could not be saved');
      });
    },
  };
}
