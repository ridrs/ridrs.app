// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  dataArchiveCapability,
  dataFetchCapability,
  dataPictureCapability,
  definePlugin,
  routeDownloaderCapability,
  storageMediaCapability,
} from '@ridrs/contracts';
import { packageDownloader } from './downloader.ts';

// The downloader of route packages (ADR 0105): a source hands it each route whose download is a
// package (`ride-package`). `data.fetch` brings the package into the media storage, `data.archive`
// unpacks it where its video is compressed, `data.picture` makes the small picture of its card.
// Without `storage.media` or `data.fetch` every download fails with a reason.
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(
      routeDownloaderCapability,
      packageDownloader({
        media: ctx.capabilities.find(storageMediaCapability),
        fetch: ctx.capabilities.find(dataFetchCapability),
        archive: ctx.capabilities.find(dataArchiveCapability),
        picture: ctx.capabilities.find(dataPictureCapability),
      }),
    );
  },
});
