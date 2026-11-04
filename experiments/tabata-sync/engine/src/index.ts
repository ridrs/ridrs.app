// SPDX-License-Identifier: AGPL-3.0-or-later

export { type AudioDecoder, type DecodeOptions, FfmpegDecoder } from './decode/decoder.ts';
export { classifyFormat, FfprobeMetadataReader, type MetadataReader } from './decode/metadata.ts';
export { extractFeatures, type FeatureFrames } from './dsp/features.ts';
export { alignFingerprints, type AlignOptions, DEFAULT_ALIGN_OPTIONS, HashTable } from './fingerprint/align.ts';
export { extractFingerprint, LANDMARK_ALGORITHM, LANDMARK_VERSION } from './fingerprint/landmarks.ts';
export { ENGLISH_PHRASES, type PhraseTable, type SpokenCountdown, spokenCountdowns } from './intervals/countdowns.ts';
export { applyCorrections, compareWithCorrected, type CorrectionComparison } from './intervals/corrections.ts';
export { type DetectionContext, type IntervalDetection, IntervalDetector } from './intervals/detector.ts';
export { computeEvidenceCurves, EVIDENCE_SAMPLE_RATE, type EvidenceCurves } from './intervals/evidence.ts';
export { DEFAULT_GRID_OPTIONS, fitRegularWorkout, type GridFit, type GridOptions, INTERVAL_MODEL_VERSION } from './intervals/grid.ts';
export { generateMarkers, type MarkerSet } from './markers/markers.ts';
export { NullSpeechRecognizer, type SpeechRecognizer, WhisperCppRecognizer } from './speech/speech.ts';
export { analyzeRhythm } from './rhythm/rhythm.ts';
export { AnalysisPipeline, type AnalysisReport, type IntervalReport } from './pipeline/pipeline.ts';
export { COMPONENT_VERSIONS, DEFAULT_INTERVAL_PARAMS, DEFAULT_PARAMS, ENGINE_VERSION, paramsHash, resolveParams } from './pipeline/params.ts';
export { AnalysisStore, type TrackSummary } from './store/analysis-store.ts';
export { migrate, openDatabase } from './store/database.ts';
