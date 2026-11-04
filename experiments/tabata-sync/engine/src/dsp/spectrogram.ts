// SPDX-License-Identifier: AGPL-3.0-or-later

import FFT from 'fft.js';

/** Power spectrogram, row-major: `power[frame * bins + bin]`. Frame `i` is centered on sample `i * hopSize`. */
export interface Spectrogram {
  readonly sampleRate: number;
  readonly fftSize: number;
  readonly hopSize: number;
  readonly frameRate: number;
  readonly frames: number;
  readonly bins: number;
  readonly power: Float32Array;
}

export function hannWindow(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return window;
}

export function binToHz(bin: number, spectrogram: Pick<Spectrogram, 'sampleRate' | 'fftSize'>): number {
  return (bin * spectrogram.sampleRate) / spectrogram.fftSize;
}

export function hzToBin(hz: number, spectrogram: Pick<Spectrogram, 'sampleRate' | 'fftSize'>): number {
  return (hz * spectrogram.fftSize) / spectrogram.sampleRate;
}

export function computeSpectrogram(
  samples: Float32Array,
  sampleRate: number,
  fftSize: number,
  hopSize: number,
): Spectrogram {
  const fft = new FFT(fftSize);
  const window = hannWindow(fftSize);
  const bins = fftSize / 2 + 1;
  const frames = Math.max(1, Math.ceil(samples.length / hopSize));
  const power = new Float32Array(frames * bins);
  const input = new Float64Array(fftSize);
  const output = new Float64Array(fftSize * 2);
  const half = fftSize / 2;

  for (let frame = 0; frame < frames; frame++) {
    const start = frame * hopSize - half;
    for (let i = 0; i < fftSize; i++) {
      const index = start + i;
      input[i] = index >= 0 && index < samples.length ? (samples[index] as number) * (window[i] as number) : 0;
    }
    fft.realTransform(output, input);
    const row = frame * bins;
    for (let bin = 0; bin < bins; bin++) {
      const re = output[2 * bin] as number;
      const im = output[2 * bin + 1] as number;
      power[row + bin] = re * re + im * im;
    }
  }
  return { sampleRate, fftSize, hopSize, frameRate: sampleRate / hopSize, frames, bins, power };
}

/** Triangular mel filters (HTK mel scale); `weights[band]` lists `[bin, weight]` pairs. */
export function melFilterBank(
  spectrogram: Pick<Spectrogram, 'sampleRate' | 'fftSize' | 'bins'>,
  bands: number,
  minHz: number,
  maxHz: number,
): Array<Array<[number, number]>> {
  const toMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
  const fromMel = (mel: number) => 700 * (10 ** (mel / 2595) - 1);
  const lowMel = toMel(minHz);
  const highMel = toMel(Math.min(maxHz, spectrogram.sampleRate / 2));
  const edges = Array.from({ length: bands + 2 }, (_, i) =>
    hzToBin(fromMel(lowMel + ((highMel - lowMel) * i) / (bands + 1)), spectrogram),
  );

  return Array.from({ length: bands }, (_, band) => {
    const [left, center, right] = [edges[band], edges[band + 1], edges[band + 2]] as [number, number, number];
    const filter: Array<[number, number]> = [];
    for (let bin = Math.max(0, Math.floor(left)); bin <= Math.min(spectrogram.bins - 1, Math.ceil(right)); bin++) {
      const weight = bin <= center ? (bin - left) / (center - left) : (right - bin) / (right - center);
      if (weight > 0) filter.push([bin, weight]);
    }
    // Very narrow low bands can fall between bins; give them the nearest bin.
    if (filter.length === 0) filter.push([Math.min(spectrogram.bins - 1, Math.round(center)), 1]);
    return filter;
  });
}
