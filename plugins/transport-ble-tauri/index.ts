// SPDX-License-Identifier: AGPL-3.0-or-later

import { createTauriIpc, TauriBleCentral } from '@ridrs/ble-tauri';
import { bleCentralCapability, definePlugin } from '@ridrs/contracts';

export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(bleCentralCapability, new TauriBleCentral(createTauriIpc()));
  },
});
