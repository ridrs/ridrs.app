// SPDX-License-Identifier: AGPL-3.0-or-later

export {
  type CompareOptions,
  type Comparison,
  compare,
  type Difference,
  type StreamComparison,
  type UncomparedStream,
} from './compare.ts';
// Deterministic, headless replay of ridrs recordings (docs/architecture/recording-and-replay.md).
// Headless: it composes a host on a replay clock, or one that continues an interrupted ride
// (ADR 0057). No plugin may import it.
export {
  type ContinueRecordingOptions,
  continueRecording,
  RECOVERY_SOURCE,
} from './continue.ts';
export {
  type ConfigurationDifferences,
  REPLAY_CENTRAL_PLUGIN,
  type ReplayOptions,
  type ReplayResult,
  replay,
  type SectionDifference,
} from './replay.ts';
