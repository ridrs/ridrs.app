// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { AudioFormat, AudioTags, FileMetadata } from '@tabata-sync/contracts';
import { parseFile } from 'music-metadata';
import { runProcess, toolVersion } from './process.ts';

/** Reads technical and embedded metadata. Opens the file read-only. */
export interface MetadataReader {
  read(path: string): Promise<FileMetadata>;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  sample_rate?: string;
  channels?: number;
  bit_rate?: string;
  bits_per_raw_sample?: string;
  bits_per_sample?: number;
  duration?: string;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { format_name?: string; duration?: string; bit_rate?: string; size?: string };
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Maps container and codec names to the formats the system supports; the extension only breaks ties. */
export function classifyFormat(container: string, codec: string, path: string): AudioFormat {
  const ext = extname(path).slice(1).toLowerCase();
  if (codec === 'mp3') return 'mp3';
  if (codec === 'flac') return 'flac';
  if (codec === 'opus') return 'opus';
  if (codec === 'vorbis') return 'ogg';
  if (codec === 'aac' || codec === 'alac' || container.includes('mp4')) return 'm4a';
  if (container === 'wav' || codec.startsWith('pcm_')) return 'wav';
  if (ext === 'ogg' || ext === 'oga') return 'ogg';
  return 'other';
}

function positiveInt(value: string | number | undefined): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

// Native tag values may contain binary payloads (cover art, private frames); keep them JSON-safe.
function jsonSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, jsonSafe(inner)]));
  }
  return value;
}

async function readTags(path: string): Promise<AudioTags> {
  try {
    const { common, native } = await parseFile(path, { duration: false, skipCovers: true });
    return {
      title: common.title,
      artist: common.artist,
      album: common.album,
      albumArtist: common.albumartist,
      year: common.year,
      trackNumber: common.track.no ?? undefined,
      genre: common.genre,
      bpm: common.bpm !== undefined && Number.isFinite(Number(common.bpm)) ? Number(common.bpm) : undefined,
      isrc: common.isrc,
      composer: common.composer,
      native: Object.fromEntries(
        Object.entries(native).map(([format, tags]) => [
          format,
          tags.map((tag) => ({ id: tag.id, value: jsonSafe(tag.value) })),
        ]),
      ),
    };
  } catch {
    // Unreadable tags must not block analysis; the audio itself may still decode.
    return { native: {} };
  }
}

/** Technical data from `ffprobe`, tags from `music-metadata`, identity from SHA-256. */
export class FfprobeMetadataReader implements MetadataReader {
  constructor(private readonly command = 'ffprobe') {}

  async read(path: string): Promise<FileMetadata> {
    const [{ stdout }, version, stats, sha256, tags] = await Promise.all([
      runProcess(this.command, [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        path,
      ]),
      toolVersion(this.command),
      stat(path),
      sha256File(path),
      readTags(path),
    ]);
    const probe = JSON.parse(stdout.toString('utf8')) as ProbeOutput;
    const stream = probe.streams?.find((s) => s.codec_type === 'audio');
    if (!stream) throw new Error(`No audio stream in "${basename(path)}"`);

    const container = probe.format?.format_name ?? 'unknown';
    const codec = stream.codec_name ?? 'unknown';
    const durationSec = Number(probe.format?.duration ?? stream.duration ?? 0);
    return {
      path,
      filename: basename(path),
      sizeBytes: stats.size,
      sha256,
      format: classifyFormat(container, codec, path),
      container,
      codec,
      durationSec: Number.isFinite(durationSec) ? durationSec : 0,
      sampleRate: positiveInt(stream.sample_rate) ?? 0,
      channels: stream.channels ?? 0,
      bitrate: positiveInt(stream.bit_rate) ?? positiveInt(probe.format?.bit_rate),
      bitsPerSample: positiveInt(stream.bits_per_raw_sample) ?? positiveInt(stream.bits_per_sample),
      tags,
      probe: { tool: 'ffprobe', toolVersion: version },
    };
  }
}
