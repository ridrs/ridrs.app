// SPDX-License-Identifier: AGPL-3.0-or-later

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Correction, CorrectionSchema, type WorkoutStructure } from '@tabata-sync/contracts';
import {
  AnalysisPipeline,
  AnalysisStore,
  applyCorrections,
  compareWithCorrected,
  type CorrectionComparison,
  DEFAULT_INTERVAL_PARAMS,
  FfmpegDecoder,
  FfprobeMetadataReader,
  openDatabase,
  resolveParams,
} from '@tabata-sync/engine';
import { build } from 'esbuild';

const WEB_DIR = resolve(import.meta.dirname, '../web');

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
};

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    port: { type: 'string', default: '8787' },
  },
});
const dbPath = resolve(values.db ?? process.env.TABATA_DB ?? 'data/tabata.db');
const store = new AnalysisStore(openDatabase(dbPath));
// Only used to detect intervals for tracks analyzed before interval detection existed.
const pipeline = new AnalysisPipeline({
  store,
  decoder: new FfmpegDecoder(),
  metadataReader: new FfprobeMetadataReader(),
  params: resolveParams(),
  intervalParams: DEFAULT_INTERVAL_PARAMS,
});

interface EffectiveWorkout {
  readonly structure: WorkoutStructure;
  readonly durationSec: number;
  /** Present when the track has corrections: how far the automatic result was from them. */
  readonly comparison?: CorrectionComparison;
}

/** The workout the player shows: latest automatic detection with the track's corrections applied. */
async function effectiveWorkout(variantId: string): Promise<EffectiveWorkout | undefined> {
  const variant = store.variant(variantId);
  if (!variant || !store.latestSucceededRun(variantId)) return undefined;
  let run = store.latestSucceededRun(variantId, 'intervals');
  if (!run) {
    await pipeline.detectIntervals(variantId);
    run = store.latestSucceededRun(variantId, 'intervals');
  }
  const automatic = run && store.loadWorkout(run.id);
  if (!automatic) return undefined;
  const corrections = store.corrections(variant.trackId).map((c) => c.correction);
  const structure = applyCorrections(automatic, corrections, variant.durationSec).structure;
  return {
    structure,
    durationSec: variant.durationSec,
    ...(corrections.length > 0 ? { comparison: compareWithCorrected(automatic, structure) } : {}),
  };
}

/** A complete labeling replaces the track's earlier corrections, which stay in the history. */
function saveCorrection(trackId: string, correction: Correction): void {
  const previous = store.corrections(trackId);
  const id = store.addCorrection(trackId, correction, 'player');
  if (correction.action === 'set_boundaries') for (const c of previous) store.supersedeCorrection(c.id, id);
}

/**
 * Writes must come from the player page itself. JSON bodies and a missing or local Origin keep
 * other web pages in the browser from changing the database through this local server.
 */
function isLocalWrite(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const localOrigin = !origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return localOrigin && (request.headers['content-type'] ?? '').startsWith('application/json');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

/** Streams the original file, honoring HTTP range requests so the browser can seek. */
async function sendMedia(request: IncomingMessage, response: ServerResponse, variantId: string): Promise<void> {
  const variant = store.variant(variantId);
  if (!variant) return sendJson(response, 404, { error: 'Unknown track' });
  const format = (store.db.prepare('SELECT format FROM audio_file WHERE id = ?').get(variant.audioFileId) as { format: string }).format;
  const { size } = await stat(variant.path);
  const type = CONTENT_TYPES[format] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
  if (!range) {
    response.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    createReadStream(variant.path).pipe(response);
    return;
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
  if (start >= size || start > end) {
    response.writeHead(416, { 'content-range': `bytes */${size}` });
    response.end();
    return;
  }
  response.writeHead(206, {
    'content-type': type,
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${size}`,
    'accept-ranges': 'bytes',
  });
  createReadStream(variant.path, { start, end }).pipe(response);
}

async function bundle(): Promise<string> {
  const result = await build({
    entryPoints: [join(WEB_DIR, 'main.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    sourcemap: 'inline',
  });
  return result.outputFiles[0]?.text ?? '';
}

const [appJs, indexHtml, stylesCss] = await Promise.all([
  bundle(),
  readFile(join(WEB_DIR, 'index.html'), 'utf8'),
  readFile(join(WEB_DIR, 'styles.css'), 'utf8'),
]);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  void (async () => {
    try {
      if (path === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(indexHtml);
      } else if (path === '/app.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        response.end(appJs);
      } else if (path === '/styles.css') {
        response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
        response.end(stylesCss);
      } else if (path === '/api/tracks') {
        const tracks = store.listTracks().map((track) => {
          const run = store.latestSucceededRun(track.variantId, 'intervals');
          const automatic = run ? store.loadWorkout(run.id) : undefined;
          const corrections = store.corrections(track.trackId).map((c) => c.correction);
          if (!automatic) return track;
          const pattern = corrections.length > 0 ? applyCorrections(automatic, corrections, track.durationSec).structure.pattern : automatic.pattern;
          return { ...track, pattern, corrected: corrections.length > 0 };
        });
        sendJson(response, 200, tracks);
      } else if (path.startsWith('/api/tracks/') && path.endsWith('/workout')) {
        const variantId = decodeURIComponent(path.slice('/api/tracks/'.length, -'/workout'.length));
        const workout = await effectiveWorkout(variantId);
        if (!workout) sendJson(response, 404, { error: 'No analysis for this track' });
        else sendJson(response, 200, workout);
      } else if (path.startsWith('/api/tracks/') && path.endsWith('/corrections')) {
        const variantId = decodeURIComponent(path.slice('/api/tracks/'.length, -'/corrections'.length));
        const variant = store.variant(variantId);
        if (!variant) return sendJson(response, 404, { error: 'Unknown track' });
        if (request.method !== 'POST' && request.method !== 'DELETE') return sendJson(response, 405, { error: 'Use POST or DELETE' });
        if (!isLocalWrite(request)) return sendJson(response, 403, { error: 'Only the player page may change corrections' });
        if (request.method === 'POST') {
          const parsed = CorrectionSchema.safeParse(await readJson(request));
          if (!parsed.success) return sendJson(response, 400, { error: parsed.error.message });
          saveCorrection(variant.trackId, parsed.data);
        } else {
          store.withdrawCorrections(variant.trackId);
        }
        sendJson(response, 200, await effectiveWorkout(variantId));
      } else if (path.startsWith('/media/')) {
        await sendMedia(request, response, decodeURIComponent(path.slice('/media/'.length)));
      } else {
        sendJson(response, 404, { error: 'Not found' });
      }
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { error: (error as Error).message });
      else response.destroy();
    }
  })();
});

const port = Number(values.port);
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EADDRINUSE') throw error;
  process.stderr.write(`Port ${port} is already in use, probably by another player. Stop it, or pass --port <number>.\n`);
  process.exit(1);
});
// Local only: the player serves files from this machine and must not be reachable from the network.
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Tabata player on http://localhost:${port} (database ${dbPath})\n`);
});
