// SPDX-License-Identifier: AGPL-3.0-or-later

// The part of the public FIT profile (21.218) that ridrs activity files use: message and field
// numbers, base types, scales and enum values. Vitest cross-checks every entry against the
// official SDK's `Profile` (a devDependency of the tests only).

export const FIT_PROFILE_VERSION = { major: 21, minor: 218 } as const;
/** FIT protocol 1.0: ridrs uses no developer fields and no 64-bit types. */
export const FIT_PROTOCOL_VERSION = 0x10;

/** Seconds from the Unix epoch to the FIT epoch, 1989-12-31T00:00:00Z. */
export const FIT_EPOCH_OFFSET_S = 631_065_600;

export interface BaseType {
  readonly name: 'enum' | 'uint8' | 'uint16' | 'uint32' | 'sint32';
  /** The base type byte of a field definition. */
  readonly id: number;
  readonly size: number;
  readonly invalid: number;
}

export const BASE_TYPES = {
  enum: { name: 'enum', id: 0x00, size: 1, invalid: 0xff },
  uint8: { name: 'uint8', id: 0x02, size: 1, invalid: 0xff },
  uint16: { name: 'uint16', id: 0x84, size: 2, invalid: 0xffff },
  uint32: { name: 'uint32', id: 0x86, size: 4, invalid: 0xffff_ffff },
  sint32: { name: 'sint32', id: 0x85, size: 4, invalid: 0x7fff_ffff },
} as const satisfies Record<string, BaseType>;

export interface FieldDefinition {
  /** The profile's name, for messages and the SDK cross-check. */
  readonly name: string;
  readonly num: number;
  readonly type: BaseType;
  /** Stored value = round((value + offset) · scale); 1 when absent. */
  readonly scale?: number;
  /** 0 when absent. */
  readonly offset?: number;
}

export interface MessageDefinition {
  readonly name: string;
  readonly num: number;
  readonly fields: readonly FieldDefinition[];
}

const { enum: ENUM, uint8: U8, uint16: U16, uint32: U32, sint32: S32 } = BASE_TYPES;

/** Every message ridrs writes, with the fields it writes, in write order. */
export const MESSAGES = {
  fileId: {
    name: 'fileId',
    num: 0,
    fields: [
      { name: 'type', num: 0, type: ENUM },
      { name: 'manufacturer', num: 1, type: U16 },
      { name: 'product', num: 2, type: U16 },
      { name: 'timeCreated', num: 4, type: U32 },
    ],
  },
  fileCreator: {
    name: 'fileCreator',
    num: 49,
    fields: [{ name: 'softwareVersion', num: 0, type: U16 }],
  },
  event: {
    name: 'event',
    num: 21,
    fields: [
      { name: 'timestamp', num: 253, type: U32 },
      { name: 'event', num: 0, type: ENUM },
      { name: 'eventType', num: 1, type: ENUM },
    ],
  },
  record: {
    name: 'record',
    num: 20,
    fields: [
      { name: 'timestamp', num: 253, type: U32 },
      { name: 'positionLat', num: 0, type: S32 },
      { name: 'positionLong', num: 1, type: S32 },
      { name: 'altitude', num: 2, type: U16, scale: 5, offset: 500 },
      { name: 'heartRate', num: 3, type: U8 },
      { name: 'cadence', num: 4, type: U8 },
      { name: 'distance', num: 5, type: U32, scale: 100 },
      { name: 'speed', num: 6, type: U16, scale: 1000 },
      { name: 'power', num: 7, type: U16 },
      { name: 'enhancedSpeed', num: 73, type: U32, scale: 1000 },
      { name: 'enhancedAltitude', num: 78, type: U32, scale: 5, offset: 500 },
    ],
  },
  lap: {
    name: 'lap',
    num: 19,
    fields: [
      { name: 'messageIndex', num: 254, type: U16 },
      { name: 'timestamp', num: 253, type: U32 },
      { name: 'event', num: 0, type: ENUM },
      { name: 'eventType', num: 1, type: ENUM },
      { name: 'startTime', num: 2, type: U32 },
      { name: 'totalElapsedTime', num: 7, type: U32, scale: 1000 },
      { name: 'totalTimerTime', num: 8, type: U32, scale: 1000 },
      { name: 'totalDistance', num: 9, type: U32, scale: 100 },
      { name: 'avgSpeed', num: 13, type: U16, scale: 1000 },
      { name: 'maxSpeed', num: 14, type: U16, scale: 1000 },
      { name: 'avgHeartRate', num: 15, type: U8 },
      { name: 'maxHeartRate', num: 16, type: U8 },
      { name: 'avgCadence', num: 17, type: U8 },
      { name: 'maxCadence', num: 18, type: U8 },
      { name: 'avgPower', num: 19, type: U16 },
      { name: 'maxPower', num: 20, type: U16 },
      { name: 'lapTrigger', num: 24, type: ENUM },
      { name: 'sport', num: 25, type: ENUM },
      { name: 'subSport', num: 39, type: ENUM },
      { name: 'enhancedAvgSpeed', num: 110, type: U32, scale: 1000 },
      { name: 'enhancedMaxSpeed', num: 111, type: U32, scale: 1000 },
    ],
  },
  session: {
    name: 'session',
    num: 18,
    fields: [
      { name: 'messageIndex', num: 254, type: U16 },
      { name: 'timestamp', num: 253, type: U32 },
      { name: 'event', num: 0, type: ENUM },
      { name: 'eventType', num: 1, type: ENUM },
      { name: 'startTime', num: 2, type: U32 },
      { name: 'sport', num: 5, type: ENUM },
      { name: 'subSport', num: 6, type: ENUM },
      { name: 'totalElapsedTime', num: 7, type: U32, scale: 1000 },
      { name: 'totalTimerTime', num: 8, type: U32, scale: 1000 },
      { name: 'totalDistance', num: 9, type: U32, scale: 100 },
      { name: 'avgSpeed', num: 14, type: U16, scale: 1000 },
      { name: 'maxSpeed', num: 15, type: U16, scale: 1000 },
      { name: 'avgHeartRate', num: 16, type: U8 },
      { name: 'maxHeartRate', num: 17, type: U8 },
      { name: 'avgCadence', num: 18, type: U8 },
      { name: 'maxCadence', num: 19, type: U8 },
      { name: 'avgPower', num: 20, type: U16 },
      { name: 'maxPower', num: 21, type: U16 },
      { name: 'firstLapIndex', num: 25, type: U16 },
      { name: 'numLaps', num: 26, type: U16 },
      { name: 'trigger', num: 28, type: ENUM },
      { name: 'enhancedAvgSpeed', num: 124, type: U32, scale: 1000 },
      { name: 'enhancedMaxSpeed', num: 125, type: U32, scale: 1000 },
    ],
  },
  activity: {
    name: 'activity',
    num: 34,
    fields: [
      { name: 'timestamp', num: 253, type: U32 },
      { name: 'totalTimerTime', num: 0, type: U32, scale: 1000 },
      { name: 'numSessions', num: 1, type: U16 },
      { name: 'type', num: 2, type: ENUM },
      { name: 'event', num: 3, type: ENUM },
      { name: 'eventType', num: 4, type: ENUM },
      { name: 'localTimestamp', num: 5, type: U32 },
    ],
  },
} as const satisfies Record<string, MessageDefinition>;

export type MessageName = keyof typeof MESSAGES;

/** Enum values, by the profile's type and value names. */
export const ENUMS = {
  file: { activity: 4 },
  manufacturer: { development: 255 },
  event: { timer: 0, session: 8, lap: 9, activity: 26 },
  eventType: { start: 0, stop: 1, stopAll: 4 },
  sport: { cycling: 2 },
  subSport: { virtualActivity: 58 },
  lapTrigger: { sessionEnd: 7 },
  sessionTrigger: { activityEnd: 0 },
  activity: { manual: 0 },
} as const;
