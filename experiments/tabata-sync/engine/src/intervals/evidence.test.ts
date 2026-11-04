// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import type { DecodedAudio } from '@tabata-sync/contracts';
import { random } from '../../test/support/synth.ts';
import { median } from '../dsp/signal.ts';
import { computeEvidenceCurves, cueStart, EVIDENCE_SAMPLE_RATE } from './evidence.ts';

/** Busy noise with sung-like harmonic notes changing every half second, 60 s long. */
function background(seed: number): Float32Array {
  const rate = EVIDENCE_SAMPLE_RATE;
  const out = new Float32Array(60 * rate);
  const noise = random(seed);
  const notes = [220, 247, 262, 294, 330, 349, 392];
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const f0 = notes[Math.floor(t * 2 + 3 * Math.sin(t)) % notes.length + (Math.floor(t * 2) % 2)] ?? 220;
    let voice = 0;
    for (let h = 1; h <= 16; h++) voice += Math.sin(2 * Math.PI * f0 * h * t) / h;
    out[i] = 0.08 * voice + 0.05 * (noise() * 2 - 1);
  }
  return out;
}

function audioOf(samples: Float32Array): DecodedAudio {
  const sampleRate = EVIDENCE_SAMPLE_RATE;
  return {
    samples,
    sampleRate,
    durationSec: samples.length / sampleRate,
    decoder: { tool: 'test', toolVersion: '0', arguments: [], sampleRate, channels: 1, sampleFormat: 'f32le', decodedSamples: samples.length, elapsedMs: 0 },
  };
}

function addWhistle(out: Float32Array, atSec: number, gain: number, trill: boolean): void {
  const rate = EVIDENCE_SAMPLE_RATE;
  const start = Math.round(atSec * rate);
  for (let i = 0; i < 0.4 * rate; i++) {
    const t = i / rate;
    const flutter = trill ? 0.55 + 0.45 * Math.sin(2 * Math.PI * 28 * t) : 1;
    out[start + i] = (out[start + i] as number) + gain * Math.min(1, t * 100) * flutter * Math.sin(2 * Math.PI * (3300 + (trill ? 60 * Math.sin(2 * Math.PI * 28 * t) : 0)) * t);
  }
}

describe('evidence curves', () => {
  const whistles = [7.2, 19.9, 31.4, 44.8];
  const peakNear = (curve: Float32Array, frameSec: number, sec: number, radius = 0.15) => {
    let best = { value: 0, sec };
    for (let f = Math.round((sec - radius) / frameSec); f <= Math.round((sec + radius) / frameSec); f++) {
      if ((curve[f] as number) > best.value) best = { value: curve[f] as number, sec: f * frameSec };
    }
    return best;
  };

  for (const trill of [true, false]) {
    it(`finds ${trill ? 'trilled' : 'steady'} whistles in busy music and times their start`, () => {
      const samples = background(3);
      for (const at of whistles) addWhistle(samples, at, 0.12, trill);
      const curves = computeEvidenceCurves(audioOf(samples));
      const errors = whistles.map((at) => {
        const peak = peakNear(curves.cue, curves.frameSec, at, 0.2);
        expect(peak.value).toBeGreaterThan(0.4);
        return Math.abs(cueStart(curves, peak.sec) - at);
      });
      // A note right next to a whistle, in its band, can still move a single start; the grid
      // fit takes the timing that most boundaries agree on.
      expect(median(errors)).toBeLessThan(0.05);
      expect(Math.max(...errors)).toBeLessThan(0.4);
    });
  }

  it('measures volume steps in dB with their direction', () => {
    const samples = new Float32Array(30 * EVIDENCE_SAMPLE_RATE);
    const noise = random(9);
    for (let i = 0; i < samples.length; i++) samples[i] = (i < 15 * EVIDENCE_SAMPLE_RATE ? 0.05 : 0.2) * (noise() * 2 - 1);
    const curves = computeEvidenceCurves(audioOf(samples));
    expect(curves.step[Math.round(15 / curves.frameSec)]).toBeCloseTo(20 * Math.log10(4), 0);
    expect(Math.abs(curves.step[Math.round(5 / curves.frameSec)] as number)).toBeLessThan(1);
  });
});
