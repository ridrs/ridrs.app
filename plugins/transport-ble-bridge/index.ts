// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  bleBridgeConnectorCapability,
  bleCentralCapability,
  definePlugin,
  type PluginContext,
} from '@ridrs/contracts';
import { BridgeLink } from './bridge-link.ts';

const links = new WeakMap<PluginContext, BridgeLink>();

export default definePlugin({
  initialize(ctx) {
    const link = new BridgeLink(ctx);
    links.set(ctx, link);
    ctx.capabilities.provide(bleCentralCapability, link.central);
  },

  start(ctx) {
    links.get(ctx)?.start(ctx.capabilities.get(bleBridgeConnectorCapability));
  },

  stop(ctx) {
    links.get(ctx)?.stop();
  },
});
