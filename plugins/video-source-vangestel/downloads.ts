// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DataArchive, DataFetch, MediaFiles, RouteOffer } from '@ridrs/contracts';
import {
  besideControl,
  entryNamed,
  entryUrls,
  findControl,
  moveToControlFile,
  RIDE_PACKAGE,
} from '@ridrs/ride';

export type Availability = RouteOffer['availability'];

/** A route of the catalog as far as its download is concerned. */
export interface Downloadable {
  /** The offer's id, `<pluginId>/<route>`: also its folder below `videos/` in the media storage. */
  readonly id: string;
  readonly url: string;
  readonly size: number;
  readonly etag?: string;
}

/** What downloading takes; a missing part makes every download fail with a reason. */
export interface DownloadServices {
  readonly media?: MediaFiles;
  readonly fetch?: DataFetch;
  /** Unpacks a package whose video is compressed. */
  readonly archive?: DataArchive;
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
      const ready = await this.ready(media, route.id).catch(() => undefined);
      if (ready) {
        this.set(route.id, ready);
      }
    }
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

  /** Cancels the download of a route on its way; it can be downloaded again. Nothing else changes. */
  cancel(id: string): void {
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
    this.changed(id);
  }

  /**
   * A route on the device, with the URL of each of its entries as the media storage makes them
   * (ADR 0094); none when its folder holds no control file naming a video and a track it holds.
   */
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
