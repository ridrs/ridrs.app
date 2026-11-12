// SPDX-License-Identifier: AGPL-3.0-or-later

import { uiPathSchema } from '@ridrs/contracts';
import { z } from 'zod';

/** `<pluginId>/<contributionId>`, the key the shell gives every mounted contribution. */
const contributionKey = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'Expected "<pluginId>/<contributionId>"');

const span = z.number().int().min(1).max(12);

/**
 * Which contribution fills the menu, the top bar, which global actions sit beside the top bar and
 * which tiles, in which order and how wide, which screens the content area shows instead of the
 * tiles, beside the menu and the actions (ADR 0058), and which screens a dialog shows over the
 * page, leaving it as it is (ADR 0071). The layout is configuration: the screen's code never names
 * a contribution or another screen.
 */
export const layoutSchema = z
  .strictObject({
    version: z.literal(1),
    menu: contributionKey.optional(),
    topBar: contributionKey.optional(),
    actions: z.array(contributionKey).default([]),
    tiles: z.array(
      z.strictObject({
        contribution: contributionKey,
        columns: z.strictObject({ wide: span, medium: span.optional() }),
      }),
    ),
    screens: z.array(uiPathSchema).default([]),
    dialogs: z.array(uiPathSchema).default([]),
    /** Layers over everything the main screen shows, such as the one of dragged files (ADR 0093). */
    overlays: z.array(contributionKey).default([]),
  })
  .superRefine(({ tiles, actions, screens, dialogs, overlays }, issues) => {
    for (const [field, keys] of [
      ['actions', actions],
      ['overlays', overlays],
    ] as const) {
      keys.forEach((key, index) => {
        if (keys.indexOf(key) !== index) {
          issues.addIssue({ code: 'custom', path: [field, index], message: `"${key}" is placed twice` });
        }
      });
    }
    const seen = new Set<string>();
    tiles.forEach(({ contribution }, index) => {
      if (seen.has(contribution)) {
        issues.addIssue({
          code: 'custom',
          path: ['tiles', index, 'contribution'],
          message: `"${contribution}" is placed twice`,
        });
      }
      seen.add(contribution);
    });
    screens.forEach((screen, index) => {
      if (screens.indexOf(screen) !== index) {
        issues.addIssue({
          code: 'custom',
          path: ['screens', index],
          message: `"${screen}" is named twice`,
        });
      }
    });
    dialogs.forEach((screen, index) => {
      if (dialogs.indexOf(screen) !== index || screens.includes(screen)) {
        issues.addIssue({
          code: 'custom',
          path: ['dialogs', index],
          message: `"${screen}" is named twice`,
        });
      }
    });
  });

export type Layout = z.infer<typeof layoutSchema>;
export type Tile = Layout['tiles'][number];

export type Breakpoint = 'wide' | 'medium' | 'compact';

/** The smallest width of each breakpoint, widest first. */
export const BREAKPOINTS: readonly (readonly [Breakpoint, number])[] = [
  ['wide', 1200],
  ['medium', 768],
  ['compact', 0],
];

export function breakpointAt(width: number): Breakpoint {
  return BREAKPOINTS.find(([, from]) => width >= from)?.[0] ?? 'compact';
}

/** The columns of 12 a tile spans: compact stacks every tile, medium falls back to wide. */
export function columnsAt(tile: Tile, breakpoint: Breakpoint): number {
  if (breakpoint === 'compact') {
    return 12;
  }
  return breakpoint === 'medium' ? (tile.columns.medium ?? tile.columns.wide) : tile.columns.wide;
}
