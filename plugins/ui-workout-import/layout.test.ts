// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('is a dialog screen of the main screen layout (ADR 0071)', () => {
  const layout = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../ui-main-screen/layout.json'), 'utf8'),
  ) as { dialogs: string[] };
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, 'manifest.json'), 'utf8')) as {
    ui: { screens: { id: string }[] };
  };
  expect(layout.dialogs).toContain(manifest.ui.screens[0]?.id);
});
