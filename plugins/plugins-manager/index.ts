// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  dataDropCapability,
  definePlugin,
  pluginsInstallService,
  pluginsPreviewService,
  pluginsRemoveService,
  pluginsSetEnabledService,
  pluginsState,
  storageAppFilesCapability,
  storageMediaCapability,
} from '@ridrs/contracts';
import { Plugins } from './plugins.ts';

// The plugins of the app and the ones the rider installs (ADR 0106): every plugin is a key of the
// app state `plugins.list`; `plugins.set-enabled` switches one on or off for the next start,
// `plugins.preview` and `plugins.install` read and install the ZIP of a plugin dragged onto the
// window, `plugins.remove` removes an installed one. The choices are a file of the app files that
// the app reads before it starts.
export default definePlugin({
  start(ctx) {
    let shown = new Set<string>();
    const plugins = new Plugins(
      {
        host: () => ctx.host.describe(),
        files: ctx.capabilities.find(storageAppFilesCapability),
        media: ctx.capabilities.find(storageMediaCapability),
        drop: ctx.capabilities.find(dataDropCapability),
      },
      (entries) => {
        for (const id of shown) if (!entries.has(id)) ctx.state.remove(pluginsState, id);
        for (const [id, entry] of entries) ctx.state.set(pluginsState, id, entry);
        shown = new Set(entries.keys());
      },
    );
    ctx.services.provide(pluginsPreviewService, ({ file }) => plugins.preview(file));
    ctx.services.provide(pluginsInstallService, async ({ file, move }) => ({ id: await plugins.install(file, move) }));
    ctx.services.provide(pluginsSetEnabledService, async ({ key, enabled }) => {
      await plugins.setEnabled(key, enabled);
      return {};
    });
    ctx.services.provide(pluginsRemoveService, async ({ key }) => {
      await plugins.remove(key);
      return {};
    });
    // The host lists the plugins after this one as initialized: they start once this start is done.
    plugins.load().catch((error: unknown) => ctx.logger.error({ error }, 'plugins-manager: the plugins could not be listed'));
  },
});
