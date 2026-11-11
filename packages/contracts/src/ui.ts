// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineEvent } from './events.ts';
import { eventIdSchema } from './manifest-ids.ts';

/** Navigation paths and extension points: lowercase kebab-case segments separated by `/`. */
export const uiPathPattern = /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/;

export const uiPathSchema = z
  .string()
  .regex(
    uiPathPattern,
    'Must be lowercase kebab-case segments separated by "/" (e.g. "activity/hud")',
  );

const exportNameSchema = z.string().min(1, 'Must name an export of the client module');

const clientPathSchema = z
  .string()
  .min(1, 'Must be a non-empty relative path')
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes(':') &&
      !path.split('/').some((segment) => segment === '..'),
    'Must be a relative path inside the plugin folder',
  );

export const uiScreenSchema = z
  .object({
    id: uiPathSchema,
    export: exportNameSchema,
    extensionPoints: z.array(uiPathSchema).default([]),
  })
  .strict();

export const uiContributionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Must be lowercase kebab-case'),
    extensionPoint: uiPathSchema,
    export: exportNameSchema,
    order: z.number().default(0),
    extensionPoints: z.array(uiPathSchema).default([]),
  })
  .strict();

/** A UI capability the plugin provides (ADR 0083): its id and the export of the client module. */
export const uiProvidedCapabilitySchema = z
  .object({
    capability: eventIdSchema.refine((id) => id.startsWith('ui.'), 'Must start with "ui."'),
    export: exportNameSchema,
  })
  .strict();

export const uiEventsSchema = z
  .object({
    subscribe: z.array(eventIdSchema).default([]),
    publish: z.array(eventIdSchema).default([]),
  })
  .strict();

export const uiManifestSectionSchema = z
  .object({
    client: clientPathSchema.optional(),
    screens: z.array(uiScreenSchema).default([]),
    contributions: z.array(uiContributionSchema).default([]),
    events: uiEventsSchema.default({ subscribe: [], publish: [] }),
    /** App state topics the client code watches (ADR 0068). */
    state: z.array(eventIdSchema).default([]),
    /** Services the client code calls (ADR 0068). */
    calls: z.array(eventIdSchema).default([]),
    /** UI capabilities the plugin provides (ADR 0083); each has exactly one provider. */
    provides: z.array(uiProvidedCapabilitySchema).default([]),
    /** UI capabilities the client code draws with `ctx.render` (ADR 0083). */
    uses: z.array(eventIdSchema).default([]),
  })
  .strict()
  .superRefine((ui, issues) => {
    if (
      (ui.screens.length > 0 || ui.contributions.length > 0 || ui.provides.length > 0) &&
      ui.client === undefined
    ) {
      issues.addIssue({
        code: 'custom',
        path: ['client'],
        message: 'Required when the plugin declares screens, contributions or UI capabilities',
      });
    }
    const seen = new Set<string>();
    ui.contributions.forEach((contribution, index) => {
      if (seen.has(contribution.id)) {
        issues.addIssue({
          code: 'custom',
          path: ['contributions', index, 'id'],
          message: `Duplicate contribution id "${contribution.id}"`,
        });
      }
      seen.add(contribution.id);
    });
    const provided = new Set<string>();
    ui.provides.forEach((entry, index) => {
      if (provided.has(entry.capability)) {
        issues.addIssue({
          code: 'custom',
          path: ['provides', index, 'capability'],
          message: `Duplicate UI capability "${entry.capability}"`,
        });
      }
      provided.add(entry.capability);
    });
  });

export type UiManifestSection = z.infer<typeof uiManifestSectionSchema>;

export interface UiRegistryScreen {
  readonly pluginId: string;
  readonly id: string;
  readonly export: string;
  readonly extensionPoints: readonly string[];
  readonly client: string;
}

export interface UiRegistryContribution {
  readonly pluginId: string;
  readonly id: string;
  readonly extensionPoint: string;
  readonly export: string;
  readonly order: number;
  readonly extensionPoints: readonly string[];
  readonly client: string;
}

export interface UiRegistryEvents {
  readonly subscribe: readonly string[];
  readonly publish: readonly string[];
}

export interface UiRegistryPlugin {
  readonly pluginId: string;
  readonly events: UiRegistryEvents;
  readonly state: readonly string[];
  readonly calls: readonly string[];
}

/**
 * Screens, extension points and contributions of the plugins that are currently started, as the
 * core indexes them. The core validates and orders; it never interprets what any entry means.
 */
export interface UiRegistry {
  readonly revision: number;
  readonly screens: readonly UiRegistryScreen[];
  readonly contributions: readonly UiRegistryContribution[];
  /** Union over all started UI plugins: the bridge allow-list. */
  readonly events: UiRegistryEvents;
  /** Union of `ui.state` over all started UI plugins: the topics the bridge lets clients watch. */
  readonly state: readonly string[];
  /** Union of `ui.calls` over all started UI plugins: the services the bridge lets clients call. */
  readonly calls: readonly string[];
  /** Each started UI plugin's own lists, which bound what its client code may use. */
  readonly plugins: readonly UiRegistryPlugin[];
}

export const uiRegistryChangedEvent = defineEvent(
  'core.ui-registry.changed',
  z.object({ revision: z.number().int().nonnegative() }),
);
