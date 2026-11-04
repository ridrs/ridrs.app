// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { AnalysisParams, AudioMarker, DecoderInfo, FileMetadata, IntervalParams, WorkoutStructure } from '@tabata-sync/contracts';
import type { AudioDecoder } from '../decode/decoder.ts';
import type { MetadataReader } from '../decode/metadata.ts';
import { extractFeatures } from '../dsp/features.ts';
import { extractFingerprint } from '../fingerprint/landmarks.ts';
import { IntervalDetector } from '../intervals/detector.ts';
import { computeEvidenceCurves, EVIDENCE_SAMPLE_RATE } from '../intervals/evidence.ts';
import { generateMarkers } from '../markers/markers.ts';
import { analyzeRhythm } from '../rhythm/rhythm.ts';
import { NullSpeechRecognizer, SPEECH_SAMPLE_RATE, type SpeechRecognizer } from '../speech/speech.ts';
import type { AnalysisStore } from '../store/analysis-store.ts';
import { canonicalJson, COMPONENT_VERSIONS, DEFAULT_INTERVAL_PARAMS, ENGINE_VERSION } from './params.ts';


export interface AnalysisReport {
  readonly path: string;
  readonly audioFileId: string;
  readonly trackId: string;
  readonly variantId: string;
  readonly runId: string;
  /** True when an earlier run with identical engine version and parameters was reused. */
  readonly reused: boolean;
  readonly metadata: Pick<FileMetadata, 'filename' | 'format' | 'codec' | 'durationSec' | 'sampleRate' | 'channels' | 'bitrate'> & {
    readonly title?: string;
    readonly artist?: string;
    readonly taggedBpm?: number;
  };
  readonly bpm: number;
  readonly bpmConfidence: number;
  readonly beatCount: number;
  readonly tempoSegments: number;
  readonly fingerprintHashes: number;
  readonly markers: Record<string, number>;
  readonly speechSegments: number;
  readonly timingsMs: Record<string, number>;
}

export interface IntervalReport {
  readonly variantId: string;
  readonly runId: string;
  readonly reused: boolean;
  readonly candidates: number;
  readonly structure: WorkoutStructure;
}

export interface PipelineDependencies {
  readonly store: AnalysisStore;
  readonly decoder: AudioDecoder;
  readonly metadataReader: MetadataReader;
  readonly params: AnalysisParams;
  /** Optional; without it the base analysis stores no speech. */
  readonly speech?: SpeechRecognizer;
  readonly intervalParams?: IntervalParams;
}

function countMarkers(markers: readonly AudioMarker[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const marker of markers) counts[marker.type] = (counts[marker.type] ?? 0) + 1;
  return counts;
}

/**
 * Base analysis: metadata → decode → features → fingerprint → rhythm → markers → speech → store.
 * Interval detection is a separate step (`detectIntervals`) on stored speech and the decoded
 * audio, so it can be re-run with other parameters without transcribing again.
 * Every file currently becomes the reference variant of its own track; recognizing known
 * tracks before analysis is the matcher's job (phase 4).
 */
export class AnalysisPipeline {
  private speechAvailable: Promise<boolean> | undefined;

  constructor(private readonly deps: PipelineDependencies) {}

  private speech(): Promise<SpeechRecognizer> {
    const recognizer = this.deps.speech ?? new NullSpeechRecognizer();
    this.speechAvailable ??= recognizer.available();
    return this.speechAvailable.then((ok) => (ok ? recognizer : new NullSpeechRecognizer()));
  }

  async analyzeFile(inputPath: string, options: { force?: boolean } = {}): Promise<AnalysisReport> {
    const { store, decoder, metadataReader, params } = this.deps;
    const path = resolve(inputPath);
    const timings: Record<string, number> = {};
    const timed = async <T>(stage: string, work: () => T | Promise<T>): Promise<T> => {
      const started = performance.now();
      try {
        return await work();
      } finally {
        timings[stage] = Math.round(performance.now() - started);
      }
    };

    const metadata = await timed('metadata', () => metadataReader.read(path));
    let audioFileId = store.findAudioFileBySha(metadata.sha256)?.id;
    if (audioFileId) store.updateAudioFilePath(audioFileId, path);
    else audioFileId = store.insertAudioFile(metadata);

    let variant = store.variantForAudioFile(audioFileId);
    if (!variant) {
      const trackId = store.createTrack(metadata.tags.title ?? metadata.filename, metadata.tags.artist);
      const variantId = store.createVariant(trackId, audioFileId, 'reference');
      variant = { id: variantId, trackId, audioFileId, role: 'reference' };
    }

    const speech = await this.speech();
    const versions = { ...COMPONENT_VERSIONS, speech: `${speech.id}@${speech.version}` };
    // The speech engine changes results, so it is part of what makes two analyses identical.
    const hash = createHash('sha256').update(canonicalJson({ params, speech: versions.speech })).digest('hex').slice(0, 16);
    const summary = {
      path,
      audioFileId,
      trackId: variant.trackId,
      variantId: variant.id,
      metadata: {
        filename: metadata.filename,
        format: metadata.format,
        codec: metadata.codec,
        durationSec: metadata.durationSec,
        sampleRate: metadata.sampleRate,
        channels: metadata.channels,
        bitrate: metadata.bitrate,
        title: metadata.tags.title,
        artist: metadata.tags.artist,
        taggedBpm: metadata.tags.bpm,
      },
    };

    const previous = store.latestSucceededRun(variant.id);
    if (!options.force && previous && previous.engineVersion === ENGINE_VERSION && previous.paramsHash === hash) {
      const rhythm = store.loadRhythm(previous.id);
      const markers = store.loadMarkers(previous.id);
      return {
        ...summary,
        runId: previous.id,
        reused: true,
        bpm: rhythm?.bpm ?? 0,
        bpmConfidence: rhythm?.confidence ?? 0,
        beatCount: rhythm?.beats.length ?? 0,
        tempoSegments: rhythm?.tempoSegments.length ?? 0,
        fingerprintHashes: store.loadFingerprint(previous.id)?.hashes.length ?? 0,
        markers: countMarkers(markers),
        speechSegments: store.loadSpeech(previous.id).length,
        timingsMs: timings,
      };
    }

    const runId = store.startRun(variant.id, 'full', ENGINE_VERSION, versions, params, hash);
    const started = performance.now();
    let decoderInfo: DecoderInfo | undefined;
    try {
      const audio = await timed('decode', () => decoder.decode(path, { sampleRate: params.analysisSampleRate }));
      decoderInfo = audio.decoder;
      const features = await timed('features', () => extractFeatures(audio, params.features));
      const fingerprint = await timed('fingerprint', () => extractFingerprint(features.spectrogram, params.fingerprint));
      const rhythm = await timed('rhythm', () => analyzeRhythm(features, params.rhythm));
      const markerSet = await timed('markers', () => generateMarkers(features, fingerprint, rhythm, params.markers));
      const markers = [...markerSet.regular, ...markerSet.significant];
      const speechSegments = await timed('speech', async () =>
        speech.id === 'none' ? [] : speech.transcribe(await decoder.decode(path, { sampleRate: SPEECH_SAMPLE_RATE })),
      );
      await timed('store', () => {
        store.saveResults(runId, variant.id, { fingerprint, rhythm, markers });
        store.saveSpeech(runId, speechSegments);
      });

      store.finishRun(runId, {
        status: 'succeeded',
        durationMs: performance.now() - started,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
        stageTimings: timings,
        decoder: decoderInfo,
      });
      return {
        ...summary,
        runId,
        reused: false,
        bpm: rhythm.bpm,
        bpmConfidence: rhythm.confidence,
        beatCount: rhythm.beats.length,
        tempoSegments: rhythm.tempoSegments.length,
        fingerprintHashes: fingerprint.hashes.length,
        markers: countMarkers(markers),
        speechSegments: speechSegments.length,
        timingsMs: timings,
      };
    } catch (error) {
      store.finishRun(runId, {
        status: 'failed',
        durationMs: performance.now() - started,
        stageTimings: timings,
        ...(decoderInfo ? { decoder: decoderInfo } : {}),
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Interval detection from the latest base analysis of a variant and its audio, decoded again
   * for the timing evidence (beats, cues, volume). Reuses an earlier detection with the same
   * parameters and base analysis; otherwise stores a new run of kind `intervals`.
   */
  async detectIntervals(variantId: string, options: { force?: boolean } = {}): Promise<IntervalReport> {
    const { store } = this.deps;
    const intervalParams = this.deps.intervalParams ?? DEFAULT_INTERVAL_PARAMS;
    const variant = store.variant(variantId);
    const base = store.latestSucceededRun(variantId);
    if (!variant || !base) throw new Error(`Variant ${variantId} has no successful base analysis`);

    const hash = createHash('sha256')
      .update(canonicalJson({ intervalParams, baseRunId: base.id, version: COMPONENT_VERSIONS.intervals }))
      .digest('hex')
      .slice(0, 16);

    const previous = store.latestSucceededRun(variantId, 'intervals');
    if (!options.force && previous && previous.paramsHash === hash) {
      const structure = store.loadWorkout(previous.id);
      if (structure) return { variantId, runId: previous.id, reused: true, candidates: store.loadCandidates(previous.id).length, structure };
    }

    const runId = store.startRun(variantId, 'intervals', ENGINE_VERSION, COMPONENT_VERSIONS, { ...intervalParams, baseRunId: base.id }, hash);
    const started = performance.now();
    try {
      const audio = await this.deps.decoder.decode(variant.path, { sampleRate: EVIDENCE_SAMPLE_RATE });
      const detection = new IntervalDetector(intervalParams.model).detect({
        durationSec: audio.durationSec,
        curves: computeEvidenceCurves(audio),
        speech: intervalParams.useSpeech ? store.loadSpeech(base.id) : [],
      });
      store.saveIntervals(runId, variantId, detection.candidates, detection.structure);
      store.finishRun(runId, { status: 'succeeded', durationMs: performance.now() - started });
      return { variantId, runId, reused: false, candidates: detection.candidates.length, structure: detection.structure };
    } catch (error) {
      store.finishRun(runId, { status: 'failed', durationMs: performance.now() - started, error: (error as Error).message });
      throw error;
    }
  }
}
