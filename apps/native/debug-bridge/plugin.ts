// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';
import { report } from './audit.ts';
import { allowed, DebugRelay } from './relay.ts';

/** The collector the page loads on request, by the dev server's file URL. */
const COLLECT_URL = `/@fs${fileURLToPath(new URL('./collect.js', import.meta.url))}`;
const CLIENT_ID = 'virtual:ridrs-debug';
const RESOLVED = `\0${CLIENT_ID}`;

/** Where the CLI finds the port and the token of the running dev server. */
export function bridgeFile(repoRoot: string): string {
  return `${repoRoot}node_modules/.cache/ridrs-debug.json`;
}

const body = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    request.on('end', () => resolve(text));
  });

const reply = (response: ServerResponse, status: number, value: unknown) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
};

/**
 * The debug bridge of the dev app: a way for a tool (a coding agent, a script) to run JavaScript
 * in the page of the running `tauri dev` window, the real WebKit web view, and to read what the
 * page logged, as the browser pane's tools do in a browser. Only in the dev server (`apply:
 * 'serve'`), so no build contains it; the page reports to the dev server over its own socket.
 *
 * - `POST /__debug/eval` runs the body as an async function body in the page and answers
 *   `{ ok, value | error }`; `GET /__debug/logs?since=n` answers the page's console lines and
 *   uncaught errors; `GET /__debug/status` says which page reported last.
 * - Every request carries the token of this dev server run (`x-ridrs-debug-token`, kept in
 *   `bridgeFile`, never sent to a page) and no `Origin`, so no web page can use it.
 * - Off when the dev server is open to the network (`TAURI_DEV_HOST`, a phone): the module the
 *   page loads would hand the bridge to the network.
 */
export function debugBridge(options: {
  readonly repoRoot: string;
  readonly enabled: boolean;
}): Plugin {
  const relay = new DebugRelay();
  const token = randomBytes(24).toString('hex');
  /** The page that said hello last: after a reload, the one that is there. */
  let page: { userAgent: string; href: string } | undefined;
  let server: ViteDevServer;

  return {
    name: 'ridrs-debug-bridge',
    apply: 'serve',
    resolveId: (id) => (options.enabled && id === CLIENT_ID ? RESOLVED : undefined),
    load: (id) =>
      id === RESOLVED ? readFileSync(new URL('./client.js', import.meta.url), 'utf8') : undefined,
    transformIndexHtml: () =>
      options.enabled
        ? [
            {
              tag: 'script',
              attrs: { type: 'module', src: `/@id/__x00__${CLIENT_ID}` },
              injectTo: 'head',
            },
          ]
        : [],
    configureServer(viteServer) {
      if (!options.enabled) return;
      server = viteServer;
      server.ws.on('ridrs-debug:hello', (data: { userAgent: string; href: string }, client) => {
        page = data;
        client.send('ridrs-debug:ready', {});
      });
      server.ws.on('ridrs-debug:log', (data: { level: string; text: string }) =>
        relay.log(data.level, data.text),
      );
      server.ws.on(
        'ridrs-debug:result',
        (data: { id: number; ok: boolean; value?: unknown; error?: string }) =>
          relay.answer(data.id, data),
      );
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address();
        const file = bridgeFile(options.repoRoot);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(
          file,
          JSON.stringify({
            port: typeof address === 'object' && address ? address.port : 1420,
            token,
          }),
          { mode: 0o600 },
        );
      });
      const ask = (code: string) =>
        relay.evaluate(code, (id, text) => server.ws.send('ridrs-debug:eval', { id, code: text }));
      /** The `selector` of a request as the root argument: that element, else the whole body. */
      const scope = (url: URL) => {
        const selector = url.searchParams.get('selector');
        return selector
          ? `document.querySelector(${JSON.stringify(selector)}) ?? document.body`
          : 'document.body';
      };
      server.middlewares.use('/__debug', async (request, response) => {
        if (!allowed(request.headers, token)) {
          reply(response, 403, { ok: false, error: 'Forbidden' });
          return;
        }
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (request.method === 'POST' && url.pathname === '/eval') {
          const code = await body(request);
          reply(
            response,
            200,
            await relay.evaluate(code, (id, text) =>
              server.ws.send('ridrs-debug:eval', { id, code: text }),
            ),
          );
        } else if (request.method === 'GET' && url.pathname === '/layout') {
          // The page reads the facts, the audit judges them here.
          const facts = await ask(
            `return (await import(${JSON.stringify(COLLECT_URL)})).collectLayout(${scope(url)})`,
          );
          reply(
            response,
            200,
            facts.ok ? report(facts.value as Parameters<typeof report>[0]) : facts,
          );
        } else if (request.method === 'GET' && url.pathname === '/a11y') {
          reply(
            response,
            200,
            await ask(
              `return (await import(${JSON.stringify(COLLECT_URL)})).accessibilityTree(${scope(url)})`,
            ),
          );
        } else if (request.method === 'GET' && url.pathname === '/screenshot') {
          // The native snapshot of the web view, written by the app itself (src-tauri/src/debug_snapshot.rs).
          const path = url.searchParams.get('path') ?? '';
          const width = Number(url.searchParams.get('width') ?? 800);
          if (!path.startsWith('/') || !path.endsWith('.png') || !(width > 0)) {
            reply(response, 400, {
              ok: false,
              error: 'Needs an absolute path ending in .png, and a width',
            });
          } else {
            reply(
              response,
              200,
              await ask(
                `return await window.__TAURI_INTERNALS__.invoke('debug_snapshot', { width: ${width}, path: ${JSON.stringify(path)} })`,
              ),
            );
          }
        } else if (request.method === 'GET' && url.pathname === '/logs') {
          reply(response, 200, relay.logs(Number(url.searchParams.get('since') ?? 0)));
        } else if (request.method === 'GET' && url.pathname === '/status') {
          reply(response, 200, { page: page ?? null });
        } else {
          reply(response, 404, { ok: false, error: 'Not found' });
        }
      });
    },
  };
}
