// SPDX-License-Identifier: AGPL-3.0-or-later

import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTauriFetch } from './fetch.ts';

type Args = Record<string, unknown>;

beforeAll(() => {
  // Tauri's mocks expect a browser-like `window`; in Node the global object serves as one.
  (globalThis as { window?: unknown }).window ??= globalThis;
});
afterEach(() => clearMocks());

describe('createTauriFetch', () => {
  it('downloads through media_fetch and reports its progress', async () => {
    const calls: [string, Args][] = [];
    mockIPC((command, args) => {
      calls.push([command, args as Args]);
      const channel = (args as Args).onProgress as { onmessage: (m: unknown) => void };
      channel.onmessage({ received: 5, size: 10 });
      channel.onmessage({ received: 10, size: null });
      return { size: 10, etag: null };
    });
    const progress: unknown[] = [];
    const result = await createTauriFetch().fetch(
      { url: 'https://example.org/a.zip', target: 'videos/s/a.zip', expected: { etag: '"v1"' } },
      (p) => progress.push(p),
    );
    expect(result).toEqual({ size: 10, etag: undefined });
    expect(progress).toEqual([{ received: 5, size: 10 }, { received: 10, size: undefined }]);
    expect(calls[0]?.[0]).toBe('media_fetch');
    expect(calls[0]?.[1]).toMatchObject({
      job: 'fetch-1',
      url: 'https://example.org/a.zip',
      target: 'videos/s/a.zip',
      expectedEtag: '"v1"',
    });
  });

  it('cancels the running download when the signal aborts', async () => {
    const commands: string[] = [];
    let finish: (value: unknown) => void = () => {};
    mockIPC((command) => {
      commands.push(command);
      return command === 'media_fetch' ? new Promise((done) => (finish = done)) : null;
    });
    const abort = new AbortController();
    const running = createTauriFetch().fetch({ url: 'https://example.org/a.zip', target: 'a.zip' }, undefined, abort.signal);
    abort.abort();
    finish({ size: 0, etag: null });
    await running;
    expect(commands).toEqual(['media_fetch', 'media_fetch_cancel']);
  });

  it('refuses a target outside the media storage before asking Rust', async () => {
    mockIPC(() => null);
    await expect(createTauriFetch().fetch({ url: 'https://example.org/a.zip', target: '../a.zip' })).rejects.toThrow(
      'Invalid app file path',
    );
  });
});
