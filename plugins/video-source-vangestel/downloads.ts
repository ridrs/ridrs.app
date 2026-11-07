// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DataFetch,
  type MediaFiles,
  type RouteOffer,
  VIDEO_ROUTE_FILE,
  type VideoImporter,
  type VideoRoute,
  type VideoRouteFacts,
  videoRouteSchema,
} from '@ridrs/contracts';

export type Availability = RouteOffer['availability'];

/** A route of the catalog as far as its download is concerned. */
export interface Downloadable {
  /** The offer's id, `<pluginId>/<route>`: also its folder below `videos/` in the media storage. */
  readonly id: string;
  readonly url: string;
  readonly size: number;
  readonly etag?: string;
  /** The package format, which chooses the importer. */
  readonly format: string;
  readonly facts: VideoRouteFacts;
}

/** What downloading takes; a missing part makes every download fail with a reason. */
export interface DownloadServices {
  readonly media?: MediaFiles;
  readonly fetch?: DataFetch;
  readonly importers: () => readonly VideoImporter[];
}

const folderOf = (id: string) => `videos/${id}`;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The downloads of a video source: which route is on the device, which is on its way and which
 * failed. A route needs its download first (docs/ideas/video-sources.md): `data.fetch` brings the
 * package into the media storage, the importer of its format makes a ridrs video route of it in
 * `videos/<offer id>/`, and the package goes. `changed` is called with the route's id after every
 * change of its state (ADR 0068: one offer at a time).
 */
export class VideoDownloads {
  private readonly states = new Map<string, Availability>();
  /** The downloads on their way, to cancel them. */
  private readonly running = new Map<string, AbortController>();
  private services: DownloadServices = { importers: () => [] };

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
      const file = `${folderOf(route.id)}/${VIDEO_ROUTE_FILE}`;
      if (await media.exists(file)) {
        // A route.json that does not parse is a broken route: it can be downloaded again.
        const stored = videoRouteSchema.safeParse(JSON.parse(new TextDecoder().decode(await media.read(file))));
        if (stored.success) {
          this.set(route.id, this.ready(media, route.id, stored.data));
        }
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
    if (!this.services.importers().some((candidate) => candidate.format === route.format)) {
      return `No importer reads the format "${route.format}"`;
    }
    return undefined;
  }

  /** Downloads a route that is not on the device and not on its way; resolves when done or failed. */
  async fetch(id: string): Promise<void> {
    const route = this.routes.find((candidate) => candidate.id === id);
    const state = this.availability(id).state;
    if (!route || state === 'ready' || state === 'fetching') {
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
      const importer = this.services.importers().find((candidate) => candidate.format === route.format);
      if (!importer) {
        throw new Error(`No importer reads the format "${route.format}"`);
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
      let imported: VideoRoute;
      try {
        imported = await importer.import(pack, folder, route.facts);
      } catch (error) {
        await media.remove(folder);
        throw error;
      }
      await media.remove(pack);
      this.set(id, this.ready(media, id, imported));
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

  /** A route on the device, with the URL of each of its files as the media storage makes them. */
  private ready(media: MediaFiles, id: string, route: VideoRoute): Availability {
    const names = [VIDEO_ROUTE_FILE, route.video.file, route.track.file];
    return {
      state: 'ready',
      files: Object.fromEntries(names.map((name) => [name, media.url(`${folderOf(id)}/${name}`)])),
      removable: true,
    };
  }

  private set(id: string, availability: Availability): void {
    this.states.set(id, availability);
    this.changed(id);
  }
}
