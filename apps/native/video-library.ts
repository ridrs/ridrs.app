// SPDX-License-Identifier: AGPL-3.0-or-later

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

const TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.gpx': 'application/gpx+xml',
  '.xml': 'application/xml',
};

/** Every folder of the library with an Incyclist control file (`<gpx-import>`), by name. */
function indexOf(root: string): { routes: { folder: string; control: string }[] } {
  const routes = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const control = readdirSync(join(root, entry.name)).find((file) => extname(file) === '.xml');
      return control ? [{ folder: entry.name, control }] : [];
    })
    .sort((a, b) => a.folder.localeCompare(b.folder));
  return { routes };
}

/** A file of the library, whole or the one byte range asked for: videos seek by range. */
function send(response: ServerResponse, file: string, range: string | undefined): void {
  const size = statSync(file).size;
  response.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
  response.setHeader('Accept-Ranges', 'bytes');
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (!match) {
    response.setHeader('Content-Length', size);
    createReadStream(file).pipe(response);
    return;
  }
  const [, first, last] = match;
  const start = first ? Number(first) : Math.max(0, size - Number(last));
  const end = first && last ? Math.min(Number(last), size - 1) : size - 1;
  if (start > end || start >= size) {
    response.statusCode = 416;
    response.setHeader('Content-Range', `bytes */${size}`);
    response.end();
    return;
  }
  response.statusCode = 206;
  response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  response.setHeader('Content-Length', end - start + 1);
  createReadStream(file, { start, end }).pipe(response);
}

/**
 * Serves the video library (plugins/ui-world-video) from `root` under `/videos/` while the app
 * runs from the dev server: `index.json` lists the routes, everything else is a file of a route's
 * folder. Nothing outside `root` is reachable. Without the folder the library is empty.
 */
export function videoLibrary(root: string): Plugin {
  const base = resolve(root);
  return {
    name: 'ridrs-video-library',
    configureServer(server) {
      server.middlewares.use('/videos/', (request, response, next) => {
        const path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
        if (path === '/index.json') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(existsSync(base) ? indexOf(base) : { routes: [] }));
          return;
        }
        const file = resolve(base, `.${path}`);
        const inside = relative(base, file);
        if (
          inside.startsWith('..') ||
          inside.startsWith(sep) ||
          !existsSync(file) ||
          !statSync(file).isFile()
        ) {
          next();
          return;
        }
        send(response, file, request.headers.range);
      });
    },
  };
}
