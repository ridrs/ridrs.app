// SPDX-License-Identifier: AGPL-3.0-or-later

// Hand-written client module (no build): a contribution that throws when it is mounted.
export function BrokenWidget() {
  throw new Error('this widget is broken on purpose');
}
