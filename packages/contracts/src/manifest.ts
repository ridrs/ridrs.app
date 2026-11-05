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

/** Settings scopes a plugin may keep documents in (ADR 0054). */
export const persistenceScopeSchema = z.enum(['machine']);

/**
 * Plugin types on the input side that may keep settings: what they read only decides which
 * inputs arrive. Values that affect the simulation enter as inputs instead (ADR 0052).
 */
export const PERSISTENCE_TYPES: readonly string[] = ['transport', 'storage', 'ui', 'device'];

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
  })
  .strict()
  .refine(
    (manifest) =>
      !manifest.persistence?.length ||
      manifest.types.some((type) => PERSISTENCE_TYPES.includes(type)),
    {
      path: ['persistence'],
      message: `Only plugins of the types ${PERSISTENCE_TYPES.join(', ')} may declare persistence: values that affect the simulation enter as inputs`,
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
