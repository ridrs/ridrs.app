// SPDX-License-Identifier: AGPL-3.0-or-later

import { median } from 'simple-statistics';
import { TEMPORAL_DEFAULTS } from './defaults.ts';

/**
 * Learns the sampling interval T of a source from the receive-time differences of its accepted
 * measurements: robust against jitter (median) and single gaps (outliers), following a sustained
 * change after three consistent outliers.
 */
export class IntervalEstimator {
  private window: number[] = [];
  private outliers: number[] = [];
  private estimate?: number;

  get interval(): number | undefined {
    return this.estimate;
  }

  add(interval: number): void {
    if (interval <= 0) {
      return;
    }
    const learned = this.estimate;
    if (learned !== undefined && interval > TEMPORAL_DEFAULTS.outlierFactor * learned) {
      this.addOutlier(interval);
      return;
    }
    this.outliers = [];
    this.window = [...this.window, interval].slice(-TEMPORAL_DEFAULTS.intervalWindow);
    if (this.window.length >= TEMPORAL_DEFAULTS.learnedAfterIntervals) {
      this.estimate = median(this.window);
    }
  }

  private addOutlier(interval: number): void {
    this.outliers = [...this.outliers, interval].slice(-TEMPORAL_DEFAULTS.sustainedChangeCount);
    if (this.outliers.length < TEMPORAL_DEFAULTS.sustainedChangeCount) {
      return;
    }
    const center = median(this.outliers);
    const tolerance = TEMPORAL_DEFAULTS.sustainedChangeTolerance * center;
    if (this.outliers.every((value) => Math.abs(value - center) <= tolerance)) {
      this.window = this.outliers;
      this.outliers = [];
      this.estimate = center;
    }
  }
}
