// SPDX-License-Identifier: AGPL-3.0-or-later

// FIT activity export with ridrs' own encoder and FIT reading with its own decoder, both written
// from the public FIT protocol documentation (ADR 0034, 0084). Runtime-neutral and DOM-free:
// imports @ridrs/contracts only.
export {
  type ActivityModel,
  type ActivityRecord,
  type ActivitySource,
  type ActivitySummary,
  buildActivity,
  FIT_DEFAULTS,
} from './activity.ts';
export { fitCrc } from './crc.ts';
export {
  type DecodedFitDeveloperField,
  type DecodedFitField,
  type DecodedFitMessage,
  decodeFit,
  type FitBaseTypeName,
  type FitDecodeResult,
  type FitDiagnostic,
  type FitHeader,
  type FitScalar,
  type FitValue,
  fitField,
} from './decoder.ts';
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
  type MessageName,
} from './profile.ts';
