// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AnalysisParams, FingerprintData } from '@tabata-sync/contracts';
import { FfmpegDecoder } from '../../src/decode/decoder.ts';
import { extractFeatures, type FeatureFrames } from '../../src/dsp/features.ts';
import { extractFingerprint } from '../../src/fingerprint/landmarks.ts';
import { DEFAULT_PARAMS } from '../../src/pipeline/params.ts';

const decoder = new FfmpegDecoder();

export interface FileAnalysis {
  readonly features: FeatureFrames;
  readonly fingerprint: FingerprintData;
}

/** Decode + features + fingerprint of one file, without persistence. */
export async function fingerprintFile(path: string, params: AnalysisParams = DEFAULT_PARAMS): Promise<FileAnalysis> {
  const audio = await decoder.decode(path, { sampleRate: params.analysisSampleRate });
  const features = extractFeatures(audio, params.features);
  return { features, fingerprint: extractFingerprint(features.spectrogram, params.fingerprint) };
}
