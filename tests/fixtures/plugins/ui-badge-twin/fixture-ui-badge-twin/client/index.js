// SPDX-License-Identifier: AGPL-3.0-or-later

// Hand-written client module (no build): a second provider of `ui.test-badge`, never mounted.
export function Badge(container) {
  container.textContent = 'The other badge';
  return { update() {}, release() {} };
}
