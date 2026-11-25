// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { VideoInterpolation, VideoInterpolator } from '@ridrs/contracts';

/** A refined stretch's video (ADR 0109): what the test interpolator writes for every stretch. */
const SEGMENT = resolve(
  import.meta.dirname,
  '../../plugins/ui-world-video/client/fixtures/refined-segment.mp4',
);

/**
 * `video.interpolate` for the refinement scenarios (ADR 0110): writes the fixture stretch to the
 * target in the scenario's media folder and answers the times asked for. It can fail, or stop
 * halfway until told to go on or cancelled.
 */
export class TestInterpolator {
  failure: string | undefined;
  /** Fails only the stretches that begin after this many s, with `failure`. */
  failingFrom: number | undefined;
  stopHalfway = false;
  readonly requested: VideoInterpolation[] = [];
  private release: (() => void) | undefined;

  constructor(private readonly mediaRoot: string) {}

  readonly interpolator: VideoInterpolator = {
    interpolate: async (request, progress, signal) => {
      this.requested.push(request);
      if (this.failure && (this.failingFrom === undefined || request.from > this.failingFrom)) {
        throw new Error(this.failure);
      }
      if (this.stopHalfway) {
        progress(0.5);
        await new Promise<void>((done, fail) => {
          this.release = done;
          if (signal.aborted) fail(signal.reason);
          signal.addEventListener('abort', () => fail(signal.reason), { once: true });
        });
      }
      const file = join(this.mediaRoot, ...request.target.split('/'));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, await readFile(SEGMENT));
      progress(1);
      return { from: request.from, to: request.to };
    },
  };

  /** Goes on with a stretch it stopped, and with every later one at once. */
  goOn(): void {
    this.stopHalfway = false;
    this.release?.();
    this.release = undefined;
  }
}
