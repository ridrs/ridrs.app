// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ActivityModel, ActivityRecord } from './activity.ts';
import { fitCrc } from './crc.ts';
import {
  ENUMS,
  FIT_EPOCH_OFFSET_S,
  FIT_PROFILE_VERSION,
  FIT_PROTOCOL_VERSION,
  type FieldDefinition,
  MESSAGES,
  type MessageDefinition,
} from './profile.ts';

const HEADER_SIZE = 14;
const DEFINITION_FLAG = 0x40;

type FieldValues = Readonly<Record<string, number | undefined>>;

/** FIT `date_time`: seconds since the FIT epoch. */
export function fitTimestamp(epochMs: number): number {
  return Math.floor(epochMs / 1000) - FIT_EPOCH_OFFSET_S;
}

/** "1.2.3" -> 102: `software_version` has scale 100. */
function softwareVersion(version: string): number | undefined {
  const [major, minor] = version.split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    return undefined;
  }
  return (major ?? 0) * 100 + (minor ?? 0);
}

/** Little-endian bytes, growing as needed. */
class Output {
  private bytes = new Uint8Array(1024);
  length = 0;

  private reserve(size: number): DataView {
    if (this.length + size > this.bytes.length) {
      const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.length + size));
      grown.set(this.bytes);
      this.bytes = grown;
    }
    const view = new DataView(this.bytes.buffer, this.length, size);
    this.length += size;
    return view;
  }

  u8(value: number): void {
    this.reserve(1).setUint8(0, value);
  }

  u16(value: number): void {
    this.reserve(2).setUint16(0, value, true);
  }

  u32(value: number): void {
    this.reserve(4).setUint32(0, value, true);
  }

  s32(value: number): void {
    this.reserve(4).setInt32(0, value, true);
  }

  result(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

/** Writes definition messages on first use of a local type and data messages after them. */
class MessageWriter {
  private readonly localTypes = new Map<string, number>();

  constructor(private readonly out: Output) {}

  write(message: MessageDefinition, values: FieldValues): void {
    const fields: readonly FieldDefinition[] = message.fields;
    let local = this.localTypes.get(message.name);
    if (local === undefined) {
      local = this.localTypes.size;
      this.localTypes.set(message.name, local);
      this.out.u8(DEFINITION_FLAG | local);
      this.out.u8(0); // reserved
      this.out.u8(0); // architecture: little-endian
      this.out.u16(message.num);
      this.out.u8(fields.length);
      for (const field of fields) {
        this.out.u8(field.num);
        this.out.u8(field.type.size);
        this.out.u8(field.type.id);
      }
    }
    this.out.u8(local);
    for (const field of fields) {
      const value = values[field.name];
      const scaled =
        value === undefined || !Number.isFinite(value)
          ? field.type.invalid
          : Math.round((value + (field.offset ?? 0)) * (field.scale ?? 1));
      const signed = field.type.name === 'sint32';
      // Out of range is not representable: invalid, never wrapped or clamped into a wrong value.
      const lowest = signed ? -field.type.invalid : 0;
      const raw = scaled >= lowest && scaled < field.type.invalid ? scaled : field.type.invalid;
      if (signed) {
        this.out.s32(raw);
      } else if (field.type.size === 1) {
        this.out.u8(raw);
      } else if (field.type.size === 2) {
        this.out.u16(raw);
      } else {
        this.out.u32(raw);
      }
    }
  }
}

/** FIT positions: 2³¹ semicircles are 180°. */
const semicircles = (degrees: number | undefined) =>
  degrees === undefined ? undefined : (degrees * 2 ** 31) / 180;

function recordValues(record: ActivityRecord): FieldValues {
  return {
    timestamp: fitTimestamp(record.at),
    positionLat: semicircles(record.latitude),
    positionLong: semicircles(record.longitude),
    altitude: record.altitude,
    enhancedAltitude: record.altitude,
    heartRate: record.heartRate,
    cadence: record.cadence,
    distance: record.distance,
    speed: record.speed,
    power: record.power,
    enhancedSpeed: record.speed,
  };
}

/**
 * Encodes an activity as a FIT file: 14-byte header with header CRC, one definition per local
 * message type before its first data message, the file CRC at the end. No compressed timestamps,
 * no developer fields. Pure: the same model always gives the same bytes.
 */
export function encodeActivity(model: ActivityModel): Uint8Array {
  const out = new Output();
  for (let i = 0; i < HEADER_SIZE; i += 1) {
    out.u8(0);
  }
  const messages = new MessageWriter(out);
  const start = fitTimestamp(model.startedAt);
  const end = fitTimestamp(model.endedAt);
  const s = model.summary;
  const totals = {
    totalElapsedTime: s.totalElapsedMs / 1000,
    totalTimerTime: s.totalTimerMs / 1000,
    totalDistance: s.totalDistance,
    avgSpeed: s.avgSpeed,
    maxSpeed: s.maxSpeed,
    avgHeartRate: s.avgHeartRate,
    maxHeartRate: s.maxHeartRate,
    avgCadence: s.avgCadence,
    maxCadence: s.maxCadence,
    avgPower: s.avgPower,
    maxPower: s.maxPower,
    sport: ENUMS.sport.cycling,
    subSport: ENUMS.subSport.virtualActivity,
  };

  messages.write(MESSAGES.fileId, {
    type: ENUMS.file.activity,
    manufacturer: ENUMS.manufacturer.development,
    product: 0,
    timeCreated: end,
  });
  messages.write(MESSAGES.fileCreator, { softwareVersion: softwareVersion(model.softwareVersion) });
  messages.write(MESSAGES.event, {
    timestamp: start,
    event: ENUMS.event.timer,
    eventType: ENUMS.eventType.start,
  });
  // Records and the timer's stops and starts of the pauses, in time order.
  const pauses = [...model.pauses];
  const timer = (at: number, eventType: number) =>
    messages.write(MESSAGES.event, {
      timestamp: fitTimestamp(at),
      event: ENUMS.event.timer,
      eventType,
    });
  for (const record of model.records) {
    while (pauses[0] && pauses[0].from < record.at) {
      const pause = pauses.shift() as (typeof pauses)[number];
      timer(pause.from, ENUMS.eventType.stop);
      if (pause.to < model.endedAt) {
        timer(pause.to, ENUMS.eventType.start);
      }
    }
    messages.write(MESSAGES.record, recordValues(record));
  }
  for (const pause of pauses) {
    timer(pause.from, ENUMS.eventType.stop);
    if (pause.to < model.endedAt) {
      timer(pause.to, ENUMS.eventType.start);
    }
  }
  messages.write(MESSAGES.event, {
    timestamp: end,
    event: ENUMS.event.timer,
    eventType: ENUMS.eventType.stopAll,
  });
  messages.write(MESSAGES.lap, {
    messageIndex: 0,
    timestamp: end,
    event: ENUMS.event.lap,
    eventType: ENUMS.eventType.stop,
    startTime: start,
    lapTrigger: ENUMS.lapTrigger.sessionEnd,
    enhancedAvgSpeed: s.avgSpeed,
    enhancedMaxSpeed: s.maxSpeed,
    ...totals,
  });
  messages.write(MESSAGES.session, {
    messageIndex: 0,
    timestamp: end,
    event: ENUMS.event.session,
    eventType: ENUMS.eventType.stop,
    startTime: start,
    firstLapIndex: 0,
    numLaps: 1,
    trigger: ENUMS.sessionTrigger.activityEnd,
    enhancedAvgSpeed: s.avgSpeed,
    enhancedMaxSpeed: s.maxSpeed,
    ...totals,
  });
  messages.write(MESSAGES.activity, {
    timestamp: end,
    totalTimerTime: s.totalTimerMs / 1000,
    numSessions: 1,
    type: ENUMS.activity.manual,
    event: ENUMS.event.activity,
    eventType: ENUMS.eventType.stop,
    localTimestamp: end + model.timeZoneOffsetMinutes * 60,
  });

  const dataSize = out.length - HEADER_SIZE;
  out.u16(0); // file CRC, written below
  const bytes = out.result();
  const view = new DataView(bytes.buffer);
  view.setUint8(0, HEADER_SIZE);
  view.setUint8(1, FIT_PROTOCOL_VERSION);
  view.setUint16(2, FIT_PROFILE_VERSION.major * 1000 + FIT_PROFILE_VERSION.minor, true);
  view.setUint32(4, dataSize, true);
  bytes.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  view.setUint16(12, fitCrc(bytes, 0, 12), true);
  view.setUint16(bytes.length - 2, fitCrc(bytes, 0, bytes.length - 2), true);
  return bytes;
}
