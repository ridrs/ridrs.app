// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type PluginContext,
  type RememberedDevice,
  type RememberedParts,
  rememberedDeviceSchema,
  rememberedPartsSchema,
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

/** What a device made of several parts remembers: all its parts in one entry (ADR 0089). */
export interface DevicePartsMemory {
  readonly remembered: RememberedParts | undefined;
  save(remembered: RememberedParts): void;
}

/** A link's entry of version 1 as an entry of a device of parts: its device is the one part. */
function asParts(value: RememberedDevice): RememberedParts {
  if (value.state === 'forgotten') {
    return value;
  }
  const { route, peripheralId, name } = value;
  return { state: 'chosen', deviceId: peripheralId, parts: [{ route, peripheralId, name }] };
}

/**
 * Reads the settings document `name` of a device made of several parts (version 2: all parts in
 * one entry). A document of version 1 is the entry of the first link from the time each part was a
 * device of its own; the documents `earlier` (`device-<kind>-2`, …) are those of the further links.
 * They are merged once into one entry, which is written at once: from then on the old documents
 * are left alone. A part any of them chose makes the device chosen; otherwise a forgotten one
 * makes it forgotten.
 */
export async function loadDevicePartsMemory(
  ctx: PluginContext,
  name: string,
  earlier: readonly string[] = [],
): Promise<DevicePartsMemory> {
  let migrated = false;
  const settings = ctx.settings.machine<RememberedParts>({
    name,
    version: 2,
    schema: rememberedPartsSchema,
    migrate: (fromVersion, value) => {
      migrated = true;
      const old = rememberedDeviceSchema.safeParse(value);
      return fromVersion === 1 && old.success ? asParts(old.data) : value;
    },
  });
  let remembered = await settings.read();
  const save = (next: RememberedParts): void => {
    void settings.write(next).catch((error: unknown) => {
      ctx.logger.warn({ err: error, document: name }, 'the remembered device could not be saved');
    });
  };
  if (migrated) {
    const others = await Promise.all(
      earlier.map((document) =>
        ctx.settings.machine({ name: document, version: 1, schema: rememberedDeviceSchema }).read(),
      ),
    );
    const all = [remembered, ...others.map((o) => (o ? asParts(o) : undefined))];
    const chosen = all.filter((r) => r?.state === 'chosen');
    const [first] = chosen;
    if (first) {
      const seen = new Set<string>();
      remembered = {
        state: 'chosen',
        deviceId: first.deviceId,
        parts: chosen
          .flatMap((r) => r.parts)
          .filter((p) => {
            const key = `${p.route}|${p.peripheralId}`;
            const fresh = !seen.has(key);
            seen.add(key);
            return fresh;
          }),
      };
    } else if (all.some((r) => r?.state === 'forgotten')) {
      remembered = { state: 'forgotten' };
    }
    if (remembered) {
      save(remembered);
    }
  }
  return { remembered, save };
}
