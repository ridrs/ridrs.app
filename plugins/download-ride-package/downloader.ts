// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RouteDownload, RouteDownloader, RouteDownloadOption } from '@ridrs/contracts';
import { type Downloadable, type DownloadServices, VideoDownloads } from './downloads.ts';

/** The kind of download this downloader fetches: a route's package, with its video (ADR 0105). */
export const KIND = 'ride-package';

/** A package comes in one quality: as its source serves it. */
const PACKAGE = 'package';

type Overlay = NonNullable<Downloadable['overlay']>;

const isOverlay = (value: unknown): value is Overlay =>
  Array.isArray(value) &&
  value.every(
    (file) =>
      typeof file?.path === 'string' &&
      typeof file.size === 'number' &&
      typeof file.sha256 === 'string' &&
      typeof file.url === 'string',
  );

/**
 * A route's package as its source describes it: `url`, and optionally `etag` and `overlay` (the
 * files that improve the package, ADR 0094). None without a URL.
 */
export function toDownloadable(route: RouteDownload): Downloadable | undefined {
  const { url, etag, overlay } = route.details;
  if (typeof url !== 'string') return undefined;
  return {
    id: route.id,
    url,
    size: route.size,
    ...(typeof etag === 'string' ? { etag } : {}),
    ...(isOverlay(overlay) ? { overlay } : {}),
    ...(route.former ? { former: route.former } : {}),
  };
}

/**
 * The downloader of packages (ADR 0105): `data.fetch` brings a route's package into the media
 * storage, where it becomes the route's folder (ADR 0094). Each source that opens it gets its own
 * downloads; a package comes in one quality only.
 */
export function packageDownloader(services: DownloadServices): RouteDownloader {
  return {
    kinds: [KIND],
    open(changed) {
      const downloads = new VideoDownloads([], changed);
      const connected = downloads.connect(services);
      const sizeOf = (id: string) => {
        const availability = downloads.availability(id);
        return 'size' in availability ? availability.size : undefined;
      };
      return {
        // The routes are known at once, so that their sizes are right before any is found on the device.
        async setRoutes(routes) {
          const finding = downloads.setRoutes(routes.flatMap((route) => toDownloadable(route) ?? []));
          await Promise.all([connected, finding]);
        },
        availability: (id) => downloads.availability(id),
        pictures: (id) => downloads.picturesOf(id),
        refusal: (id, option) =>
          option !== undefined && option !== PACKAGE
            ? `There is no quality "${option}" of this route`
            : downloads.refusal(id),
        async options(id): Promise<readonly RouteDownloadOption[]> {
          const size = sizeOf(id);
          return [{ id: PACKAGE, label: 'Package', ...(size ? { size } : {}) }];
        },
        fetch: (id) => downloads.fetch(id),
        cancel: (id) => downloads.cancel(id),
        remove: (id) => downloads.remove(id),
        refresh: (id) => downloads.refresh(id),
      };
    },
  };
}
