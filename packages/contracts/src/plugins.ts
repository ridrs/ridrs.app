// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineState } from './app-state.ts';
import { defineCapability } from './capabilities.ts';
import { pluginIdSchema } from './manifest-ids.ts';
import { defineService } from './services.ts';

/**
 * Plugins the rider installs (ADR 0106): each is a folder of the media storage below this one,
 * `plugins/<id>/`, with its `manifest.json` and its entry, one bundled ES module.
 */
export const INSTALLED_PLUGINS = 'plugins';

/** A program a plugin starts: its name, no path (e.g. `yt-dlp`). */
const programSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/**
 * The rider's choices of plugins, in the app files at {@link PLUGIN_CHOICES_PATH}: the plugins not
 * to start, and the programs granted to each installed plugin. The composition root reads them
 * before the host starts; the plugin manager writes them, and they take effect at the next start.
 */
export const pluginChoicesSchema = z
  .object({
    version: z.literal(1),
    disabled: z.array(pluginIdSchema),
    programs: z.record(pluginIdSchema, z.array(programSchema)),
  })
  .strict();

export type PluginChoices = z.infer<typeof pluginChoicesSchema>;

export const PLUGIN_CHOICES_PATH = 'config/plugin-choices.json';

export const NO_PLUGIN_CHOICES: PluginChoices = { version: 1, disabled: [], programs: {} };

/** The choices in `bytes`, or none where there is no file or it holds no valid choices. */
export function parsePluginChoices(bytes: Uint8Array | undefined): PluginChoices {
  if (!bytes) return NO_PLUGIN_CHOICES;
  try {
    return pluginChoicesSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return NO_PLUGIN_CHOICES;
  }
}

/** A plugin as the rider sees it on the plugins page (ADR 0106). */
export const pluginEntrySchema = z
  .object({
    id: pluginIdSchema,
    name: z.string().min(1),
    /** Where it is known: a plugin of the app that is switched off names none. */
    version: z.string().min(1).optional(),
    /** Part of the app, or installed by the rider. */
    origin: z.enum(['bundled', 'installed']),
    /** Started at the next start of the app. */
    enabled: z.boolean(),
    /** Started now. */
    running: z.boolean(),
    /** The app needs it to show this page or to keep the rider's choices: it stays on. */
    locked: z.boolean(),
    /** The running plugins that cannot start without it. */
    neededBy: z.array(pluginIdSchema),
    /** The programs it starts, granted when it was installed. */
    programs: z.array(programSchema),
  })
  .strict();

export type PluginEntry = z.infer<typeof pluginEntrySchema>;

/** Every plugin of the app and every installed one, by its id; owned by the plugin manager. */
export const pluginsState = defineState('plugins.list', pluginEntrySchema);

/** What an installed plugin is and asks for, before it is installed. */
export const pluginPreviewSchema = z
  .object({
    id: pluginIdSchema,
    name: z.string().min(1),
    version: z.string().min(1),
    /** The capabilities it uses, required and optional. */
    capabilities: z.array(z.string().min(1)),
    programs: z.array(programSchema),
  })
  .strict();

export type PluginPreview = z.infer<typeof pluginPreviewSchema>;

/** A file dragged onto the window (`data.drop`) by its id. */
const droppedFile = z.string().min(1);

/** What a dragged ZIP would install, or why it cannot. */
export const pluginsPreviewService = defineService('plugins.preview', {
  request: z.object({ file: droppedFile }).strict(),
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), plugin: pluginPreviewSchema }).strict(),
    z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict(),
  ]),
});

/**
 * Installs the plugin of a dragged ZIP into the media storage and grants it the programs its
 * manifest names; it starts at the next start of the app. An installed plugin of the same id is
 * replaced. With `move`, the dragged file is removed once the plugin is installed.
 */
export const pluginsInstallService = defineService('plugins.install', {
  request: z.object({ file: droppedFile, move: z.boolean().optional() }).strict(),
  response: z.object({ id: pluginIdSchema }).strict(),
});

/** Starts a plugin at the next start of the app, or not; rejected for a locked one. */
export const pluginsSetEnabledService = defineService('plugins.set-enabled', {
  request: z.object({ key: pluginIdSchema, enabled: z.boolean() }).strict(),
  response: z.object({}).strict(),
  keyedBy: pluginsState,
});

/** Removes an installed plugin from the device; it is gone at the next start. */
export const pluginsRemoveService = defineService('plugins.remove', {
  request: z.object({ key: pluginIdSchema }).strict(),
  response: z.object({}).strict(),
  keyedBy: pluginsState,
});

/** A program a plugin starts, with its arguments; no shell runs it. */
export interface ProcessRequest {
  readonly program: string;
  readonly args: readonly string[];
}

/**
 * Programs of the device (ADR 0106): starts one that the rider granted to an installed plugin,
 * found where the platform finds programs, without a shell. `onLine` hears every line it writes;
 * aborting `signal` ends it. Resolves with its exit code; rejects for a program not granted or not
 * found.
 */
export interface ProcessRun {
  run(
    request: ProcessRequest,
    onLine?: (line: string, stream: 'out' | 'err') => void,
    signal?: AbortSignal,
  ): Promise<{ readonly code: number }>;
}

export const processRunCapability = defineCapability<ProcessRun, 'single', 'process.run'>(
  'process.run',
  { cardinality: 'single' },
);
