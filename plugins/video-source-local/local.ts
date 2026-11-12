// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DataPick,
  type MediaFiles,
  type RouteImport,
  type RouteOffer,
  VIDEO_ROUTE_FILE,
  type VideoImporter,
  type VideoRoute,
} from '@ridrs/contracts';
import { z } from 'zod';
import { type TrackFacts, trackFacts } from './track-facts.ts';

export const PLUGIN = 'video-source-local';

/** The packages a rider brings: Incyclist's ZIP of control file, video and GPX track. */
export const FORMAT = 'incyclist-gpx-import';

/** Every imported route lies in `videos/<plugin>/<route>/`, as a downloaded one of a source does. */
const FOLDER = `videos/${PLUGIN}`;
/** The imported routes and what their tracks say, so that a start reads no track. */
const INDEX = `${FOLDER}/routes.json`;

const indexSchema = z
  .object({
    version: z.literal(1),
    routes: z.array(
      z
        .object({
          id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          title: z.string().min(1),
          distance: z.number().nonnegative(),
          ascent: z.number().nonnegative(),
          duration: z.number().positive().optional(),
          sparkline: z.array(z.number()).min(2),
        })
        .strict(),
    ),
  })
  .strict();

type Imported = z.infer<typeof indexSchema>['routes'][number];

/** What importing takes; without any of it the rider cannot import. */
export interface ImportServices {
  readonly media?: MediaFiles;
  readonly pick?: DataPick;
  readonly importers: () => readonly VideoImporter[];
}

/** Where the routes and the import go: the app state `route.offer` and `route.import` (ADR 0068). */
export interface ImportState {
  offer(id: string, offer: RouteOffer | undefined): void;
  importer(state: RouteImport | undefined): void;
}

/** A route's title from its package's name: `Col_de_la_Madone.zip` is `Col de la Madone`. */
export function titleOf(fileName: string): string {
  const title = fileName
    .replace(/\.zip$/i, '')
    .replace(/[_]+/g, ' ')
    .trim();
  return title || 'Video';
}

/** A route's folder name from its title: lower case letters and digits joined by `-`. */
export function slugOf(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'video';
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The routes a rider imported from packages of their own (ADR 0090). `import` asks for a package
 * in the system's open dialog and answers once it closed; the package is then copied into the
 * media storage, the importer of its format makes a ridrs video route of it in its folder, and the
 * package goes. An imported route is on this device and can be removed; nothing else changes it.
 */
export class LocalVideos {
  private routes: Imported[] = [];
  private services: ImportServices = { importers: () => [] };
  private running: Promise<void> | undefined;
  private last: RouteImport = { kind: 'video', state: 'idle' };

  constructor(private readonly state: ImportState) {}

  /** Connects the services, offers the routes on the device and, if it can, the import. */
  async connect(services: ImportServices): Promise<void> {
    this.services = services;
    const { media } = services;
    if (!media) return;
    if (await media.exists(INDEX)) {
      const stored = indexSchema.safeParse(JSON.parse(new TextDecoder().decode(await media.read(INDEX))));
      for (const route of stored.success ? stored.data.routes : []) {
        // A folder without its route.json is a broken import: it is not offered.
        if (await media.exists(`${FOLDER}/${route.id}/${VIDEO_ROUTE_FILE}`)) this.routes.push(route);
      }
    }
    for (const route of this.routes) this.state.offer(this.offerId(route.id), this.offerOf(media, route));
    if (this.importer() && services.pick) this.state.importer(this.last);
  }

  /**
   * Asks for a package and imports it; resolves once the dialog closed, `false` when the rider
   * cancelled. Refuses while an import is on its way, or when this app cannot import.
   */
  async import(): Promise<boolean> {
    const { media, pick } = this.services;
    const importer = this.importer();
    if (!media || !pick || !importer) throw new Error('This app cannot import videos');
    if (this.running) throw new Error('An import is on its way');
    const chosen = await pick.pick({ name: 'Incyclist', extensions: ['zip'] });
    if (!chosen) return false;
    const title = titleOf(chosen.name);
    const id = this.freeId(slugOf(title));
    this.set({ kind: 'video', state: 'importing', file: chosen.name });
    // A host that stopped meanwhile takes no more state: the import ends without a word.
    this.running = this.run(media, importer, chosen, id, title).catch(() => undefined);
    return true;
  }

  /** Removes an imported route from the device and from the offers. */
  async remove(key: string): Promise<void> {
    const { media } = this.services;
    const route = this.routes.find((candidate) => this.offerId(candidate.id) === key);
    if (!media || !route) throw new Error(`There is no imported route "${key}"`);
    this.routes = this.routes.filter((candidate) => candidate !== route);
    await this.save(media);
    await media.remove(`${FOLDER}/${route.id}`);
    this.state.offer(key, undefined);
  }

  /** Resolves once the import on its way, if any, is done or failed. */
  async settled(): Promise<void> {
    await this.running;
  }

  private async run(
    media: MediaFiles,
    importer: VideoImporter,
    chosen: { readonly name: string; copyTo(target: string): Promise<void> },
    id: string,
    title: string,
  ): Promise<void> {
    const folder = `${FOLDER}/${id}`;
    const pack = `${folder}.zip`;
    let next: RouteImport;
    let offer: RouteOffer | undefined;
    try {
      await chosen.copyTo(pack);
      await media.remove(folder);
      let route: VideoRoute;
      let facts: TrackFacts;
      try {
        route = await importer.import(pack, folder, { title });
        facts = trackFacts(new TextDecoder().decode(await media.read(`${folder}/${route.track.file}`)));
      } catch (error) {
        await media.remove(folder);
        throw error;
      }
      const imported: Imported = { id, title, ...facts, sparkline: [...facts.sparkline] };
      this.routes.push(imported);
      await this.save(media);
      offer = this.offerOf(media, imported, route);
      next = { kind: 'video', state: 'idle' };
    } catch (error) {
      next = { kind: 'video', state: 'failed', file: chosen.name, reason: reasonOf(error) };
    }
    // The package goes before the import says it is done: a done import leaves nothing behind.
    await media.remove(pack).catch(() => undefined);
    this.running = undefined;
    if (offer) this.state.offer(offer.id, offer);
    this.set(next);
  }

  private importer(): VideoImporter | undefined {
    return this.services.importers().find((candidate) => candidate.format === FORMAT);
  }

  /** `id`, or `id-2`, `id-3`, … when a route has it already. */
  private freeId(id: string): string {
    const taken = (candidate: string) => this.routes.some((route) => route.id === candidate);
    let free = id;
    for (let n = 2; taken(free); n += 1) free = `${id}-${n}`;
    return free;
  }

  private offerId(id: string): string {
    return `${PLUGIN}/${id}`;
  }

  private offerOf(media: MediaFiles, route: Imported, stored?: VideoRoute): RouteOffer {
    const folder = `${FOLDER}/${route.id}`;
    const names = [VIDEO_ROUTE_FILE, stored?.video.file ?? 'video.mp4', stored?.track.file ?? 'track.gpx'];
    const id = this.offerId(route.id);
    return {
      id,
      kind: 'video',
      title: route.title,
      distance: route.distance,
      ascent: route.ascent,
      ...(route.duration ? { duration: route.duration } : {}),
      sparkline: [...route.sparkline],
      tags: {},
      availability: {
        state: 'ready',
        files: Object.fromEntries(names.map((name) => [name, media.url(`${folder}/${name}`)])),
        removable: true,
      },
      world: { landscape: 'ui-world-video/landscape', route: id },
    };
  }

  private async save(media: MediaFiles): Promise<void> {
    const index = indexSchema.parse({ version: 1, routes: this.routes });
    await media.write(INDEX, new TextEncoder().encode(`${JSON.stringify(index)}\n`));
  }

  private set(state: RouteImport): void {
    this.last = state;
    this.state.importer(state);
  }
}
