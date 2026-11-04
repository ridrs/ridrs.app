// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AnalysisParams, DecodedAudio } from '@tabata-sync/contracts';
import { binToHz, computeSpectrogram, melFilterBank, type Spectrogram } from './spectrogram.ts';

/** Frame-level features shared by fingerprinting, markers and rhythm analysis. */
export interface FeatureFrames {
  readonly spectrogram: Spectrogram;
  readonly frameRate: number;
  readonly frames: number;
  /** Exact audio duration; `frames / frameRate` overshoots by up to one hop. */
  readonly durationSec: number;
  readonly melBands: number;
  /** Log-mel energy in dB, row-major `[frame * melBands + band]`. */
  readonly logMel: Float32Array;
  /** Frame RMS in dBFS. */
  readonly rmsDb: Float32Array;
  /** Onset strength: half-wave rectified log-mel increase, summed over bands. */
  readonly flux: Float32Array;
  /** Largest single-band log-mel increase; narrow-band sounds (whistles, beeps) stand out here. */
  readonly peakFlux: Float32Array;
  readonly centroidHz: Float32Array;
  /** Share of energy below 200 Hz (kick, bass). */
  readonly lowBandRatio: Float32Array;
}

const POWER_FLOOR = 1e-10;
const LOW_BAND_HZ = 200;

export function extractFeatures(audio: DecodedAudio, params: AnalysisParams['features']): FeatureFrames {
  const spectrogram = computeSpectrogram(audio.samples, audio.sampleRate, params.fftSize, params.hopSize);
  const { frames, bins, power } = spectrogram;
  const filters = melFilterBank(spectrogram, params.melBands, params.minHz, params.maxHz);
  const bands = filters.length;

  const logMel = new Float32Array(frames * bands);
  const rmsDb = new Float32Array(frames);
  const flux = new Float32Array(frames);
  const peakFlux = new Float32Array(frames);
  const centroidHz = new Float32Array(frames);
  const lowBandRatio = new Float32Array(frames);
  const lowBin = Math.round((LOW_BAND_HZ * spectrogram.fftSize) / spectrogram.sampleRate);
  const binHz = binToHz(1, spectrogram);

  for (let frame = 0; frame < frames; frame++) {
    const row = frame * bins;
    let total = 0;
    let low = 0;
    let weighted = 0;
    for (let bin = 0; bin < bins; bin++) {
      const p = power[row + bin] as number;
      total += p;
      weighted += p * bin * binHz;
      if (bin < lowBin) low += p;
    }
    centroidHz[frame] = total > POWER_FLOOR ? weighted / total : 0;
    lowBandRatio[frame] = total > POWER_FLOOR ? low / total : 0;

    for (let band = 0; band < bands; band++) {
      let energy = 0;
      for (const [bin, weight] of filters[band] as Array<[number, number]>) energy += (power[row + bin] as number) * weight;
      logMel[frame * bands + band] = 10 * Math.log10(energy + POWER_FLOOR);
    }
    if (frame > 0) {
      let rise = 0;
      let peak = 0;
      for (let band = 0; band < bands; band++) {
        const diff = (logMel[frame * bands + band] as number) - (logMel[(frame - 1) * bands + band] as number);
        if (diff > 0) rise += diff;
        if (diff > peak) peak = diff;
      }
      flux[frame] = rise / bands;
      peakFlux[frame] = peak;
    }
  }

  // RMS from the time domain over the same centered window as the spectrogram frame.
  const half = params.fftSize / 2;
  const samples = audio.samples;
  for (let frame = 0; frame < frames; frame++) {
    const start = Math.max(0, frame * params.hopSize - half);
    const end = Math.min(samples.length, frame * params.hopSize + half);
    let sum = 0;
    for (let i = start; i < end; i++) sum += (samples[i] as number) ** 2;
    rmsDb[frame] = 10 * Math.log10(sum / Math.max(1, end - start) + POWER_FLOOR);
  }

  return {
    spectrogram,
    frameRate: spectrogram.frameRate,
    frames,
    durationSec: audio.samples.length / audio.sampleRate,
    melBands: bands,
    logMel,
    rmsDb,
    flux,
    peakFlux,
    centroidHz,
    lowBandRatio,
  };
}
