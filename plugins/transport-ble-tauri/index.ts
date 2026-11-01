// SPDX-License-Identifier: AGPL-3.0-or-later

import { bleCentralCapability, definePlugin } from '@ridrs/contracts';
import { createTauriIpc } from './ipc.ts';
import { TauriBleCentral } from './tauri-ble-central.ts';

export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(bleCentralCapability, new TauriBleCentral(createTauriIpc()));
  },
});
