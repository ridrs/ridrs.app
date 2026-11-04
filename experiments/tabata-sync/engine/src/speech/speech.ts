// SPDX-License-Identifier: AGPL-3.0-or-later

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecodedAudio, SpeechSegment } from '@tabata-sync/contracts';
import { runProcess } from '../decode/process.ts';
import { encodeWav } from '../decode/wav.ts';

/** Sample rate every recognizer receives. */
export const SPEECH_SAMPLE_RATE = 16000;

/** Local speech recognition. Optional: the interval detector works without it. */
export interface SpeechRecognizer {
  readonly id: string;
  readonly version: string;
  available(): Promise<boolean>;
  transcribe(audio: DecodedAudio): Promise<SpeechSegment[]>;
}

/** Used when no recognizer is installed; reports no speech. */
export class NullSpeechRecognizer implements SpeechRecognizer {
  readonly id = 'none';
  readonly version = '0';
  async available(): Promise<boolean> {
    return false;
  }
  async transcribe(): Promise<SpeechSegment[]> {
    return [];
  }
}

export interface Word {
  readonly text: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly confidence: number;
}

interface WhisperToken {
  text: string;
  p: number;
}

interface WhisperOutput {
  transcription: Array<{ offsets: { from: number; to: number }; text: string; tokens?: WhisperToken[] }>;
}

export const DEFAULT_WHISPER_MODEL = join(homedir(), '.cache', 'tabata-sync', 'models', 'ggml-base.en.bin');

export interface WhisperOptions {
  readonly command?: string;
  readonly modelPath?: string;
  /** Chunk length and hop. Whisper's timestamps drift by seconds over long audio; short chunks keep them tight. */
  readonly chunkSec?: number;
  readonly hopSec?: number;
  /** Words further apart than this start a new segment. */
  readonly segmentGapSec?: number;
  /**
   * Words whose timing matters most (spoken commands). Each one is re-transcribed in a short
   * window ending just after it, which pins its timestamp much closer than the chunk pass does.
   */
  readonly focusWords?: readonly string[];
}

/** Commands of the default English phrase table plus their countdown numbers. */
export const DEFAULT_FOCUS_WORDS = ['go', 'start', 'work', 'begin', 'stop', 'rest', 'recover', 'relax', 'break', 'pause'];
/** Two differently placed windows per command (seconds before and after it). */
const FOCUS_WINDOWS: ReadonlyArray<{ before: number; after: number }> = [
  { before: 4, after: 1 },
  { before: 3, after: 2.5 },
];
/** A refined word must be found this close to its first-pass position. */
const FOCUS_MATCH_SEC = 2.5;
/** Both windows must agree this closely, or the first-pass time stays. */
const FOCUS_AGREEMENT_SEC = 0.3;

/**
 * whisper.cpp (`whisper-cli`) with per-word segments. The audio is cut into overlapping chunks that
 * are transcribed in one process (the model loads once); every word is taken from the chunk in
 * which it lies closest to the center, which removes duplicates and edge effects.
 */
export class WhisperCppRecognizer implements SpeechRecognizer {
  readonly id = 'whisper.cpp';
  readonly version: string;
  private readonly command: string;
  private readonly modelPath: string;
  private readonly chunkSec: number;
  private readonly hopSec: number;
  private readonly segmentGapSec: number;
  private readonly focusWords: ReadonlySet<string>;

  constructor(options: WhisperOptions = {}) {
    this.command = options.command ?? 'whisper-cli';
    this.modelPath = options.modelPath ?? process.env.TABATA_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL;
    this.chunkSec = options.chunkSec ?? 10;
    this.hopSec = options.hopSec ?? 5;
    this.segmentGapSec = options.segmentGapSec ?? 0.8;
    this.focusWords = new Set(options.focusWords ?? DEFAULT_FOCUS_WORDS);
    this.version = `chunk${this.chunkSec}-hop${this.hopSec}-nofallback-noloops-focus2:${this.modelPath.split('/').at(-1)}`;
  }

  async available(): Promise<boolean> {
    try {
      await access(this.modelPath);
      await runProcess(this.command, ['--help']);
      return true;
    } catch {
      return false;
    }
  }

  async transcribe(audio: DecodedAudio): Promise<SpeechSegment[]> {
    if (audio.sampleRate !== SPEECH_SAMPLE_RATE) throw new Error(`Speech audio must be ${SPEECH_SAMPLE_RATE} Hz`);
    const dir = await mkdtemp(join(tmpdir(), 'tabata-speech-'));
    try {
      const starts: number[] = [];
      for (let start = 0; start < audio.durationSec; start += this.hopSec) {
        starts.push(start);
        if (start + this.chunkSec >= audio.durationSec) break;
      }
      const files = await Promise.all(
        starts.map(async (start, i) => {
          const from = Math.round(start * audio.sampleRate);
          const to = Math.min(audio.samples.length, Math.round((start + this.chunkSec) * audio.sampleRate));
          const file = join(dir, `chunk-${String(i).padStart(4, '0')}.wav`);
          await writeFile(file, encodeWav(audio.samples.subarray(from, to), audio.sampleRate));
          return file;
        }),
      );
      // No temperature fallback: on sung choruses whisper falls into repetition loops and the
      // retries at higher temperatures cost minutes without recovering spoken commands.
      const args = ['-m', this.modelPath, '-ojf', '-ml', '1', '-sow', '-np', '-nf'];
      for (const file of files) args.push('-f', file);
      await runProcess(this.command, args);

      const words: Word[] = [];
      for (const [i, file] of files.entries()) {
        const start = starts[i] as number;
        const output = JSON.parse(await readFile(`${file}.json`, 'utf8')) as WhisperOutput;
        // Each chunk owns the central part of its window; the first and last also own their outer edge.
        const margin = (this.chunkSec - this.hopSec) / 2;
        const ownFrom = i === 0 ? Number.NEGATIVE_INFINITY : start + margin;
        const ownTo = i === files.length - 1 ? Number.POSITIVE_INFINITY : start + margin + this.hopSec;
        for (const entry of output.transcription) {
          const text = entry.text.trim();
          if (!text || /^\[.*\]$/.test(text)) continue;
          const word = {
            text,
            startSec: start + entry.offsets.from / 1000,
            endSec: start + entry.offsets.to / 1000,
            confidence: tokenConfidence(entry.tokens),
          };
          const center = (word.startSec + word.endSec) / 2;
          if (center >= ownFrom && center < ownTo) words.push(word);
        }
      }
      const cleaned = dropRepetitionLoops(words.sort((a, b) => a.startSec - b.startSec));
      const refined = await this.refineFocusWords(audio, cleaned, dir);
      return groupWords(refined, this.segmentGapSec);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Second pass for spoken commands: two short windows around each one (one ending just after
   * it, one reaching further past it) are transcribed again, all in one process. In short windows
   * whisper's timestamps are much tighter than in 10 s chunks, but a single window sometimes
   * stretches a word near its edge; the refined time is used only when both windows agree.
   * The countdown words before the command move with it.
   */
  private async refineFocusWords(audio: DecodedAudio, words: readonly Word[], dir: string): Promise<Word[]> {
    const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9']/g, '');
    const focus = words.map((w, i) => ({ w, i })).filter(({ w }) => this.focusWords.has(key(w.text)));
    if (focus.length === 0) return [...words];
    const windows = await Promise.all(
      focus.flatMap(({ w }, k) =>
        FOCUS_WINDOWS.map(async (shape, n) => {
          const startSec = Math.max(0, w.endSec - shape.before);
          const endSec = Math.min(audio.durationSec, w.endSec + shape.after);
          const file = join(dir, `focus-${String(k).padStart(4, '0')}-${n}.wav`);
          const samples = audio.samples.subarray(Math.round(startSec * audio.sampleRate), Math.round(endSec * audio.sampleRate));
          await writeFile(file, encodeWav(samples, audio.sampleRate));
          return { file, startSec, focusIndex: k };
        }),
      ),
    );
    const args = ['-m', this.modelPath, '-ojf', '-ml', '1', '-sow', '-np', '-nf'];
    for (const window of windows) args.push('-f', window.file);
    await runProcess(this.command, args);

    const refinedEnds = new Map<number, Array<{ startSec: number; endSec: number }>>();
    for (const window of windows) {
      const { w } = focus[window.focusIndex] as (typeof focus)[number];
      const output = JSON.parse(await readFile(`${window.file}.json`, 'utf8')) as WhisperOutput;
      const match = output.transcription
        .map((entry) => ({ text: entry.text.trim(), startSec: window.startSec + entry.offsets.from / 1000, endSec: window.startSec + entry.offsets.to / 1000 }))
        .filter((entry) => key(entry.text) === key(w.text) && entry.endSec > entry.startSec && Math.abs(entry.endSec - w.endSec) <= FOCUS_MATCH_SEC)
        .sort((a, b) => Math.abs(a.endSec - w.endSec) - Math.abs(b.endSec - w.endSec))[0];
      if (match) refinedEnds.set(window.focusIndex, [...(refinedEnds.get(window.focusIndex) ?? []), match]);
    }

    const result = [...words];
    for (const [k, { w, i }] of focus.entries()) {
      const found = refinedEnds.get(k) ?? [];
      if (found.length < FOCUS_WINDOWS.length) continue;
      const ends = found.map((f) => f.endSec);
      if (Math.max(...ends) - Math.min(...ends) > FOCUS_AGREEMENT_SEC) continue;
      const endSec = ends.reduce((sum, e) => sum + e, 0) / ends.length;
      const startSec = found.reduce((sum, f) => sum + f.startSec, 0) / found.length;
      const shift = endSec - w.endSec;
      result[i] = { ...w, startSec, endSec };
      for (let j = i - 1; j >= 0 && (result[j] as Word).endSec > w.endSec - FOCUS_WINDOWS[0]!.before; j--) {
        const previous = result[j] as Word;
        result[j] = { ...previous, startSec: previous.startSec + shift, endSec: previous.endSec + shift };
      }
    }
    return result.sort((a, b) => a.startSec - b.startSec);
  }
}

function tokenConfidence(tokens: WhisperToken[] | undefined): number {
  const real = (tokens ?? []).filter((token) => !token.text.startsWith('[_') && token.text.trim() !== '');
  if (real.length === 0) return 0.5;
  return real.reduce((sum, token) => sum + token.p, 0) / real.length;
}

/** Runs of the same word repeated at least this often are decoder loops, not speech. */
const LOOP_LENGTH = 4;

/** Removes whisper's repetition loops ("play, play, play, play, …"), which are hallucinations on music. */
export function dropRepetitionLoops(words: readonly Word[]): Word[] {
  const key = (w: Word) => w.text.toLowerCase().replace(/[^a-z0-9']/g, '');
  const kept: Word[] = [];
  for (let i = 0; i < words.length; ) {
    let j = i + 1;
    while (j < words.length && key(words[j] as Word) === key(words[i] as Word) && key(words[i] as Word) !== '') j++;
    if (j - i < LOOP_LENGTH) kept.push(...words.slice(i, j));
    i = j;
  }
  return kept;
}

export function groupWords(words: readonly Word[], gapSec: number): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  let current: Word[] = [];
  const flush = () => {
    if (current.length === 0) return;
    segments.push({
      text: current.map((w) => w.text).join(' '),
      startSec: (current[0] as Word).startSec,
      endSec: (current.at(-1) as Word).endSec,
      confidence: current.reduce((sum, w) => sum + w.confidence, 0) / current.length,
      words: current.map((w) => ({ ...w })),
    });
    current = [];
  };
  for (const word of words) {
    const previous = current.at(-1);
    if (previous && word.startSec - previous.endSec > gapSec) flush();
    current.push(word);
  }
  flush();
  return segments;
}
