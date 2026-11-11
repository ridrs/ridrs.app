// SPDX-License-Identifier: AGPL-3.0-or-later

// The part of the public FIT profile (21.218) that ridrs uses: the messages of activity files it
// writes and of workout files it reads, with message and field numbers, base types, scales and
// enum values. Vitest cross-checks every entry against the
// official SDK's `Profile` (a devDependency of the tests only).

export const FIT_PROFILE_VERSION = { major: 21, minor: 218 } as const;
/** FIT protocol 1.0: ridrs uses no developer fields and no 64-bit types. */
export const FIT_PROTOCOL_VERSION = 0x10;

/** Seconds from the Unix epoch to the FIT epoch, 1989-12-31T00:00:00Z. */
export const FIT_EPOCH_OFFSET_S = 631_065_600;

export interface BaseType {
  readonly name: 'enum' | 'uint8' | 'uint16' | 'uint32' | 'sint32' | 'uint32z' | 'string';
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
  uint32z: { name: 'uint32z', id: 0x8c, size: 4, invalid: 0 },
  /** Size per character; a string field's size is its length in bytes. */
  string: { name: 'string', id: 0x07, size: 1, invalid: 0 },
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

const {
  enum: ENUM,
  uint8: U8,
  uint16: U16,
  uint32: U32,
  sint32: S32,
  uint32z: U32Z,
  string: STRING,
} = BASE_TYPES;

/**
 * Every message ridrs writes, with the fields it writes, in write order, and the workout messages
 * it reads (ADR 0084) with all their profile fields. The decoder names fields from this list.
 */
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
  workout: {
    name: 'workout',
    num: 26,
    fields: [
      { name: 'messageIndex', num: 254, type: U16 },
      { name: 'sport', num: 4, type: ENUM },
      { name: 'capabilities', num: 5, type: U32Z },
      { name: 'numValidSteps', num: 6, type: U16 },
      { name: 'wktName', num: 8, type: STRING },
      { name: 'subSport', num: 11, type: ENUM },
      { name: 'poolLength', num: 14, type: U16, scale: 100 },
      { name: 'poolLengthUnit', num: 15, type: ENUM },
      { name: 'wktDescription', num: 17, type: STRING },
    ],
  },
  /**
   * `durationValue`, `targetValue` and the custom targets mean what `durationType` and
   * `targetType` say (the profile's sub-fields): their scales and offsets are the importer's.
   */
  workoutStep: {
    name: 'workoutStep',
    num: 27,
    fields: [
      { name: 'messageIndex', num: 254, type: U16 },
      { name: 'wktStepName', num: 0, type: STRING },
      { name: 'durationType', num: 1, type: ENUM },
      { name: 'durationValue', num: 2, type: U32 },
      { name: 'targetType', num: 3, type: ENUM },
      { name: 'targetValue', num: 4, type: U32 },
      { name: 'customTargetValueLow', num: 5, type: U32 },
      { name: 'customTargetValueHigh', num: 6, type: U32 },
      { name: 'intensity', num: 7, type: ENUM },
      { name: 'notes', num: 8, type: STRING },
      { name: 'equipment', num: 9, type: ENUM },
      { name: 'exerciseCategory', num: 10, type: U16 },
      { name: 'exerciseName', num: 11, type: U16 },
      { name: 'exerciseWeight', num: 12, type: U16, scale: 100 },
      { name: 'weightDisplayUnit', num: 13, type: U16 },
      { name: 'secondaryTargetType', num: 19, type: ENUM },
      { name: 'secondaryTargetValue', num: 20, type: U32 },
      { name: 'secondaryCustomTargetValueLow', num: 21, type: U32 },
      { name: 'secondaryCustomTargetValueHigh', num: 22, type: U32 },
    ],
  },
} as const satisfies Record<string, MessageDefinition>;

export type MessageName = keyof typeof MESSAGES;

/** Enum values, by the profile's type and value names. */
export const ENUMS = {
  file: { activity: 4, workout: 5 },
  manufacturer: { development: 255 },
  event: { timer: 0, session: 8, lap: 9, activity: 26 },
  eventType: { start: 0, stop: 1, stopAll: 4 },
  sport: { cycling: 2 },
  /** The sub sports of cycling, and `generic`. */
  subSport: {
    generic: 0,
    spin: 5,
    indoorCycling: 6,
    road: 7,
    mountain: 8,
    downhill: 9,
    recumbent: 10,
    cyclocross: 11,
    handCycling: 12,
    trackCycling: 13,
    eBikeFitness: 28,
    bmx: 29,
    gravelCycling: 46,
    eBikeMountain: 47,
    commuting: 48,
    mixedSurface: 49,
    virtualActivity: 58,
    indoorHandCycling: 88,
  },
  lapTrigger: { sessionEnd: 7 },
  sessionTrigger: { activityEnd: 0 },
  activity: { manual: 0 },
  wktStepDuration: {
    time: 0,
    distance: 1,
    hrLessThan: 2,
    hrGreaterThan: 3,
    calories: 4,
    open: 5,
    repeatUntilStepsCmplt: 6,
    repeatUntilTime: 7,
    repeatUntilDistance: 8,
    repeatUntilCalories: 9,
    repeatUntilHrLessThan: 10,
    repeatUntilHrGreaterThan: 11,
    repeatUntilPowerLessThan: 12,
    repeatUntilPowerGreaterThan: 13,
    powerLessThan: 14,
    powerGreaterThan: 15,
    trainingPeaksTss: 16,
    repeatUntilPowerLastLapLessThan: 17,
    repeatUntilMaxPowerLastLapLessThan: 18,
    power3sLessThan: 19,
    power10sLessThan: 20,
    power30sLessThan: 21,
    power3sGreaterThan: 22,
    power10sGreaterThan: 23,
    power30sGreaterThan: 24,
    powerLapLessThan: 25,
    powerLapGreaterThan: 26,
    repeatUntilTrainingPeaksTss: 27,
    repetitionTime: 28,
    reps: 29,
    timeOnly: 31,
  },
  wktStepTarget: {
    speed: 0,
    heartRate: 1,
    open: 2,
    cadence: 3,
    power: 4,
    grade: 5,
    resistance: 6,
    power3s: 7,
    power10s: 8,
    power30s: 9,
    powerLap: 10,
    swimStroke: 11,
    speedLap: 12,
    heartRateLap: 13,
  },
  intensity: { active: 0, rest: 1, warmup: 2, cooldown: 3, recovery: 4, interval: 5, other: 6 },
  /** Workout power values above it are watts + 1000; up to it, % FTP. */
  workoutPower: { wattsOffset: 1000 },
  /** Workout heart rate values above it are bpm + 100; up to it, % of the maximum. */
  workoutHr: { bpmOffset: 100 },
} as const;
