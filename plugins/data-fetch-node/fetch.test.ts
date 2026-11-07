// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaFiles } from '@ridrs/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNodeFetch } from './fetch.ts';

/** A source like nginx: ranges, an ETag, `If-Range`; it can break the connection after `cutAfter` bytes. */
const source = {
  bytes: new Uint8Array(100_000).map((_, i) => i % 251),
  etag: '"v1"',
  cutAfter: Number.POSITIVE_INFINITY,
  requests: [] as { range?: string; ifRange?: string }[],
};

function serve(request: IncomingMessage, response: import('node:http').ServerResponse) {
  const range = request.headers.range;
  const ifRange = request.headers['if-range'] as string | undefined;
  source.requests.push({ range, ifRange });
  const from = range && (ifRange === undefined || ifRange === source.etag) ? Number(range.slice(6, -1)) : 0;
  const body = source.bytes.subarray(from);
  response.writeHead(from > 0 ? 206 : 200, {
    ETag: source.etag,
    'Content-Length': body.length,
    ...(from > 0 ? { 'Content-Range': `bytes ${from}-${source.bytes.length - 1}/${source.bytes.length}` } : {}),
  });
  if (body.length > source.cutAfter) {
    // Closed, not reset: a reset would discard what the client has not read yet.
    response.write(body.subarray(0, source.cutAfter), () => response.socket?.end());
  } else {
    response.end(body);
  }
}

let server: Server;
let url: string;
const root = mkdtempSync(join(tmpdir(), 'ridrs-fetch-test-'));
const media = { location: (path: string) => join(root, ...path.split('/')) } as MediaFiles;
const fetcher = createNodeFetch(media);

beforeAll(async () => {
  server = createServer(serve);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/route.zip`;
});
afterAll(() => server.close());
beforeEach(() => {
  source.etag = '"v1"';
  source.cutAfter = Number.POSITIVE_INFINITY;
  source.requests = [];
});

describe('createNodeFetch', () => {
  it('fetches a file and reports its progress', async () => {
    const progress: number[] = [];
    const result = await fetcher.fetch({ url, target: 'a/whole.zip' }, (p) => progress.push(p.received));
    expect(result).toEqual({ size: 100_000, etag: '"v1"' });
    expect(readFileSync(media.location('a/whole.zip'))).toEqual(Buffer.from(source.bytes));
    expect(progress.at(-1)).toBe(100_000);
    expect(existsSync(media.location('a/whole.zip.part'))).toBe(false);
  });

  it('goes on where an interrupted download stopped', async () => {
    source.cutAfter = 30_000;
    await expect(fetcher.fetch({ url, target: 'a/resumed.zip' })).rejects.toThrow();
    source.cutAfter = Number.POSITIVE_INFINITY;
    await fetcher.fetch({ url, target: 'a/resumed.zip' });
    expect(source.requests.at(-1)?.range).toMatch(/^bytes=\d+-$/);
    expect(source.requests.at(-1)?.ifRange).toBe('"v1"');
    expect(readFileSync(media.location('a/resumed.zip'))).toEqual(Buffer.from(source.bytes));
  });

  it('starts over when the source changed meanwhile', async () => {
    source.cutAfter = 30_000;
    await expect(fetcher.fetch({ url, target: 'a/changed.zip' })).rejects.toThrow();
    source.cutAfter = Number.POSITIVE_INFINITY;
    source.etag = '"v2"';
    source.bytes = source.bytes.map((b) => 250 - b);
    await fetcher.fetch({ url, target: 'a/changed.zip' });
    expect(readFileSync(media.location('a/changed.zip'))).toEqual(Buffer.from(source.bytes));
  });
});
