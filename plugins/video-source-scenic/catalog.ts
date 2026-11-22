// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppFiles, HttpClient } from '@ridrs/contracts';

/**
 * The ride catalog of ridrs Scenic (docs/formats/scenic-ride-catalog-v1.md): the parts this plugin
 * reads. Its URLs are absolute.
 */
export interface RideCatalog {
  readonly format: 'ridrs-scenic-ride-catalog';
  readonly version: number;
  readonly sources: Readonly<Record<string, CatalogSource>>;
  readonly routes: readonly CatalogRoute[];
}

export interface CatalogSource {
  readonly name: string;
  /** The source's one author; none where its routes name their own (YouTube: the channel). */
  readonly author?: string;
  readonly url: string;
  readonly license: { readonly id: string | null; readonly name: string; readonly url: string };
}

export interface CatalogRoute {
  /** Scenic's id, e.g. `vg-col-de-pennes`. */
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly page: string;
  /** Who made the route, where its source has no one author: a YouTube video's channel. */
  readonly author?: string;
  /** ISO 3166-1 alpha-2. */
  readonly country?: string;
  readonly level?: string;
  readonly tour?: { readonly name: string; readonly part: number };
  readonly distance: number;
  readonly ascent: number;
  readonly duration: number;
  readonly sparkline: readonly number[];
  readonly climbs: readonly {
    readonly category: string;
    readonly start: number;
    readonly end: number;
    readonly gain: number;
    readonly grade: number;
    readonly summit: number;
    readonly name?: string;
  }[];
  readonly tile?: string;
  readonly overlay: readonly { readonly path: string; readonly size: number; readonly sha256: string; readonly url: string }[];
  /**
   * The route's download; `kind` picks its downloader (ADR 0105), a package where it names none.
   * The other fields are the downloader's: a package's `etag`, a YouTube video's `video` and `fps`.
   */
  readonly download: {
    readonly kind?: string;
    readonly url: string;
    readonly format: string;
    readonly size: number;
    readonly etag?: string;
    readonly [field: string]: unknown;
  };
}

/** The last catalog, kept in the app files, with the ETag Scenic sent for it. */
export interface CachedCatalog {
  readonly etag?: string;
  readonly catalog: RideCatalog;
}

/** Where the last catalog is kept, in the app files: `training/`, like the intervals.icu plan cache. */
export const CACHE_PATH = 'training/scenic-ride-catalog.json';

/** A catalog of this format and major version, or none. */
export function parseCatalog(value: unknown): RideCatalog | undefined {
  const catalog = value as Partial<RideCatalog> | null;
  if (catalog?.format !== 'ridrs-scenic-ride-catalog' || catalog.version !== 1) return undefined;
  if (!Array.isArray(catalog.routes) || typeof catalog.sources !== 'object' || catalog.sources === null) return undefined;
  return catalog as RideCatalog;
}

export async function readCache(files: AppFiles): Promise<CachedCatalog | undefined> {
  try {
    const cached = JSON.parse(new TextDecoder().decode(await files.read(CACHE_PATH))) as Partial<CachedCatalog>;
    const catalog = parseCatalog(cached.catalog);
    return catalog ? { etag: cached.etag, catalog } : undefined;
  } catch {
    return undefined;
  }
}

export async function writeCache(files: AppFiles, cached: CachedCatalog): Promise<void> {
  await files.replace(CACHE_PATH, new TextEncoder().encode(`${JSON.stringify(cached)}\n`));
}

/**
 * Asks Scenic for its ride catalog, with the ETag of the one kept: `unchanged` when Scenic says so
 * (304); a new catalog with its ETag; or why there is none (no network, an error status, another
 * format).
 */
export async function fetchCatalog(
  http: HttpClient,
  url: string,
  etag: string | undefined,
): Promise<
  | { readonly status: 'unchanged' }
  | { readonly status: 'fresh'; readonly catalog: RideCatalog; readonly etag?: string }
  | { readonly status: 'failed'; readonly reason: string }
> {
  let response: Awaited<ReturnType<HttpClient['request']>>;
  try {
    response = await http.request({ method: 'GET', url, headers: etag ? { 'If-None-Match': etag } : {} });
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
  if (response.status === 304) return { status: 'unchanged' };
  if (response.status !== 200) return { status: 'failed', reason: `${url}: HTTP ${response.status}` };
  let catalog: RideCatalog | undefined;
  try {
    catalog = parseCatalog(JSON.parse(response.body));
  } catch {
    catalog = undefined;
  }
  if (!catalog) return { status: 'failed', reason: `${url}: not a ride catalog of version 1` };
  const header = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'etag')?.[1];
  return { status: 'fresh', catalog, ...(header ? { etag: header } : {}) };
}

/**
 * The new catalog, and of the old one the routes that left it but are on the device (`onDevice`
 * by Scenic's id), with their sources: a downloaded route stays until the rider removes it.
 */
export function keepOnDevice(
  previous: RideCatalog | undefined,
  next: RideCatalog,
  onDevice: (id: string) => boolean,
): RideCatalog {
  const listed = new Set(next.routes.map((route) => route.id));
  const kept = (previous?.routes ?? []).filter((route) => !listed.has(route.id) && onDevice(route.id));
  if (kept.length === 0) return next;
  const sources = { ...next.sources };
  for (const route of kept) {
    const source = previous?.sources[route.source];
    if (source && !sources[route.source]) sources[route.source] = source;
  }
  return { ...next, sources, routes: [...next.routes, ...kept] };
}
