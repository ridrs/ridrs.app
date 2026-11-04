// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CandidateEvent, SpeechSegment, WorkoutStructure } from '@tabata-sync/contracts';
import { ENGLISH_PHRASES, type PhraseTable, spokenCountdowns } from './countdowns.ts';
import type { EvidenceCurves } from './evidence.ts';
import { DEFAULT_GRID_OPTIONS, fitRegularWorkout, type GridFit, type GridOptions } from './grid.ts';

/** Everything interval detection looks at. All times are seconds on the analyzed timeline. */
export interface DetectionContext {
  readonly durationSec: number;
  readonly curves: EvidenceCurves;
  readonly speech: readonly SpeechSegment[];
}

export interface IntervalDetection {
  readonly candidates: CandidateEvent[];
  readonly structure: WorkoutStructure;
  /** The regular grid, or null when no regular workout stands out. */
  readonly fit: GridFit | null;
}

/** Spoken countdowns and audio evidence, decided by one regular grid for the whole track. */
export class IntervalDetector {
  constructor(
    private readonly options: GridOptions = DEFAULT_GRID_OPTIONS,
    private readonly phrases: PhraseTable = ENGLISH_PHRASES,
  ) {}

  detect(context: DetectionContext): IntervalDetection {
    const countdowns = spokenCountdowns(context.speech, this.phrases);
    return fitRegularWorkout({ durationSec: context.durationSec, curves: context.curves, countdowns }, this.options);
  }
}
