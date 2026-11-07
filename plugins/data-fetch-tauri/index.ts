// SPDX-License-Identifier: AGPL-3.0-or-later

import { dataFetchCapability, definePlugin } from '@ridrs/contracts';
import { createTauriFetch } from './fetch.ts';

/** `data.fetch` in the native app: large downloads in Rust that survive interruptions. */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(dataFetchCapability, createTauriFetch());
  },
});
