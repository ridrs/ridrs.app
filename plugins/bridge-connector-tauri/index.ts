// SPDX-License-Identifier: AGPL-3.0-or-later

import { createTauriIpc } from '@ridrs/ble-tauri';
import { bleBridgeConnectorCapability, definePlugin } from '@ridrs/contracts';
import { TauriBridgeConnector, webStoragePairingStore } from './tauri-bridge-connector.ts';

export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(
      bleBridgeConnectorCapability,
      new TauriBridgeConnector(createTauriIpc(), webStoragePairingStore()),
    );
  },
});
