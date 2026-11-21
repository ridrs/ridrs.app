// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppFiles, HttpClient, HttpRequest } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import vector from '../../web/scenic/test/fixtures/ride-catalog/catalog.example.json' with { type: 'json' };
import {
  CACHE_PATH,
  fetchCatalog,
  keepOnDevice,
  parseCatalog,
  type RideCatalog,
  readCache,
  writeCache,
} from './catalog.ts';

const URL = 'https://ridrs.example.org/scenic/api/ride/v1/catalog.json';
const catalog = parseCatalog(vector) as RideCatalog;

function http(answer: (request: HttpRequest) => { status: number; headers?: Record<string, string>; body?: string }) {
  const requests: HttpRequest[] = [];
  const client: HttpClient = {
    request: async (request) => {
      requests.push(request);
      const { status, headers = {}, body = '' } = answer(request);
      return { status, headers, body };
    },
  };
  return { client, requests };
}

describe('fetchCatalog', () => {
  it('reads a new catalog with its ETag', async () => {
    const { client, requests } = http(() => ({ status: 200, headers: { ETag: '"v1"' }, body: JSON.stringify(vector) }));
    expect(await fetchCatalog(client, URL, undefined)).toEqual({ status: 'fresh', catalog, etag: '"v1"' });
    expect(requests).toEqual([{ method: 'GET', url: URL, headers: {} }]);
  });

  it('asks with the ETag of the catalog kept and hears that it is unchanged', async () => {
    const { client, requests } = http(() => ({ status: 304 }));
    expect(await fetchCatalog(client, URL, '"v1"')).toEqual({ status: 'unchanged' });
    expect(requests[0]?.headers).toEqual({ 'If-None-Match': '"v1"' });
  });

  it('says why there is no catalog: no network, an error status, another format', async () => {
    const offline: HttpClient = { request: async () => Promise.reject(new Error('offline')) };
    expect(await fetchCatalog(offline, URL, undefined)).toEqual({ status: 'failed', reason: 'offline' });
    expect(await fetchCatalog(http(() => ({ status: 500 })).client, URL, undefined)).toMatchObject({ status: 'failed' });
    const other = http(() => ({ status: 200, body: JSON.stringify({ ...vector, version: 2 }) })).client;
    expect(await fetchCatalog(other, URL, undefined)).toMatchObject({ status: 'failed' });
    expect(await fetchCatalog(http(() => ({ status: 200, body: 'no json' })).client, URL, undefined)).toMatchObject({
      status: 'failed',
    });
  });
});

describe('keepOnDevice', () => {
  const gone = { ...catalog, routes: [] };

  it('keeps a route that left the catalog while it is on the device, with its source', () => {
    expect(keepOnDevice(catalog, { ...gone, sources: {} }, () => true)).toEqual(catalog);
  });

  it('drops a route that left the catalog and is not on the device', () => {
    expect(keepOnDevice(catalog, gone, () => false)).toEqual(gone);
    expect(keepOnDevice(undefined, gone, () => true)).toEqual(gone);
  });
});

describe('the catalog kept in the app files', () => {
  it('reads what it wrote, and nothing from a missing or broken file', async () => {
    const stored = new Map<string, Uint8Array>();
    const files = {
      replace: async (path: string, bytes: Uint8Array) => void stored.set(path, bytes),
      read: async (path: string) => {
        const bytes = stored.get(path);
        if (!bytes) throw new Error(`${path}: missing`);
        return bytes;
      },
    } as unknown as AppFiles;
    expect(await readCache(files)).toBeUndefined();
    await writeCache(files, { etag: '"v1"', catalog });
    expect(stored.has(CACHE_PATH)).toBe(true);
    expect(await readCache(files)).toEqual({ etag: '"v1"', catalog });
    stored.set(CACHE_PATH, new TextEncoder().encode('{"catalog":{"format":"other"}}'));
    expect(await readCache(files)).toBeUndefined();
  });
});
