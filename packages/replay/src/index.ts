// SPDX-License-Identifier: AGPL-3.0-or-later

// Deterministic, headless replay of ridrs recordings (docs/architecture/recording-and-replay.md).
// Headless: it composes a host on a replay clock. No plugin may import it.
export {
  type CompareOptions,
  type Comparison,
  compare,
  type Difference,
  type StreamComparison,
} from './compare.ts';
export {
  type ConfigurationDifferences,
  REPLAY_CENTRAL_PLUGIN,
  type ReplayOptions,
  type ReplayResult,
  replay,
  type SectionDifference,
} from './replay.ts';
