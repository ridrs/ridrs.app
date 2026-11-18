// SPDX-License-Identifier: AGPL-3.0-or-later

import { screenshotPath } from '@ridrs/recording';

/** What taking a screenshot needs from the app, without Tauri: tested headless. */
export interface RideScreenshotPorts {
  /** The app files in the recordings. */
  list(): Promise<readonly string[]>;
  /** Tells the UI that a screenshot is taken (`true`) and that it is over (`false`). */
  capture(on: boolean): void;
  /** Resolves once the UI has drawn itself for the screenshot. */
  settle(): Promise<void>;
  /** Takes the snapshot and writes it to the app file `path`. */
  snapshot(path: string): Promise<void>;
}

/**
 * Takes a ride's screenshots (ADR 0102), one at a time, so two never pick the same name: the next
 * free name of the ride, then the UI is told and given time to draw itself for the snapshot (the
 * gauges leave their see-through WebGPU canvas for their SVG), then the snapshot, then the UI goes
 * back, also when the snapshot failed.
 */
export function createRideScreenshot(
  ports: RideScreenshotPorts,
): (startedAt: number) => Promise<{ file: string }> {
  let previous: Promise<unknown> = Promise.resolve();
  return (startedAt) => {
    const next = previous.then(async () => {
      const file = screenshotPath(startedAt, await ports.list());
      ports.capture(true);
      try {
        await ports.settle();
        await ports.snapshot(file);
      } finally {
        ports.capture(false);
      }
      return { file };
    });
    previous = next.catch(() => undefined);
    return next;
  };
}
