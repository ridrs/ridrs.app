// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RowKind } from './devices.ts';

/**
 * The kind whose details the setup opens with: a row of the devices tile asks for it before it
 * navigates. Both live in this plugin's one client module, so a module variable carries it.
 */
let requested: RowKind | undefined;

export function requestDetails(kind: RowKind): void {
  requested = kind;
}

/** The kind asked for, once; afterwards the setup opens with its rows again. */
export function takeRequestedDetails(): RowKind | undefined {
  const kind = requested;
  requested = undefined;
  return kind;
}
