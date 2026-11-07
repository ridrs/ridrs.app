// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { DataFetch, DataFetchJob } from '@ridrs/contracts';
import { configure, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

configure({ useWebWorkers: false });

const TEST_PATTERN = resolve(
  import.meta.dirname,
  '../../plugins/ui-world-video/client/fixtures/test-pattern.mp4',
);

/** A GPX track of a minute: 5 m/s northwards, 0.2 m up every second. */
function gpx(): string {
  const points = Array.from({ length: 61 }, (_, i) => {
    const time = new Date(Date.UTC(2022, 11, 28, 9, 0, i)).toISOString();
    return `<trkpt lat="${(44.66 + (i * 5) / 111_195).toFixed(6)}" lon="5.42"><ele>${(433 + i * 0.2).toFixed(1)}</ele><time>${time}</time></trkpt>`;
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

const CONTROL = `<?xml version="1.0" encoding="utf-16" standalone="yes"?>
<gpx-import>
  <name>FR_Test</name>
  <title>Test route</title>
  <video-file-path>FR_Test.mp4</video-file-path>
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

/** A small Incyclist package: video, GPX track and control file in one ZIP, as the sources ship them. */
export async function incyclistPackage(): Promise<Uint8Array> {
  const zip = new ZipWriter(new Uint8ArrayWriter());
  await zip.add('FR_Test.mp4', new Uint8ArrayReader(new Uint8Array(await readFile(TEST_PATTERN))));
  await zip.add('FR_Test.gpx', new Uint8ArrayReader(new TextEncoder().encode(gpx())));
  await zip.add('FR_Test.xml', new Uint8ArrayReader(utf16be(CONTROL)));
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
  readonly requested: string[] = [];
  private release: (() => void) | undefined;

  constructor(private readonly mediaRoot: string) {}

  readonly fetch: DataFetch = {
    fetch: async (job: DataFetchJob, onProgress, signal) => {
      this.requested.push(job.url);
      if (this.failure) {
        throw new Error(this.failure);
      }
      const bytes = await incyclistPackage();
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
      const file = join(this.mediaRoot, ...job.target.split('/'));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
      onProgress?.({ received: bytes.length, size: bytes.length });
      return { size: bytes.length };
    },
  };

  goOn(): void {
    this.stopHalfway = false;
    this.release?.();
    this.release = undefined;
  }
}
