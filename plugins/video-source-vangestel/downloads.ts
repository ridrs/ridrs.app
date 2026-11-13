// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DataArchive, DataFetch, DataPicture, MediaFiles, RouteOffer } from '@ridrs/contracts';
import {
  besideControl,
  entryNamed,
  entryUrls,
  findControl,
  makeTile,
  moveToControlFile,
  RIDE_PACKAGE,
  routePicture,
  TILE_FILE,
} from '@ridrs/ride';

export type Availability = RouteOffer['availability'];

/** A route of the catalog as far as its download is concerned. */
export interface Downloadable {
  /** The offer's id, `<pluginId>/<route>`: also its folder below `videos/` in the media storage. */
  readonly id: string;
  readonly url: string;
  readonly size: number;
  readonly etag?: string;
  /**
   * The catalog's files that improve the route's package (ADR 0094), by their paths in its folder:
   * their hashes, and the URLs the app ships them at.
   */
  readonly overlay?: readonly { readonly path: string; readonly sha256: string; readonly url: string }[];
}

/** A route's pictures on the device: its picture and its small one for a card, as URLs. */
export interface RoutePictures {
  readonly thumbnail?: string;
  readonly tile?: string;
}

/** The hashes of the overlay files copied into a route's folder, by their paths: hidden, no entry. */
const OVERLAY_FILE = '.overlay.json';

/** What downloading takes; a missing part makes every download fail with a reason. */
export interface DownloadServices {
  readonly media?: MediaFiles;
  readonly fetch?: DataFetch;
  /** Unpacks a package whose video is compressed. */
  readonly archive?: DataArchive;
  /** Makes a route's small picture; without it a card shows the full one. */
  readonly picture?: DataPicture;
}

const folderOf = (id: string) => `videos/${id}`;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The downloads of a video source: which route is on the device, which is on its way and which
 * failed. A route needs its download first (docs/ideas/video-sources.md): `data.fetch` brings the
 * package into the media storage, and it becomes the route's folder `videos/<offer id>/` (ADR
 * 0094): kept as `route.ride` where its video is stored, unpacked there otherwise. Nothing is
 * renamed. `changed` is called with the route's id after every change of its state (ADR 0068: one
 * offer at a time).
 */
export class VideoDownloads {
  private readonly states = new Map<string, Availability>();
  /** The pictures of the routes on the device. */
  private readonly pictures = new Map<string, RoutePictures>();
  /** The downloads on their way, to cancel them. */
  private readonly running = new Map<string, AbortController>();
  private services: DownloadServices = {};

  constructor(
    private readonly routes: readonly Downloadable[],
    private readonly changed: (id: string) => void,
  ) {}

  /** Connects the services and finds the routes already on the device. */
  async connect(services: DownloadServices): Promise<void> {
    this.services = services;
    const { media } = services;
    if (!media) {
      return;
    }
    for (const route of this.routes) {
      const folder = folderOf(route.id);
      // A route downloaded before ADR 0094 gets its control file; one without is a broken route
      // and can be downloaded again.
      await moveToControlFile(media, folder).catch(() => false);
      if (!(await this.ready(media, route.id).catch(() => undefined))) continue;
      // A route downloaded before the catalog changed gets its current overlay; its offer then
      // names the overlay's files too.
      await this.improve(media, route).catch(() => undefined);
      const ready = await this.ready(media, route.id).catch(() => undefined);
      if (ready) {
        this.set(route.id, ready);
      }
    }
  }

  /** The pictures of a route on the device, where it has them; none for one to download. */
  picturesOf(id: string): RoutePictures {
    return this.pictures.get(id) ?? {};
  }

  availability(id: string): Availability {
    const route = this.routes.find((candidate) => candidate.id === id);
    return this.states.get(id) ?? { state: 'fetchable', size: route?.size ?? 1 };
  }

  /** Why a download of the route cannot start now; none when it can (or needs none). */
  refusal(id: string): string | undefined {
    const route = this.routes.find((candidate) => candidate.id === id);
    if (!route) {
      return `There is no route "${id}"`;
    }
    const { media, fetch } = this.services;
    if (!media || !fetch) {
      return 'This app cannot download routes yet';
    }
    return undefined;
  }

  /** Downloads a route that is not on the device and not on its way; resolves when done or failed. */
  async fetch(id: string): Promise<void> {
    const route = this.routes.find((candidate) => candidate.id === id);
    const state = this.availability(id).state;
    if (!route || state === 'ready' || state === 'fetching' || state === 'importing') {
      return;
    }
    this.set(id, { state: 'fetching', received: 0, size: route.size });
    const controller = new AbortController();
    this.running.set(id, controller);
    try {
      const { media, fetch } = this.services;
      if (!media || !fetch) {
        throw new Error('This app cannot download routes yet');
      }
      const pack = `${folderOf(route.id)}.zip`;
      let percent = 0;
      await fetch.fetch({ url: route.url, target: pack, expected: { size: route.size, etag: route.etag } }, (progress) => {
        const size = progress.size ?? route.size;
        const now = Math.floor((progress.received / size) * 100);
        if (now !== percent && !controller.signal.aborted) {
          percent = now;
          this.set(id, { state: 'fetching', received: Math.min(progress.received, size), size });
        }
      }, controller.signal);
      if (controller.signal.aborted) {
        // Cancelled as the last bytes arrived: the package goes, the route was not imported.
        await media.remove(pack);
        throw controller.signal.reason;
      }
      const folder = folderOf(route.id);
      await media.remove(folder);
      let ready: Availability | undefined;
      try {
        await this.store(media, id, pack);
        // The catalog's overlay and the small picture improve the route; without them it still plays.
        await this.improve(media, route).catch(() => undefined);
        ready = await this.ready(media, id);
        if (!ready) {
          throw new Error('The downloaded package has no control file that names its video and track');
        }
      } catch (error) {
        await media.remove(folder);
        await media.remove(pack);
        throw error;
      }
      this.set(id, ready);
    } catch (error) {
      if (controller.signal.aborted) {
        // Cancelled: as before the download; the part stays, a new download goes on from it.
        this.states.delete(id);
        this.changed(id);
        return;
      }
      this.set(id, { state: 'failed', reason: reasonOf(error), size: route.size });
    } finally {
      this.running.delete(id);
    }
  }

  /**
   * Makes the downloaded package `pack` the route's folder: moved in as `route.ride`, and where its
   * video is not stored, unpacked beside it and removed, its progress the offer's (ADR 0094).
   */
  private async store(media: MediaFiles, id: string, pack: string): Promise<void> {
    const folder = folderOf(id);
    const ride = `${folder}/${RIDE_PACKAGE}`;
    await media.move(pack, ride);
    const entries = await media.entries(folder);
    const paths = entries.map((entry) => entry.path);
    const found = await findControl(paths, (path) => media.read(`${folder}/${path}`));
    if (!found) return;
    const video = entryNamed(paths, besideControl(found.path, found.control.video));
    if (entries.find((entry) => entry.path === video)?.stored !== false) return;
    const { archive } = this.services;
    if (!archive) throw new Error('This app cannot unpack the package: its video is compressed');
    let percent = -1;
    this.set(id, { state: 'importing' });
    await archive.extract(ride, folder, ({ received, size }) => {
      const now = size ? Math.floor((received / size) * 100) : 0;
      if (now > percent) {
        percent = now;
        this.set(id, { state: 'importing', progress: Math.min(now, 100) / 100 });
      }
    });
    await media.remove(ride);
  }

  /**
   * Cancels the download of a route on its way; it can be downloaded again. Nothing else changes.
   * A downloaded package being unpacked (`importing`) is no longer on its way: it is done in
   * seconds and goes on.
   */
  cancel(id: string): void {
    if (this.availability(id).state !== 'fetching') return;
    this.running.get(id)?.abort(new Error('The download was cancelled'));
  }

  /** Removes a downloaded route from the device; it can be downloaded again. */
  async remove(id: string): Promise<void> {
    const { media } = this.services;
    if (!media || this.availability(id).state !== 'ready') {
      return;
    }
    await media.remove(folderOf(id));
    this.states.delete(id);
    this.pictures.delete(id);
    this.changed(id);
  }

  /**
   * A route on the device, with the URL of each of its entries as the media storage makes them
   * (ADR 0094); none when its folder holds no control file naming a video and a track it holds.
   */
  /**
   * Copies the catalog's overlay files the route's folder lacks or has older (by their hashes) and
   * removes those the catalog dropped; then finds the route's picture and makes its small one
   * where it has none, or anew after its overlay changed (ADR 0094).
   */
  private async improve(media: MediaFiles, route: Downloadable): Promise<void> {
    const folder = folderOf(route.id);
    let copied: Record<string, string> = {};
    try {
      copied = JSON.parse(new TextDecoder().decode(await media.read(`${folder}/${OVERLAY_FILE}`)));
    } catch {
      // No overlay copied yet.
    }
    const overlay = route.overlay ?? [];
    let changed = false;
    for (const file of overlay) {
      if (copied[file.path] === file.sha256) continue;
      await media.writeFrom(file.url, `${folder}/${file.path}`);
      changed = true;
    }
    for (const path of Object.keys(copied)) {
      if (overlay.some((file) => file.path === path)) continue;
      await media.remove(`${folder}/${path}`);
      changed = true;
    }
    if (changed || Object.keys(copied).length !== overlay.length) {
      const hashes = Object.fromEntries(overlay.map((file) => [file.path, file.sha256]));
      await media.write(`${folder}/${OVERLAY_FILE}`, new TextEncoder().encode(`${JSON.stringify(hashes)}\n`));
    }
    const picture = await routePicture(media, folder);
    if (!picture) {
      this.pictures.delete(route.id);
      return;
    }
    const tile = await makeTile(media, this.services.picture, folder, picture, changed).catch(() => false);
    this.pictures.set(route.id, {
      thumbnail: media.url(`${folder}/${picture}`),
      ...(tile ? { tile: media.url(`${folder}/${TILE_FILE}`) } : {}),
    });
  }

  private async ready(media: MediaFiles, id: string): Promise<Availability | undefined> {
    const folder = folderOf(id);
    const entries = await media.entries(folder);
    const paths = entries.map((entry) => entry.path);
    if (!(await findControl(paths, (path) => media.read(`${folder}/${path}`)))) {
      return undefined;
    }
    return { state: 'ready', files: entryUrls(media, folder, entries), removable: true };
  }

  private set(id: string, availability: Availability): void {
    this.states.set(id, availability);
    this.changed(id);
  }
}
