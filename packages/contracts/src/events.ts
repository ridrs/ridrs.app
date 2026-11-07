// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { bleRouteSchema } from './ble.ts';
import { eventIdSchema } from './manifest-ids.ts';

export interface EventDefinition<TPayload = unknown, TType extends string = string> {
  readonly id: TType;
  readonly schema: z.ZodType<TPayload>;
}

export function defineEvent<TPayload, TType extends string>(
  id: TType,
  schema: z.ZodType<TPayload>,
): EventDefinition<TPayload, TType> {
  const parsedId = eventIdSchema.parse(id);
  return Object.freeze({
    id: parsedId as TType,
    schema,
  });
}

export interface EventEnvelope<TPayload = unknown, TType extends string = string> {
  /** Unique within the host run and reproducible on replay (see `PluginIdsContext`). */
  readonly id: string;
  readonly type: TType;
  readonly payload: TPayload;
  readonly source: string;
  /** Logical time of the turn that published it, epoch ms. */
  readonly timestamp: number;
  /** Global publish order of the host run, from 1. */
  readonly seq: number;
  /** Set on external inputs: they entered through the input queue (`ctx.inputs.accept`). */
  readonly input?: true;
  /** When the host received an input; equals `timestamp` live and is kept on replay. */
  readonly receivedAt?: number;
}

export type EventHandler<TPayload = unknown, TType extends string = string> = (
  envelope: EventEnvelope<TPayload, TType>,
) => void;

export interface EventSubscription {
  unsubscribe(): void;
}

export interface PluginEventsContext {
  publish<TPayload, TType extends string>(
    event: EventDefinition<TPayload, TType>,
    payload: TPayload,
  ): void;
  subscribe<TPayload, TType extends string>(
    event: EventDefinition<TPayload, TType>,
    handler: EventHandler<TPayload, TType>,
  ): EventSubscription;
}

/**
 * External inputs: device data, connection results, rider input, results of asynchronous work.
 * `accept` validates at once (throwing like `publish`) and queues the event; it is published in a
 * turn of its own, after the scheduled tasks due by then. Works inside and outside turns.
 */
export interface PluginInputsContext {
  accept<TPayload, TType extends string>(
    event: EventDefinition<TPayload, TType>,
    payload: TPayload,
  ): void;
}

/** Ids that are unique within the host run and the same on replay: no randomness of their own. */
export interface PluginIdsContext {
  next(): string;
}

export const hostStartedEvent = defineEvent(
  'core.host.started',
  z.object({
    startedPlugins: z.array(z.string()),
  }),
);

export type HostStartedPayload = z.infer<typeof hostStartedEvent.schema>;

export const deviceConnectionStateSchema = z.enum([
  'searching',
  'connecting',
  'connected',
  'reconnecting',
  'disconnected',
]);

export type DeviceConnectionState = z.infer<typeof deviceConnectionStateSchema>;

/** What a device is for. The rider sees one status per kind. */
export const deviceKindSchema = z.enum(['trainer', 'heart-rate', 'controller']);

export type DeviceKind = z.infer<typeof deviceKindSchema>;

export const deviceConnectionChangedEvent = defineEvent(
  'device.connection-changed',
  z.object({
    deviceId: z.string(),
    deviceName: z.string(),
    /** Absent in early recordings and from devices that do not say. */
    kind: deviceKindSchema.optional(),
    state: deviceConnectionStateSchema,
    reason: z.string().optional(),
    /** The link that carries the device (or did last); absent in early recordings. */
    route: bleRouteSchema.optional(),
    /**
     * With `connected`: the device plugin's optional characteristics this connection subscribed
     * to, e.g. a control point that not every device has. Absent when the plugin has none.
     */
    characteristics: z.array(z.string().min(1)).optional(),
  }),
);

export type DeviceConnectionChangedPayload = z.infer<typeof deviceConnectionChangedEvent.schema>;

/** A device of one kind that a device plugin found, and the links that see it. */
export const deviceCandidateSchema = z.object({
  deviceId: z.string().min(1),
  deviceName: z.string(),
  routes: z.array(bleRouteSchema),
  /**
   * Its signal strength in dBm when its link last reported it: the nearest device has the
   * strongest. Absent when the link reported none.
   */
  rssi: z.number().int().optional(),
  /**
   * The id of the device found over the other link that is this device: same name, and no
   * advertising data that tells them apart. Absent when there is none, or in early recordings.
   */
  sameDeviceAs: z.string().min(1).optional(),
});

export type DeviceCandidate = z.infer<typeof deviceCandidateSchema>;

/** A battery level in percent, 0 to 100. */
const batteryLevelSchema = z.number().int().min(0).max(100);

export const deviceStatusSchema = z.object({
  kind: deviceKindSchema,
  /** Empty while searching: no device is known yet. */
  deviceId: z.string(),
  deviceName: z.string(),
  state: deviceConnectionStateSchema,
  /** The link that carries the device, once one did. */
  route: bleRouteSchema.optional(),
  /** While no device is known: the device of the kind connected last in this run, if any. */
  lastDeviceName: z.string().optional(),
  /** Every device of the kind found in this run; absent in early recordings. */
  candidates: z.array(deviceCandidateSchema).optional(),
  /** The links over which device plugins look for devices of the kind now; absent in early recordings. */
  scanning: z.array(bleRouteSchema).optional(),
  /** The battery level of the device, in percent, once it told it; absent for one that does not. */
  battery: batteryLevelSchema.optional(),
});

export type DeviceStatus = z.infer<typeof deviceStatusSchema>;

/**
 * Buttons of a handlebar controller pair: the d-pad on the left, A/B/Y/Z on the right, and on
 * either side a shift-up, shift-down, power-up and on/off button.
 */
export const controllerButtonSchema = z.enum([
  'left',
  'up',
  'right',
  'down',
  'a',
  'b',
  'y',
  'z',
  'shift-up-left',
  'shift-down-left',
  'power-up-left',
  'on-off-left',
  'shift-up-right',
  'shift-down-right',
  'power-up-right',
  'on-off-right',
]);

export type ControllerButton = z.infer<typeof controllerButtonSchema>;

/** The buttons held down on a controller, published whenever that set changes; empty: none. */
export const controllerButtonsChangedEvent = defineEvent(
  'controller.buttons-changed',
  z.object({
    deviceId: z.string().min(1),
    buttons: z.array(controllerButtonSchema),
  }),
);

export type ControllerButtonsChangedPayload = z.infer<typeof controllerButtonsChangedEvent.schema>;

export const timestampOriginSchema = z.enum(['device', 'receive']);

export type TimestampOrigin = z.infer<typeof timestampOriginSchema>;

export const measurementPayloadSchema = z.object({
  deviceId: z.string().min(1),
  value: z.number(),
  measuredAt: z.number(),
  receivedAt: z.number(),
  timestampOrigin: timestampOriginSchema,
});

export type MeasurementPayload = z.infer<typeof measurementPayloadSchema>;

export const measurementPowerEvent = defineEvent('measurement.power', measurementPayloadSchema);

export const measurementCadenceEvent = defineEvent('measurement.cadence', measurementPayloadSchema);

export const measurementHeartRateEvent = defineEvent(
  'measurement.heart-rate',
  measurementPayloadSchema,
);

/**
 * One BLE notification exactly as it arrived, published by the device plugin whose link received
 * it, before decoding. Malformed packets are published too: the bytes are the root of every
 * derived value, so a replay can feed them through the current decoders.
 */
export const deviceRawNotificationEvent = defineEvent(
  'device.raw-notification',
  z.object({
    deviceId: z.string(),
    deviceName: z.string(),
    serviceUuid: z.string().min(1),
    characteristicUuid: z.string().min(1),
    /** Lowercase hex, see `bytesToHex`. */
    data: z.string().regex(/^(?:[0-9a-f]{2})*$/),
    receivedAt: z.number(),
  }),
);

export type DeviceRawNotificationPayload = z.infer<typeof deviceRawNotificationEvent.schema>;

const hexSchema = z.string().regex(/^(?:[0-9a-f]{2})*$/);

/**
 * The value a device plugin's link read from a characteristic on connecting, or why it could not.
 * An input like a notification: a replay feeds it to the current decoders.
 */
export const deviceRawReadEvent = defineEvent(
  'device.raw-read',
  z.object({
    deviceId: z.string(),
    deviceName: z.string(),
    serviceUuid: z.string().min(1),
    characteristicUuid: z.string().min(1),
    /** Lowercase hex; absent when the read failed. */
    data: hexSchema.optional(),
    /** Why the read failed. */
    error: z.string().optional(),
    receivedAt: z.number(),
  }),
);

export type DeviceRawReadPayload = z.infer<typeof deviceRawReadEvent.schema>;

/**
 * One BLE write exactly as a device plugin's link is about to send it, published in the turn that
 * decided it, before the write. Derived: a replay compares it.
 */
export const deviceRawWriteEvent = defineEvent(
  'device.raw-write',
  z.object({
    deviceId: z.string(),
    deviceName: z.string(),
    serviceUuid: z.string().min(1),
    characteristicUuid: z.string().min(1),
    data: hexSchema,
    withResponse: z.boolean(),
    writtenAt: z.number(),
  }),
);

export type DeviceRawWritePayload = z.infer<typeof deviceRawWriteEvent.schema>;

/** A write the device refused or that never reached it: the result of BLE I/O, so an input. */
export const deviceRawWriteFailedEvent = defineEvent(
  'device.raw-write-failed',
  z.object({
    deviceId: z.string(),
    deviceName: z.string(),
    serviceUuid: z.string().min(1),
    characteristicUuid: z.string().min(1),
    data: hexSchema,
    reason: z.string(),
  }),
);

export type DeviceRawWriteFailedPayload = z.infer<typeof deviceRawWriteFailedEvent.schema>;
