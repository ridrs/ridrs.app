// SPDX-License-Identifier: Apache-2.0

import semver from 'semver';
import { z } from 'zod';

import {
  capabilityIdSchema,
  dottedIdPattern,
  eventIdSchema,
  pluginIdPattern,
  pluginIdSchema,
} from './manifest-ids.ts';
import { uiManifestSectionSchema } from './ui.ts';

export { capabilityIdSchema, dottedIdPattern, eventIdSchema, pluginIdPattern, pluginIdSchema };

/**
 * What a plugin may do beyond its own events and capabilities. `observe-host` grants
 * `ctx.host`: every event and diagnostic of the host, and a description of the host.
 */
export const hostPermissionSchema = z.enum(['observe-host']);

export type HostPermission = z.infer<typeof hostPermissionSchema>;

/** Settings scopes a plugin may keep documents in (ADR 0054, `user` since ADR 0059). */
export const persistenceScopeSchema = z.enum(['machine', 'user']);

/**
 * Plugin types on the input side that may keep settings: what they read only decides which
 * inputs arrive. Values that affect the simulation enter as inputs instead (ADR 0052).
 */
export const PERSISTENCE_TYPES: readonly string[] = ['transport', 'storage', 'ui', 'device'];

/**
 * Plugin types that may use app state and services (ADR 0068, ADR 0069): the input side and the
 * recorder and its exports, none of which a replay runs as simulation.
 */
export const APP_CHANNEL_TYPES: readonly string[] = [...PERSISTENCE_TYPES, 'recording', 'export'];

/**
 * App channel types that run in a replay (they decode recorded raw data): they may own state and
 * provide services, but never read state or call services (ADR 0069).
 */
const REPLAYED_APP_CHANNEL_TYPES: readonly string[] = ['device'];

/** App state topics a plugin owns keys of and watches (ADR 0068). */
export const manifestStateSchema = z
  .object({
    owns: z.array(eventIdSchema).default([]),
    watches: z.array(eventIdSchema).default([]),
  })
  .strict();

/** Services a plugin provides and calls (ADR 0068). */
export const manifestServicesSchema = z
  .object({
    provides: z.array(eventIdSchema).default([]),
    calls: z.array(eventIdSchema).default([]),
  })
  .strict();

const onInputSide = (types: readonly string[]): boolean =>
  types.some((type) => PERSISTENCE_TYPES.includes(type));

const usesAppChannels = (types: readonly string[]): boolean =>
  types.some((type) => APP_CHANNEL_TYPES.includes(type));

const replayed = (types: readonly string[]): boolean =>
  types.some((type) => REPLAYED_APP_CHANNEL_TYPES.includes(type));

export const manifestSchema = z
  .object({
    id: pluginIdSchema,
    name: z.string().min(1, 'Must be a non-empty string'),
    version: z
      .string()
      .refine((val) => semver.valid(val) !== null, 'Must be a valid semantic version'),
    types: z.array(z.string().min(1)).min(1, 'Must contain at least one plugin type'),
    provides: z.array(capabilityIdSchema),
    requires: z.array(capabilityIdSchema),
    /**
     * Capabilities the plugin uses when a plugin provides them: it starts after their providers
     * and may access them, but is not blocked without them (ADR 0053).
     */
    optionalRequires: z.array(capabilityIdSchema).optional(),
    entry: z.string().min(1, 'Must be a non-empty relative path'),
    ui: uiManifestSectionSchema.optional(),
    permissions: z.array(hostPermissionSchema).optional(),
    persistence: z.array(persistenceScopeSchema).optional(),
    /** App state beside the bus (ADR 0068); input-side types only. */
    state: manifestStateSchema.optional(),
    /** Services beside the bus (ADR 0068); input-side types only. */
    services: manifestServicesSchema.optional(),
  })
  .strict()
  .refine((manifest) => !manifest.persistence?.length || onInputSide(manifest.types), {
    path: ['persistence'],
    message: `Only plugins of the types ${PERSISTENCE_TYPES.join(', ')} may declare persistence: values that affect the simulation enter as inputs`,
  })
  .refine((manifest) => manifest.state === undefined || usesAppChannels(manifest.types), {
    path: ['state'],
    message: `Only plugins of the types ${APP_CHANNEL_TYPES.join(', ')} may declare state: simulation plugins never read app state`,
  })
  .refine((manifest) => manifest.services === undefined || usesAppChannels(manifest.types), {
    path: ['services'],
    message: `Only plugins of the types ${APP_CHANNEL_TYPES.join(', ')} may declare services: simulation plugins never call services`,
  })
  .refine(
    (manifest) =>
      !replayed(manifest.types) ||
      ((manifest.state?.watches.length ?? 0) === 0 && (manifest.services?.calls.length ?? 0) === 0),
    {
      path: ['state'],
      message: `Plugins of the types ${REPLAYED_APP_CHANNEL_TYPES.join(', ')} run in a replay: they may own state and provide services, but not watch state or call services`,
    },
  )
  .refine(
    (manifest) =>
      manifest.types.includes('ui') ||
      (manifest.ui?.state.length ?? 0) + (manifest.ui?.calls.length ?? 0) === 0,
    {
      path: ['ui'],
      message: 'Only plugins of the type ui may declare ui.state or ui.calls',
    },
  );

export type PluginManifest = z.infer<typeof manifestSchema>;

export type ManifestValidationResult =
  | { readonly success: true; readonly data: PluginManifest }
  | { readonly success: false; readonly message: string };

export function parseManifestJson(rawJson: string): ManifestValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Invalid JSON in manifest.json: ${reason}`,
    };
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    return {
      success: false,
      message: z.prettifyError(result.error),
    };
  }

  return {
    success: true,
    data: result.data,
  };
}
