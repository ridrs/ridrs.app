// SPDX-License-Identifier: AGPL-3.0-or-later

// ridrs recording v1 (docs/formats/ridrs-recording-v1.md): file names, the writer, the reader,
// recovery of open recordings and gzip. Runtime-neutral: contracts and Web streams only.
export { gunzip, gzip, isGzip } from './compression.ts';
export {
  FIT_EXTENSION,
  fileNameOf,
  fitPathFor,
  OPEN_RECORDING_EXTENSION,
  openRecordingPath,
  RECORDING_EXTENSION,
  RECORDINGS_DIRECTORY,
  recordingName,
  recordingPath,
} from './files.ts';
export {
  lastRecordTime,
  parseRecording,
  type ReadRecordingOptions,
  type Recording,
  readRecording,
} from './reader.ts';
export { type RecoveredRecording, recoverRecording } from './recovery.ts';
export { buildConfigSnapshot } from './snapshot.ts';
export { RecordingWriter, type SerializedEnvelope, serializeEnvelope } from './writer.ts';
