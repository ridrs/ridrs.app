// SPDX-License-Identifier: AGPL-3.0-or-later

import { join } from 'node:path';
import { definePlugin, storageMediaCapability } from '@ridrs/contracts';
import envPaths from 'env-paths';
import { createNodeMediaFiles } from './media.ts';

/** Overrides the media folder, e.g. for tests. */
export const MEDIA_DIR_ENV = 'RIDRS_MEDIA_DIR';

/** `media` in the per-OS app data directory, or the override. */
export function mediaDirectory(): string {
  return process.env[MEDIA_DIR_ENV] || join(envPaths('ridrs', { suffix: '' }).data, 'media');
}

/** `storage.media` for the headless host and the tests: large files on the device's disk. */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(storageMediaCapability, createNodeMediaFiles(mediaDirectory()));
  },
});
