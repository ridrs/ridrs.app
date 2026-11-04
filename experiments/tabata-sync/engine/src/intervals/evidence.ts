// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DecodedAudio } from '@tabata-sync/contracts';
import { computeSpectrogram } from '../dsp/spectrogram.ts';
import { median, quantile, slidingMax } from '../dsp/signal.ts';

/** Interval evidence is computed from audio at this rate; boundaries are timed to one frame. */
export const EVIDENCE_SAMPLE_RATE = 22050;
const HOP = 220;
const FFT_SIZE = 1024;
export const EVIDENCE_FRAME_SEC = HOP / EVIDENCE_SAMPLE_RATE;

/** Tonal cues (whistles, beeps) are searched between these frequencies. */
const CUE_MIN_HZ = 500;
const CUE_MAX_HZ = 5000;
/** A cue must stand out over this long; a whistle or beep lasts at least a quarter second. */
const CUE_SUSTAIN_SEC = 0.25;
/** A cue's start is searched this far before where its curve peaks. */
const CUE_START_SEARCH_SEC = 0.3;
/**
 * A pea whistle's trill: its level flutters at these rates, where sung notes and synths are
 * smooth. Measured on a finer time grid in the whistle's frequency range.
 */
const TRILL_BANDS_HZ: ReadonlyArray<readonly [number, number]> = [[2400, 3000], [2800, 3500], [3200, 4000], [3700, 4600]];
const TRILL_MIN_HZ = 15;
const TRILL_MAX_HZ = 50;
const TRILL_FFT = 256;
const TRILL_HOP = HOP / 2;
const TRILL_WINDOW_SEC = 0.3;
const TRILL_BRIDGE_SEC = 0.04;
/** A cue is compared with the music between these distances before and after it. */
const FOREIGN_GAP_SEC = 0.6;
const FOREIGN_CONTEXT_SEC = 3;
/** Volume steps compare the median level over this long before and after a time. */
const STEP_WINDOW_SEC = 2;
const STEP_EVERY_FRAMES = 5;

/**
 * Per-frame evidence curves. `onset` and `cue` are scaled so their 99th percentile is about 1;
 * `step` is the level change at a frame in dB (positive: louder afterwards).
 */
export interface EvidenceCurves {
  readonly frameSec: number;
  readonly frames: number;
  /** Spectral flux: where something starts, e.g. a beat. */
  readonly onset: Float32Array;
  /** A narrow band standing out of its neighborhood for a quarter second, starting at a frame. */
  readonly cue: Float32Array;
  /** Per frame, the band that carries `cue` there, for timing a cue with `cueStart`. */
  readonly cueBand: Int16Array;
  /** Per cue band, its frame values before smoothing, and how far they lead the cue's start. */
  readonly cueBands: ReadonlyArray<{ readonly raw: Float32Array; readonly leadSec: number }>;
  readonly step: Float32Array;
  /** Broadband level in dB. */
  readonly level: Float32Array;
}

export function computeEvidenceCurves(audio: DecodedAudio): EvidenceCurves {
  if (audio.sampleRate !== EVIDENCE_SAMPLE_RATE) throw new Error(`Evidence needs ${EVIDENCE_SAMPLE_RATE} Hz audio, got ${audio.sampleRate} Hz`);
  const spec = computeSpectrogram(audio.samples, audio.sampleRate, FFT_SIZE, HOP);
  const { frames, bins } = spec;
  const binHz = audio.sampleRate / FFT_SIZE;

  const onset = new Float32Array(frames);
  const level = new Float32Array(frames);
  const logPower = new Float32Array(bins);
  const previous = new Float32Array(bins);
  const cumulative = new Float64Array(bins + 1);
  const centers: number[] = [];
  for (let hz = CUE_MIN_HZ; hz <= CUE_MAX_HZ; hz *= 2 ** (1 / 12)) centers.push(hz);
  const bumps = centers.map(() => new Float32Array(frames));
  const bandDb = (fromHz: number, toHz: number) => {
    const a = Math.max(1, Math.round(fromHz / binHz));
    const b = Math.max(a + 1, Math.round(toHz / binHz));
    return 10 * Math.log10((cumulative[b] as number) - (cumulative[a] as number) + 1e-12) - 10 * Math.log10(b - a);
  };

  for (let f = 0; f < frames; f++) {
    const row = f * bins;
    let flux = 0;
    for (let b = 0; b < bins; b++) {
      const p = spec.power[row + b] as number;
      cumulative[b + 1] = (cumulative[b] as number) + p;
      logPower[b] = Math.log10(p + 1e-10);
      if (b > 0) flux += Math.max(0, (logPower[b] as number) - (previous[b] as number));
    }
    previous.set(logPower);
    onset[f] = f === 0 ? 0 : flux;
    level[f] = 10 * Math.log10((cumulative[bins] as number) / bins + 1e-12);
    // A band of ±10 % that rises above the bands on both sides: a whistle's trill or a beep.
    for (const [k, c] of centers.entries()) {
      (bumps[k] as Float32Array)[f] = bandDb(0.9 * c, 1.1 * c) - Math.max(bandDb(0.72 * c, 0.84 * c), bandDb(1.16 * c, 1.3 * c));
    }
  }

  // Tonal cues (beeps, steady whistles) and trilled whistles, each band on its own: against its
  // usual values (sung notes bump their bands all the time), then against the seconds around
  // it. A cue is the strongest band; 1 is a band's 99th percentile.
  const cue = new Float32Array(frames);
  const cueBand = new Int16Array(frames);
  const sustain = Math.max(1, Math.round(CUE_SUSTAIN_SEC / EVIDENCE_FRAME_SEC));
  // A tonal band's frames are its sound; a trill value describes the window that starts there,
  // which reaches half strength while still half before the whistle.
  // A trilled whistle dips in its band every few frames; timing bridges the dips.
  const bridge = Math.round(TRILL_BRIDGE_SEC / EVIDENCE_FRAME_SEC);
  const cueBands = [
    // Bridging moves a rise earlier by its own width; the lead puts it back.
    ...bumps.map((raw) => ({ raw: slidingMax(scaleToPercentile(raw, true), bridge), sustained: forwardMean(raw, sustain), leadSec: bridge * EVIDENCE_FRAME_SEC })),
    ...trillBands(audio.samples, frames).map((raw) => ({ raw: scaleToPercentile(raw, true), sustained: raw, leadSec: TRILL_WINDOW_SEC / 2 })),
  ];
  for (const [k, { sustained }] of cueBands.entries()) {
    const band = foreign(scaleToPercentile(sustained, true));
    for (let f = 0; f < frames; f++) {
      if ((band[f] as number) > (cue[f] as number)) {
        cue[f] = band[f] as number;
        cueBand[f] = k;
      }
    }
  }
  return {
    frameSec: EVIDENCE_FRAME_SEC,
    frames,
    onset: scaleToPercentile(onset),
    cue,
    cueBand,
    cueBands: cueBands.map(({ raw, leadSec }) => ({ raw, leadSec })),
    step: levelSteps(level),
    level,
  };
}

/**
 * Where the cue seen at `sec` starts, in its own band: from the band's strongest frame of the cue
 * back to where the band last was below half that strength. Drums and voices in other bands do
 * not move it; a note in the same band right next to the cue can, which the grid fit absorbs.
 */
export function cueStart(curves: EvidenceCurves, sec: number): number {
  const frame = Math.min(curves.frames - 1, Math.max(0, Math.round(sec / curves.frameSec)));
  const band = curves.cueBands[curves.cueBand[frame] as number];
  if (!band) return sec;
  const span = Math.round(CUE_SUSTAIN_SEC / curves.frameSec);
  let top = frame;
  for (let f = frame; f < Math.min(curves.frames, frame + span); f++) if ((band.raw[f] as number) > (band.raw[top] as number)) top = f;
  const half = 0.5 * (band.raw[top] as number);
  const earliest = Math.max(0, frame - Math.round(CUE_START_SEARCH_SEC / curves.frameSec));
  let start = top;
  while (start > earliest && (band.raw[start - 1] as number) >= half) start--;
  return start * curves.frameSec + band.leadSec;
}

/**
 * How far a cue stands out of the music around it: the strongest cue a few seconds before or
 * after is subtracted. Notes of a melody or a sung line recur within seconds; a whistle or beep
 * on a boundary does not.
 */
function foreign(curve: Float32Array): Float32Array {
  const near = Math.round(FOREIGN_GAP_SEC / EVIDENCE_FRAME_SEC);
  const far = Math.round(FOREIGN_CONTEXT_SEC / EVIDENCE_FRAME_SEC);
  const block = far - near;
  // Maximum over [i, i + block) for every i, from block-wise prefix and suffix maxima.
  const n = curve.length;
  const prefix = new Float32Array(n);
  const suffix = new Float32Array(n);
  for (let i = 0; i < n; i++) prefix[i] = i % block === 0 ? (curve[i] as number) : Math.max(prefix[i - 1] as number, curve[i] as number);
  for (let i = n - 1; i >= 0; i--) suffix[i] = i % block === block - 1 || i === n - 1 ? (curve[i] as number) : Math.max(suffix[i + 1] as number, curve[i] as number);
  const windowMax = (from: number) => {
    const a = Math.max(0, from);
    const b = Math.min(n - 1, from + block - 1);
    return b < a ? 0 : Math.max(suffix[a] as number, prefix[b] as number);
  };
  return curve.map((v, f) => Math.max(0, v - Math.max(windowMax(f - far), windowMax(f + near + 1))));
}

/** Mean over the next `length` frames: a cue sustained from this frame on. */
function forwardMean(series: Float32Array, length: number): Float32Array {
  const out = new Float32Array(series.length);
  let sum = 0;
  for (let f = series.length - 1; f >= 0; f--) {
    sum += series[f] as number;
    if (f + length < series.length) sum -= series[f + length] as number;
    out[f] = sum / Math.min(length, series.length - f);
  }
  return out;
}

/** Per band and frame: how strongly the whistle bands flutter over the next 0.3 s, weighted by their level. */
function trillBands(samples: Float32Array, frames: number): Float32Array[] {
  const spec = computeSpectrogram(samples, EVIDENCE_SAMPLE_RATE, TRILL_FFT, TRILL_HOP);
  const binHz = EVIDENCE_SAMPLE_RATE / TRILL_FFT;
  const window = Math.round((TRILL_WINDOW_SEC * EVIDENCE_SAMPLE_RATE) / TRILL_HOP);
  const envelopeRate = EVIDENCE_SAMPLE_RATE / TRILL_HOP;
  const fromK = Math.max(1, Math.round((TRILL_MIN_HZ * window) / envelopeRate));
  const toK = Math.min(window / 2, Math.round((TRILL_MAX_HZ * window) / envelopeRate));
  const cos = Array.from({ length: toK + 1 }, (_, k) => Float64Array.from({ length: window }, (_, g) => Math.cos((2 * Math.PI * k * g) / window)));
  const sin = Array.from({ length: toK + 1 }, (_, k) => Float64Array.from({ length: window }, (_, g) => Math.sin((2 * Math.PI * k * g) / window)));
  const bands: Float32Array[] = [];
  const envelope = new Float32Array(spec.frames);
  const centered = new Float64Array(window);
  for (const [fromHz, toHz] of TRILL_BANDS_HZ) {
    const out = new Float32Array(frames);
    bands.push(out);
    const a = Math.round(fromHz / binHz);
    const b = Math.round(toHz / binHz);
    for (let f = 0; f < spec.frames; f++) {
      let s = 0;
      for (let k = a; k < b; k++) s += spec.power[f * spec.bins + k] as number;
      envelope[f] = Math.sqrt(s);
    }
    for (let f = 0; f + window < spec.frames; f += 2) {
      let mean = 0;
      for (let g = 0; g < window; g++) mean += envelope[f + g] as number;
      mean /= window;
      let variance = 0;
      for (let g = 0; g < window; g++) {
        centered[g] = (envelope[f + g] as number) - mean;
        variance += (centered[g] as number) ** 2;
      }
      if (variance <= 0) continue;
      let fast = 0;
      for (let k = fromK; k <= toK; k++) {
        let re = 0;
        let im = 0;
        const c = cos[k] as Float64Array;
        const s = sin[k] as Float64Array;
        for (let g = 0; g < window; g++) {
          re += (centered[g] as number) * (c[g] as number);
          im += (centered[g] as number) * (s[g] as number);
        }
        fast += re * re + im * im;
      }
      // Parseval: the one-sided spectrum of a real window holds half its energy times its length.
      const share = fast / ((variance * window) / 2);
      const value = share * Math.log10(1 + mean * 1e3);
      const frame = Math.floor(f / 2);
      if (frame < frames && value > (out[frame] as number)) out[frame] = value;
    }
  }
  return bands;
}

/** Scales a curve so its 99th percentile is 1; `relative` first removes the median. */
function scaleToPercentile(curve: Float32Array, relative = false): Float32Array {
  const sample = curve.filter((_, k) => k % 4 === 0);
  const base = relative ? median(sample) : 0;
  const top = quantile(sample, 0.99) - base;
  return curve.map((v) => (top > 0 ? Math.max(0, v - base) / top : 0));
}

function levelSteps(level: Float32Array): Float32Array {
  const radius = Math.round(STEP_WINDOW_SEC / EVIDENCE_FRAME_SEC);
  const step = new Float32Array(level.length);
  for (let f = 0; f < level.length; f += STEP_EVERY_FRAMES) {
    const before = level.subarray(Math.max(0, f - radius), f);
    const after = level.subarray(f, Math.min(level.length, f + radius));
    const value = before.length > 10 && after.length > 10 ? median(after) - median(before) : 0;
    for (let g = f; g < Math.min(level.length, f + STEP_EVERY_FRAMES); g++) step[g] = value;
  }
  return step;
}
