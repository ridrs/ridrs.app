// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FileMetadataSchema } from '@tabata-sync/contracts';
import { FfmpegDecoder } from '../decode/decoder.ts';
import { FfprobeMetadataReader } from '../decode/metadata.ts';
import { AnalysisStore } from '../store/analysis-store.ts';
import { migrate, openDatabase } from '../store/database.ts';
import { fixtureDir, renderTrack, transform, writeTrack } from '../../test/support/synth.ts';
import { ENGINE_VERSION, resolveParams } from './params.ts';
import { AnalysisPipeline } from './pipeline.ts';

describe('analysis pipeline and persistence', () => {
  let dir: string;
  let wavPath: string;
  let mp3Path: string;

  function pipelineWith(store: AnalysisStore, overrides = {}) {
    return new AnalysisPipeline({
      store,
      decoder: new FfmpegDecoder(),
      metadataReader: new FfprobeMetadataReader(),
      params: resolveParams(overrides),
    });
  }

  beforeAll(async () => {
    dir = await fixtureDir();
    wavPath = await writeTrack(dir, 'workout.wav', renderTrack({ seed: 3, bpm: 126, durationSec: 20 }));
    mp3Path = await transform(wavPath, join(dir, 'tagged.mp3'), [
      '-b:a',
      '192k',
      '-metadata',
      'title=Morning Intervals',
      '-metadata',
      'artist=Synthetic Band',
      '-metadata',
      'TBPM=126',
      '-id3v2_version',
      '3',
    ]);
  });

  it('extracts technical metadata and embedded tags without touching the file', async () => {
    const before = await readFile(mp3Path);
    const metadata = await new FfprobeMetadataReader().read(mp3Path);
    expect(FileMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(metadata).toMatchObject({ format: 'mp3', codec: 'mp3', sampleRate: 22050, channels: 1, filename: 'tagged.mp3' });
    expect(metadata.bitrate).toBeGreaterThan(150_000);
    expect(metadata.durationSec).toBeCloseTo(20, 0);
    expect(metadata.tags).toMatchObject({ title: 'Morning Intervals', artist: 'Synthetic Band', bpm: 126 });
    expect(metadata.tags.native['ID3v2.3']?.some((tag) => tag.id === 'TIT2')).toBe(true);
    expect(await readFile(mp3Path)).toEqual(before);
  });

  it('stores a complete, versioned analysis and reads it back', async () => {
    const store = new AnalysisStore(openDatabase(':memory:'));
    const report = await pipelineWith(store).analyzeFile(wavPath);

    expect(report.reused).toBe(false);
    expect(Math.abs(report.bpm - 126)).toBeLessThan(0.5);
    const [run] = store.runs(report.variantId);
    expect(run).toMatchObject({ status: 'succeeded', engineVersion: ENGINE_VERSION, kind: 'full' });

    const fingerprint = store.loadFingerprint(report.runId);
    const rhythm = store.loadRhythm(report.runId);
    const markers = store.loadMarkers(report.runId);
    expect(fingerprint?.hashes.length).toBe(report.fingerprintHashes);
    expect(rhythm?.beats.length).toBe(report.beatCount);
    expect(rhythm?.beats[1]).toBeGreaterThan(rhythm?.beats[0] ?? Number.POSITIVE_INFINITY);
    expect(markers.filter((m) => m.kind === 'regular')).toHaveLength(10);
    expect(markers[0]?.descriptor).toBeInstanceOf(Float32Array);

    const decoder = JSON.parse(
      (store.db.prepare('SELECT decoder_json FROM analysis_run WHERE id = ?').get(report.runId) as { decoder_json: string }).decoder_json,
    );
    expect(decoder).toMatchObject({ tool: 'ffmpeg', sampleRate: 11025, channels: 1 });
  });

  it('reuses an identical analysis, keeps history on forced and changed re-analysis', async () => {
    const store = new AnalysisStore(openDatabase(':memory:'));
    const first = await pipelineWith(store).analyzeFile(wavPath);
    const again = await pipelineWith(store).analyzeFile(wavPath);
    expect(again).toMatchObject({ reused: true, runId: first.runId, variantId: first.variantId });

    const forced = await pipelineWith(store).analyzeFile(wavPath, { force: true });
    const changed = await pipelineWith(store, { markers: { regularIntervalSec: 1 } }).analyzeFile(wavPath);
    expect(new Set([first.runId, forced.runId, changed.runId]).size).toBe(3);
    expect(store.runs(first.variantId)).toHaveLength(3);
    expect(changed.markers.regular).toBe(20);
    // Earlier results stay readable.
    expect(store.loadMarkers(first.runId).filter((m) => m.kind === 'regular')).toHaveLength(10);
  });

  it('identifies a re-imported file by content, not by path', async () => {
    const store = new AnalysisStore(openDatabase(':memory:'));
    const original = await pipelineWith(store).analyzeFile(wavPath);
    const copy = await transform(wavPath, join(dir, 'renamed-copy.wav'), ['-c', 'copy', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact']);
    const metadata = await new FfprobeMetadataReader().read(copy);
    const sameBytes = metadata.sha256 === (await new FfprobeMetadataReader().read(wavPath)).sha256;
    const report = await pipelineWith(store).analyzeFile(copy);
    // A byte-identical copy is the same audio file; a re-muxed one is a new file (variant matching comes in phase 4).
    expect(report.audioFileId === original.audioFileId).toBe(sameBytes);
  });

  it('records a failed run instead of losing it', async () => {
    const store = new AnalysisStore(openDatabase(':memory:'));
    const broken = new AnalysisPipeline({
      store,
      decoder: { decode: () => Promise.reject(new Error('decoder exploded')) },
      metadataReader: new FfprobeMetadataReader(),
      params: resolveParams(),
    });
    await expect(broken.analyzeFile(wavPath)).rejects.toThrow('decoder exploded');
    const [file] = store.listTracks();
    expect(file?.runStatus).toBe('failed');
  });

  it('applies migrations once', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db)).toEqual([]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(['track', 'audio_file', 'audio_variant', 'analysis_run', 'fingerprint', 'audio_marker', 'rhythm', 'manual_correction']),
    );
  });
});
