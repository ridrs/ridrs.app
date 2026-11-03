// SPDX-License-Identifier: AGPL-3.0-or-later

// FIT activity export with ridrs' own encoder, written from the public FIT protocol
// documentation (ADR 0034). Runtime-neutral and DOM-free: imports @ridrs/contracts only.
export {
  type ActivityModel,
  type ActivityRecord,
  type ActivitySource,
  type ActivitySummary,
  buildActivity,
  FIT_DEFAULTS,
} from './activity.ts';
export { fitCrc } from './crc.ts';
export { encodeActivity, fitTimestamp } from './encoder.ts';
export {
  BASE_TYPES,
  type BaseType,
  ENUMS,
  FIT_EPOCH_OFFSET_S,
  FIT_PROFILE_VERSION,
  type FieldDefinition,
  MESSAGES,
  type MessageDefinition,
} from './profile.ts';
