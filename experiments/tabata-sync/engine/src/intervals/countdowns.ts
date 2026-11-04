// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SpeechSegment } from '@tabata-sync/contracts';
import { median } from '../dsp/signal.ts';

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
};

/** Spoken commands and what they announce. Replaceable for other languages or coaches. */
export interface PhraseTable {
  readonly work: readonly string[];
  readonly recovery: readonly string[];
}

export const ENGLISH_PHRASES: PhraseTable = {
  work: ['go', 'start', 'work', 'begin'],
  recovery: ['stop', 'rest', 'recover', 'relax', 'break', 'pause'],
};

/** Numbers of a countdown follow each other at least this fast and at most this slowly. */
const MIN_CADENCE_SEC = 0.2;
const MAX_CADENCE_SEC = 1.5;
/** A command belongs to the countdown when it follows the last number within this time. */
const COMMAND_GAP_SEC = 1.5;

/** A spoken countdown ("three, two, one, go") and when it reaches zero. */
export interface SpokenCountdown {
  /** Where the first number starts. */
  readonly startSec: number;
  /** Where the next number would have started: the boundary the countdown announces. */
  readonly zeroSec: number;
  /** What starts at zero, if a command word says so. */
  readonly into?: 'work' | 'recovery';
  readonly text: string;
}

interface Token {
  readonly word: string;
  readonly startSec: number;
  readonly endSec: number;
}

function tokens(speech: readonly SpeechSegment[]): Token[] {
  const out: Token[] = [];
  for (const segment of speech) {
    const words = segment.words ?? [{ text: segment.text, startSec: segment.startSec, endSec: segment.endSec, confidence: segment.confidence }];
    for (const word of words) {
      for (const part of word.text.toLowerCase().replace(/[♪"“”()]/g, ' ').split(/\s+/)) {
        const clean = part.replace(/[^a-z0-9']/g, '');
        if (clean) out.push({ word: clean, startSec: word.startSec, endSec: word.endSec });
      }
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Countdowns of at least two descending numbers ending in one or two. Word timestamps scatter,
 * but the cadence of the numbers is regular, so zero is extrapolated from all of them; a command
 * word right after the numbers is a second estimate of the same moment.
 */
export function spokenCountdowns(speech: readonly SpeechSegment[], phrases: PhraseTable = ENGLISH_PHRASES): SpokenCountdown[] {
  const list = tokens(speech);
  const value = (k: number) => NUMBER_WORDS[(list[k] as Token).word];
  const result: SpokenCountdown[] = [];
  for (let i = 0; i < list.length; i++) {
    if (value(i) === undefined) continue;
    let j = i;
    while (
      j + 1 < list.length &&
      value(j + 1) !== undefined &&
      (value(j + 1) as number) < (value(j) as number) &&
      (list[j + 1] as Token).startSec - (list[j] as Token).endSec < MAX_CADENCE_SEC
    ) {
      j++;
    }
    if (j === i || (value(j) as number) > 2) continue;
    const numbers = list.slice(i, j + 1);
    // Per counted step, so "three, one" with a missed "two" still gives the right cadence.
    const steps = numbers.slice(1).map((t, k) => (t.startSec - (numbers[k] as Token).startSec) / ((value(i + k) as number) - (value(i + k + 1) as number)));
    const cadence = median(steps);
    const last = numbers.at(-1) as Token;
    const next = list[j + 1];
    const into = next && next.startSec - last.endSec < COMMAND_GAP_SEC ? commandOf(next.word, phrases) : undefined;
    // Whisper sometimes stretches a number over seconds; then only the command times zero.
    const extrapolated = cadence >= MIN_CADENCE_SEC && cadence <= MAX_CADENCE_SEC ? last.startSec + cadence * (value(j) as number) : undefined;
    const spoken = into && next ? next.startSec : undefined;
    const zeroSec = extrapolated !== undefined && spoken !== undefined ? (extrapolated + spoken) / 2 : (extrapolated ?? spoken);
    if (zeroSec !== undefined) {
      result.push({ startSec: (numbers[0] as Token).startSec, zeroSec, ...(into ? { into } : {}), text: [...numbers, ...(into && next ? [next] : [])].map((t) => t.word).join(' ') });
    }
    i = j;
  }
  return result;
}

function commandOf(word: string, phrases: PhraseTable): 'work' | 'recovery' | undefined {
  if (phrases.work.includes(word)) return 'work';
  if (phrases.recovery.includes(word)) return 'recovery';
  return undefined;
}
