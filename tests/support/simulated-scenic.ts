// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HttpClient, HttpResponse } from '@ridrs/contracts';
import type { RidrsWorld } from './world.ts';

/** Where the app finds ridrs Scenic (plugins/video-source-scenic): the scenarios answer it here. */
export const SCENIC = 'https://ridrs.app/scenic/';
export const RIDE_CATALOG = `${SCENIC}api/ride/v1/catalog.json`;

/** The ride catalog the simulated Scenic serves: taken from ridrs.app/scenic (README beside it). */
const CATALOG_FILE = resolve(import.meta.dirname, '../fixtures/scenic/ride-catalog.json');
/** The files of the Van Gestel rides that Scenic serves under `vg/<slug>/`. */
const CONTENT = resolve(import.meta.dirname, '../../content/vangestel');

/**
 * The bytes ridrs Scenic serves at `url` for a file of a ride (`vg/<slug>/<path>`, any query), from
 * content/vangestel; none for any other URL.
 */
export function scenicFile(url: string): Uint8Array | undefined {
  if (!url.startsWith(`${SCENIC}vg/`)) return undefined;
  const path = decodeURIComponent(new URL(url).pathname.slice(new URL(SCENIC).pathname.length + 3));
  const file = join(CONTENT, ...path.split('/'));
  return existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined;
}

/**
 * ridrs Scenic for the scenarios, through `net.http`: its ride catalog with an ETag, `304` when asked
 * with the current one. It can be out of reach, and routes can leave its catalog.
 */
export class SimulatedScenic {
  offline = false;
  readonly withdrawn = new Set<string>();
  readonly requests: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  }[] = [];
  /** The ETag of each catalog served, in order. */
  readonly served: string[] = [];

  readonly http: HttpClient = {
    request: async (request): Promise<HttpResponse> => {
      this.requests.push({ url: request.url, headers: { ...(request.headers ?? {}) } });
      if (this.offline) throw new Error('ridrs.app: the network is not reachable');
      if (request.method !== 'GET' || request.url !== RIDE_CATALOG) {
        return { status: 404, headers: {}, body: '{"error":"not found"}' };
      }
      const catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8')) as {
        routes: { id: string }[];
      };
      catalog.routes = catalog.routes.filter((route) => !this.withdrawn.has(route.id));
      const body = JSON.stringify(catalog);
      const etag = `"${createHash('sha1').update(body).digest('hex')}"`;
      const asked = Object.entries(request.headers ?? {}).find(
        ([name]) => name.toLowerCase() === 'if-none-match',
      )?.[1];
      if (asked === etag) return { status: 304, headers: { etag }, body: '' };
      this.served.push(etag);
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', etag },
        body,
      };
    },
  };
}

const simulations = new WeakMap<RidrsWorld, SimulatedScenic>();

/** The simulated ridrs Scenic of a scenario that runs `video-source-scenic`. */
export function scenic(world: RidrsWorld): SimulatedScenic {
  const simulation = simulations.get(world);
  if (!simulation)
    throw new Error(
      'Expected the simulated ridrs Scenic: the scenario runs no video-source-scenic',
    );
  return simulation;
}

/**
 * Gives `video-source-scenic` the simulated ridrs Scenic as its `net.http`, so that no scenario
 * reaches the network: every scenario that runs the plugin gets it.
 */
export async function simulateScenic(world: RidrsWorld): Promise<void> {
  const simulation = new SimulatedScenic();
  simulations.set(world, simulation);
  world.getBehavior('simulated-scenic').providedImplementations.set('net.http', simulation.http);
  await world.writeProbePluginFolder({
    folder: 'simulated-scenic',
    id: 'simulated-scenic',
    types: ['transport'],
    provides: ['net.http'],
  });
}
