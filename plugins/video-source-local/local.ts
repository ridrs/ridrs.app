// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DataDrop,
  type DataPick,
  type DroppedFile,
  type MediaFiles,
  type PickedFile,
  type RouteImport,
  type RouteImportPreview,
  type RouteOffer,
} from '@ridrs/contracts';
import {
  besideControl,
  decodeText,
  entryNamed,
  entryUrls,
  findControl,
  inspectPackage,
  moveToControlFile,
  pictureOf,
  RIDE_PACKAGE,
} from '@ridrs/ride';
import { z } from 'zod';
import { type TrackFacts, trackFacts } from './track-facts.ts';

export const PLUGIN = 'video-source-local';

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
          /** The picture's file in the route's folder, where the package brought one. */
          thumbnail: z.string().min(1).optional(),
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
  /** Files dragged onto the window (ADR 0093). */
  readonly drop?: DataDrop;
}

/** Where the routes and the import go: the app state `route.offer` and `route.import` (ADR 0068). */
export interface ImportState {
  offer(id: string, offer: RouteOffer | undefined): void;
  importer(state: RouteImport | undefined): void;
}

/** The extensions of Incyclist packages: `.ride` is the same ZIP under the name ridrs gives it (ADR 0093). */
export const PACKAGE_EXTENSIONS = ['zip', 'ride'] as const;

/** A route's title from its package's name: `Col_de_la_Madone.zip` and `Col_de_la_Madone.ride` are `Col de la Madone`. */
export function titleOf(fileName: string): string {
  const title = fileName
    .replace(/\.(zip|ride)$/i, '')
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

/** A picture's bytes as a URL an `<img>` can show before anything is copied. */
function pictureUrl(name: string, bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const type = name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  return `data:${type};base64,${btoa(binary)}`;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The routes a rider imported from packages of their own (ADR 0090). `import` asks for a package
 * in the system's open dialog and answers once it closed; the package is then stored as the
 * route's folder (ADR 0094): copied as `route.ride` where its video is stored, else unpacked from
 * where it lies. Nothing is renamed or written beside it. An imported route is on this device and
 * can be removed; nothing else changes it.
 */
export class LocalVideos {
  private routes: Imported[] = [];
  private services: ImportServices = {};
  private running: Promise<void> | undefined;
  private last: RouteImport = { kind: 'video', state: 'idle' };

  constructor(private readonly state: ImportState) {}

  /** Connects the services, offers the routes on the device and, if it can, the import. */
  async connect(services: ImportServices): Promise<void> {
    this.services = services;
    const { media } = services;
    if (!media) return;
    const offers: RouteOffer[] = [];
    if (await media.exists(INDEX)) {
      const stored = indexSchema.safeParse(JSON.parse(new TextDecoder().decode(await media.read(INDEX))));
      for (const route of stored.success ? stored.data.routes : []) {
        // A route imported before ADR 0094 gets its control file; a folder without one is a
        // broken import: it is not offered.
        await moveToControlFile(media, `${FOLDER}/${route.id}`).catch(() => false);
        const offer = await this.offerOf(media, route).catch(() => undefined);
        if (offer) {
          this.routes.push(route);
          offers.push(offer);
        }
      }
    }
    for (const offer of offers) this.state.offer(offer.id, offer);
    if (services.pick || services.drop) this.state.importer(this.last);
  }

  /**
   * Asks for a package and imports it; resolves once the dialog closed, `false` when the rider
   * cancelled. With `file`, imports that file dragged onto the window instead (ADR 0093). Refuses
   * while an import is on its way, or when this app cannot import.
   */
  async import(file?: string, move = false): Promise<boolean> {
    const { media, pick } = this.services;
    if (!media || (file === undefined && !pick)) throw new Error('This app cannot import videos');
    if (this.running) throw new Error('An import is on its way');
    // A dragged package was previewed: its route is listed with its track's facts at once.
    const previewed = file === undefined ? undefined : await this.preview(file).catch(() => undefined);
    if (this.running) throw new Error('An import is on its way');
    const chosen =
      file === undefined
        ? await pick?.pick({ name: 'Incyclist', extensions: PACKAGE_EXTENSIONS })
        : this.dropped(file);
    if (!chosen) return false;
    // The title the package names, read by the preview; a picked package's shows once imported.
    // The folder keeps the file's name either way.
    const title = previewed?.ok ? previewed.preview.title : titleOf(chosen.name);
    const id = this.freeId(slugOf(titleOf(chosen.name)));
    this.set({ kind: 'video', state: 'importing', file: chosen.name });
    const listed = this.importingOffer(id, title, previewed?.ok ? previewed.preview : undefined);
    this.state.offer(listed.id, listed);
    // A host that stopped meanwhile takes no more state: the import ends without a word.
    // Moved onto the window, the package leaves where it lay once its route is imported.
    const moved = move && file !== undefined ? (chosen as DroppedFile) : undefined;
    this.running = this.run(media, chosen, id, title, this.progressOf(listed))
      .then(async (imported) => {
        if (imported && moved) await moved.removeOriginal();
      })
      .catch(() => undefined);
    return true;
  }

  /**
   * What a file dragged onto the window would be as a route, read from its package's track
   * without copying it; or why it cannot be imported (ADR 0093).
   */
  async preview(file: string): Promise<RouteImportPreview> {
    const dropped = this.dropped(file);
    const { entries } = await dropped.peek();
    if (!entries) return { ok: false, reason: 'The file is no ZIP package' };
    const inspection = inspectPackage(entries);
    if (!inspection.ok) return inspection;
    const track = entries.find((entry) => entry.name === inspection.track)?.bytes;
    if (!track) return { ok: false, reason: 'The track is too large for a preview' };
    let facts: TrackFacts;
    try {
      facts = trackFacts(new TextDecoder().decode(track));
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
    const picture = entries.find((entry) => entry.name === inspection.thumbnail)?.bytes;
    // Every picture a peek reads (PEEK_LIMIT) is shown: a photo of a few MB is the usual one.
    const thumbnail = inspection.thumbnail && picture ? pictureUrl(inspection.thumbnail, picture) : undefined;
    return {
      ok: true,
      preview: {
        kind: 'video',
        title: inspection.title ?? titleOf(dropped.name),
        distance: facts.distance,
        ascent: facts.ascent,
        ...(facts.duration === undefined ? {} : { duration: facts.duration }),
        sparkline: [...facts.sparkline],
        ...(thumbnail ? { thumbnail } : {}),
      },
    };
  }

  /** A file dragged onto the window, while the drag or its drop lasts. */
  private dropped(file: string): DroppedFile {
    const dropped = this.services.drop?.file(file);
    if (!dropped) throw new Error(`The dragged file "${file}" is gone`);
    return dropped;
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
    chosen: Pick<PickedFile, 'name' | 'peek' | 'copyTo' | 'extractTo'>,
    id: string,
    fallbackTitle: string,
    tell: (share: number) => void,
  ): Promise<boolean> {
    // A late word of the copy or the unpacking changes no route that is ready or gone.
    let open = true;
    const progress = (share: number) => {
      if (open) tell(share);
    };
    const folder = `${FOLDER}/${id}`;
    let next: RouteImport;
    let offer: RouteOffer | undefined;
    try {
      // What the package holds, read in place: its control file, and whether its video is stored.
      const { entries } = await chosen.peek();
      if (!entries) throw new Error('The file is no ZIP package');
      const inspection = inspectPackage(entries);
      if (!inspection.ok) throw new Error(inspection.reason);
      const stored = entries.find((entry) => entry.name === inspection.video)?.stored === true;
      const share = ({ received, size }: { received: number; size?: number }) => {
        if (size) progress(Math.min(received / size, 1));
      };
      await media.remove(folder);
      let imported: Imported;
      try {
        // A stored video plays from the ZIP: the package is kept as it is, a clone where it can
        // be. Any other is unpacked from where it lies, every file at its path (ADR 0094).
        if (stored) await chosen.copyTo(`${folder}/${RIDE_PACKAGE}`, share);
        else await chosen.extractTo(folder, share);
        imported = await this.importedOf(media, id, fallbackTitle);
      } catch (error) {
        await media.remove(folder);
        throw error;
      }
      this.routes.push(imported);
      await this.save(media);
      offer = await this.offerOf(media, imported);
      if (!offer) throw new Error('The imported route has no control file');
      next = { kind: 'video', state: 'idle' };
    } catch (error) {
      next = { kind: 'video', state: 'failed', file: chosen.name, reason: reasonOf(error) };
    }
    this.running = undefined;
    open = false;
    // The route listed while it was imported is ready now, or gone with the failure.
    this.state.offer(this.offerId(id), offer);
    this.set(next);
    return offer !== undefined;
  }

  /** A route stored in its folder: its title, its track's facts and its picture, from its entries. */
  private async importedOf(media: MediaFiles, id: string, fallbackTitle: string): Promise<Imported> {
    const folder = `${FOLDER}/${id}`;
    const paths = (await media.entries(folder)).map((entry) => entry.path);
    const found = await findControl(paths, (path) => media.read(`${folder}/${path}`));
    if (!found) throw new Error('The package has no control file that names its video and track');
    const { control } = found;
    const entry = (relative: string) => entryNamed(paths, besideControl(found.path, relative)) ?? relative;
    const facts = trackFacts(decodeText(await media.read(`${folder}/${entry(control.gpx)}`)));
    const picture = pictureOf(control, paths, entry(control.video));
    return {
      id,
      title: control.title ?? control.name ?? fallbackTitle,
      ...facts,
      sparkline: [...facts.sparkline],
      ...(picture ? { thumbnail: picture } : {}),
    };
  }

  /**
   * Tells how far the import of `listed` is, from 0 to 1, as its offer: once per whole percent,
   * so a large package does not flood the app state.
   */
  private progressOf(listed: RouteOffer): (share: number) => void {
    let shown = -1;
    return (share) => {
      const percent = Math.floor(share * 100);
      if (percent <= shown) return;
      shown = percent;
      this.state.offer(listed.id, { ...listed, availability: { state: 'importing', progress: percent / 100 } });
    };
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

  /** A route while it is imported: its title, and its track's facts where a preview read them. */
  private importingOffer(
    id: string,
    title: string,
    facts?: Pick<RouteOffer, 'distance' | 'ascent' | 'duration' | 'sparkline' | 'thumbnail'>,
  ): RouteOffer {
    const offerId = this.offerId(id);
    return {
      id: offerId,
      kind: 'video',
      title,
      distance: facts?.distance ?? 0,
      ascent: facts?.ascent ?? 0,
      ...(facts?.duration ? { duration: facts.duration } : {}),
      ...(facts?.sparkline ? { sparkline: [...facts.sparkline] } : {}),
      ...(facts?.thumbnail ? { thumbnail: facts.thumbnail } : {}),
      tags: {},
      availability: { state: 'importing' },
      world: { landscape: 'ui-world-video/landscape', route: offerId },
    };
  }

  /**
   * A route on the device, with the URL of each of its entries (ADR 0094); none when its folder
   * holds no control file naming a video and a track it holds.
   */
  private async offerOf(media: MediaFiles, route: Imported): Promise<RouteOffer | undefined> {
    const folder = `${FOLDER}/${route.id}`;
    const entries = await media.entries(folder);
    const paths = entries.map((entry) => entry.path);
    if (!(await findControl(paths, (path) => media.read(`${folder}/${path}`)))) return undefined;
    const id = this.offerId(route.id);
    return {
      id,
      kind: 'video',
      title: route.title,
      distance: route.distance,
      ascent: route.ascent,
      ...(route.duration ? { duration: route.duration } : {}),
      sparkline: [...route.sparkline],
      ...(route.thumbnail ? { thumbnail: media.url(`${folder}/${route.thumbnail}`) } : {}),
      tags: {},
      availability: {
        state: 'ready',
        files: entryUrls(media, folder, entries),
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
