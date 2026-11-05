// SPDX-License-Identifier: AGPL-3.0-or-later

import { createTauriIpc } from '@ridrs/ble-tauri';
import { bleBridgeConnectorCapability, definePlugin, storageSecretsCapability } from '@ridrs/contracts';
import { secretPairingStore, TauriBridgeConnector } from './tauri-bridge-connector.ts';

export default definePlugin({
  async initialize(ctx) {
    const pairings = await secretPairingStore(ctx.capabilities.get(storageSecretsCapability));
    ctx.capabilities.provide(
      bleBridgeConnectorCapability,
      new TauriBridgeConnector(createTauriIpc(), pairings),
    );
  },
});
