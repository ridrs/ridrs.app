// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, type Secrets, storageSecretsCapability } from '@ridrs/contracts';
import { invoke } from '@tauri-apps/api/core';

const KEY = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;

function checked(key: string): string {
  if (!KEY.test(key)) {
    throw new Error(`Invalid secret key "${key}"`);
  }
  return key;
}

/**
 * `storage.secrets` in the native app (ADR 0053): the app's `secret_*` commands (`crates/ridrs-secrets`)
 * keep the secrets in an encrypted app file on the desktop and in the Keystore-backed store on
 * Android; neither asks the rider for anything.
 */
const tauriSecrets: Secrets = {
  async get(key) {
    return (await invoke<string | null>('secret_get', { key: checked(key) })) ?? undefined;
  },
  async set(key, value) {
    await invoke('secret_set', { key: checked(key), value });
  },
  async remove(key) {
    await invoke('secret_remove', { key: checked(key) });
  },
};

export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(storageSecretsCapability, tauriSecrets);
  },
});
