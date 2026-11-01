// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineCapability, definePlugin, type PluginContext } from '@ridrs/contracts';
import { getActiveWorld, type LifecycleHookName } from './world.ts';

async function runLifecycleHook(ctx: PluginContext, hook: LifecycleHookName): Promise<void> {
  const world = getActiveWorld();
  const pluginId = ctx.manifest.id;
  const behavior = world.getBehavior(pluginId);

  world.lifecycleCalls.push({ plugin: pluginId, hook });
  world.hookTimeline.push({ plugin: pluginId, hook, phase: 'called' });

  if (behavior.asyncHooks.has(hook)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const throwMessage = behavior.throwInHook.get(hook);
  if (throwMessage !== undefined) {
    throw new Error(throwMessage);
  }

  if (hook === 'initialize') {
    for (const [extraCapId, impl] of behavior.extraProvideCapabilities.entries()) {
      const contract =
        world.capabilityContracts.get(extraCapId) ??
        defineCapability(extraCapId, { cardinality: 'single' });
      ctx.capabilities.provide(contract, impl);
    }

    for (const capId of ctx.manifest.provides) {
      if (behavior.skipProvideCapabilities.has(capId)) {
        continue;
      }
      const contract =
        world.capabilityContracts.get(capId) ?? defineCapability(capId, { cardinality: 'single' });
      const impl = behavior.providedImplementations.get(capId) ?? {};
      ctx.capabilities.provide(contract, impl);
    }
  }

  world.hookTimeline.push({ plugin: pluginId, hook, phase: 'completed' });
}

export default definePlugin({
  async initialize(ctx) {
    await runLifecycleHook(ctx, 'initialize');
  },
  async start(ctx) {
    await runLifecycleHook(ctx, 'start');
  },
  async stop(ctx) {
    await runLifecycleHook(ctx, 'stop');
  },
  async dispose(ctx) {
    await runLifecycleHook(ctx, 'dispose');
  },
});
