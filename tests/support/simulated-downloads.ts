// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { DataFetch, DataFetchJob } from '@ridrs/contracts';
import { configure, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { withStoredVideo } from './simulated-file.ts';
import { scenicFile } from './simulated-scenic.ts';

configure({ useWebWorkers: false });

const TEST_PATTERN = resolve(
  import.meta.dirname,
  '../../plugins/ui-world-video/client/fixtures/test-pattern.mp4',
);

/**
 * A GPX track of a minute: 5 m/s northwards, 0.2 m up every second; with `twoClimbs`, flat from
 * 20 s to 40 s between two such climbs.
 */
export function gpx(twoClimbs = false): string {
  const rise = (i: number) => (twoClimbs ? Math.min(i, 20) + Math.max(0, i - 40) : i) * 0.2;
  const points = Array.from({ length: 61 }, (_, i) => {
    const time = new Date(Date.UTC(2022, 11, 28, 9, 0, i)).toISOString();
    return `<trkpt lat="${(44.66 + (i * 5) / 111_195).toFixed(6)}" lon="5.42"><ele>${(433 + rise(i)).toFixed(1)}</ele><time>${time}</time></trkpt>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${points.join('')}</trkseg></trk></gpx>`;
}

/** The control file as UTF-16 big-endian with its byte order mark, like the Van Gestel routes of 2022. */
function utf16be(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes.set([0xfe, 0xff]);
  for (let i = 0; i < text.length; i += 1) {
    bytes[2 + i * 2] = text.charCodeAt(i) >> 8;
    bytes[3 + i * 2] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** The control file, titled `title`, or without a title when it is `null`, naming the video `video`. */
const control = (
  title: string | null,
  video = 'FR_Test.mp4',
) => `<?xml version="1.0" encoding="utf-16" standalone="yes"?>
<gpx-import>
  <name>FR_Col_de_Test</name>
${title === null ? '' : `  <title>${title}</title>\n`}  <video-file-path>${video}</video-file-path>
  <gpx-file-path>FR_Test.gpx</gpx-file-path>
  <framerate>25.0</framerate>
  <start-frame>1</start-frame>
  <informations>
    <information distance="20" de="Start" en="Start &amp; go" />
  </informations>
  <segments>
    <segment name="The whole test" start="0" end="300" />
  </segments>
</gpx-import>`;

/**
 * A small Incyclist package: video, GPX track and control file in one ZIP, as the sources ship
 * them. Its control file is titled `title`, or names no title when it is `null`.
 */
export async function incyclistPackage(
  title: string | null = 'Test route',
  { twoClimbs = false, video = 'FR_Test.mp4' }: { twoClimbs?: boolean; video?: string } = {},
): Promise<Uint8Array> {
  const zip = new ZipWriter(new Uint8ArrayWriter());
  await zip.add(video, new Uint8ArrayReader(new Uint8Array(await readFile(TEST_PATTERN))));
  await zip.add('FR_Test.gpx', new Uint8ArrayReader(new TextEncoder().encode(gpx(twoClimbs))));
  await zip.add('FR_Test.xml', new Uint8ArrayReader(utf16be(control(title, video))));
  return zip.close();
}

/**
 * `data.fetch` for the download scenarios: every URL answers with the small Incyclist package,
 * written to the media folder of the scenario. It can fail, or stop halfway until told to go on or
 * cancelled.
 */
export class SimulatedDownloads {
  failure: string | undefined;
  stopHalfway = false;
  /** Whether the packages hold their video stored, not compressed, as video2gpx writes them. */
  storedVideo = false;
  /** Whether the packages' track climbs twice, flat in between (two refined stretches, ADR 0110). */
  twoClimbs = false;
  /** The name of the packages' video, e.g. a WebM one. */
  video = 'FR_Test.mp4';
  readonly requested: string[] = [];
  private release: (() => void) | undefined;

  constructor(private readonly mediaRoot: string) {}

  readonly fetch: DataFetch = {
    fetch: async (job: DataFetchJob, onProgress, signal) => {
      // A file of ridrs Scenic, such as a route's overlay picture: served as Scenic serves it.
      const fromScenic = scenicFile(job.url);
      if (fromScenic) return this.write(job.target, fromScenic, onProgress);
      this.requested.push(job.url);
      if (this.failure) {
        throw new Error(this.failure);
      }
      const made = await incyclistPackage('Test route', {
        twoClimbs: this.twoClimbs,
        video: this.video,
      });
      const bytes = this.storedVideo ? await withStoredVideo(made) : made;
      if (this.stopHalfway) {
        onProgress?.({ received: Math.round(bytes.length / 2), size: bytes.length });
        await new Promise<void>((done, fail) => {
          this.release = done;
          // Cancelled: rejects like a provider does, keeping nothing of the download here.
          if (signal?.aborted) {
            fail(signal.reason);
          }
          signal?.addEventListener('abort', () => fail(signal.reason), { once: true });
        });
      }
      return this.write(job.target, bytes, onProgress);
    },
  };

  private async write(
    target: string,
    bytes: Uint8Array,
    onProgress: ((progress: { received: number; size?: number }) => void) | undefined,
  ): Promise<{ size: number }> {
    const file = join(this.mediaRoot, ...target.split('/'));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
    onProgress?.({ received: bytes.length, size: bytes.length });
    return { size: bytes.length };
  }

  goOn(): void {
    this.stopHalfway = false;
    this.release?.();
    this.release = undefined;
  }
}
