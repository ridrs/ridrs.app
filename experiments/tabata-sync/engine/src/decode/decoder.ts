// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DecodedAudio } from '@tabata-sync/contracts';
import { runProcess, toolVersion } from './process.ts';

export interface DecodeOptions {
  readonly sampleRate: number;
  /** Decode only part of the file; analysis normally decodes everything. */
  readonly startSec?: number;
  readonly durationSec?: number;
}

/** Turns any supported file into mono float PCM. Implementations must not modify the source file. */
export interface AudioDecoder {
  decode(path: string, options: DecodeOptions): Promise<DecodedAudio>;
}

/** Decodes with the system `ffmpeg` binary, which handles MP3, WAV, FLAC, AAC/M4A, Ogg and Opus. */
export class FfmpegDecoder implements AudioDecoder {
  constructor(private readonly command = 'ffmpeg') {}

  async decode(path: string, options: DecodeOptions): Promise<DecodedAudio> {
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
    if (options.startSec !== undefined) args.push('-ss', String(options.startSec));
    args.push('-i', path);
    if (options.durationSec !== undefined) args.push('-t', String(options.durationSec));
    // Downmix to mono, resample with a long windowed-sinc filter (SoX is not in every build), emit raw float32.
    args.push('-vn', '-ac', '1', '-af', `aresample=${options.sampleRate}:filter_size=64:cutoff=0.97`);
    args.push('-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1');

    const started = performance.now();
    const [{ stdout }, version] = await Promise.all([
      runProcess(this.command, args),
      toolVersion(this.command),
    ]);
    // Copy into an aligned buffer: Node may hand out pooled Buffers at odd offsets.
    const samples = new Float32Array(stdout.byteLength >>> 2);
    new Uint8Array(samples.buffer).set(stdout.subarray(0, samples.length * 4));

    return {
      samples,
      sampleRate: options.sampleRate,
      durationSec: samples.length / options.sampleRate,
      decoder: {
        tool: 'ffmpeg',
        toolVersion: version,
        arguments: args.map((arg) => (arg === path ? '<input>' : arg)),
        sampleRate: options.sampleRate,
        channels: 1,
        sampleFormat: 'f32le',
        decodedSamples: samples.length,
        elapsedMs: performance.now() - started,
      },
    };
  }
}
