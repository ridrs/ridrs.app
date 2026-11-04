// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from 'zod';

/** How the original file was decoded into the internal representation. */
export const DecoderInfoSchema = z.object({
  tool: z.string(),
  toolVersion: z.string(),
  arguments: z.array(z.string()),
  sampleRate: z.number().int().positive(),
  channels: z.literal(1),
  sampleFormat: z.literal('f32le'),
  decodedSamples: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
});
export type DecoderInfo = z.infer<typeof DecoderInfoSchema>;

export const AudioFormatSchema = z.enum(['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'other']);
export type AudioFormat = z.infer<typeof AudioFormatSchema>;

/** Embedded tags, normalized across ID3, Vorbis comments and MP4 atoms. */
export const AudioTagsSchema = z.object({
  title: z.string().optional(),
  artist: z.string().optional(),
  album: z.string().optional(),
  albumArtist: z.string().optional(),
  year: z.number().int().optional(),
  trackNumber: z.number().int().optional(),
  genre: z.array(z.string()).optional(),
  bpm: z.number().optional(),
  isrc: z.array(z.string()).optional(),
  composer: z.array(z.string()).optional(),
  /** Every native tag as found in the file, keyed by tag format (e.g. `ID3v2.4`, `vorbis`). */
  native: z.record(z.string(), z.array(z.object({ id: z.string(), value: z.unknown() }))),
});
export type AudioTags = z.infer<typeof AudioTagsSchema>;

/** Everything known about an original audio file before analysis. The file itself is never modified. */
export const FileMetadataSchema = z.object({
  path: z.string(),
  filename: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  format: AudioFormatSchema,
  container: z.string(),
  codec: z.string(),
  durationSec: z.number().nonnegative(),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  bitrate: z.number().int().positive().optional(),
  bitsPerSample: z.number().int().positive().optional(),
  tags: AudioTagsSchema,
  probe: z.object({ tool: z.string(), toolVersion: z.string() }),
});
export type FileMetadata = z.infer<typeof FileMetadataSchema>;

/** Mono float PCM, the normalized internal representation every analysis step works on. */
export interface DecodedAudio {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly durationSec: number;
  readonly decoder: DecoderInfo;
}
