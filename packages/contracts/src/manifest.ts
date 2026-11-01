// SPDX-License-Identifier: Apache-2.0

import semver from 'semver';
import { z } from 'zod';

export const pluginIdPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const dottedIdPattern = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;

export const pluginIdSchema = z
  .string()
  .regex(pluginIdPattern, 'Must be lowercase kebab-case (e.g. "example-ping")');

export const capabilityIdSchema = z
  .string()
  .regex(dottedIdPattern, 'Must be a lowercase dotted identifier (e.g. "demo.clock")');

export const eventIdSchema = z
  .string()
  .regex(dottedIdPattern, 'Must be a lowercase dotted identifier (e.g. "core.host.started")');

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
    entry: z.string().min(1, 'Must be a non-empty relative path'),
  })
  .strict();

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
