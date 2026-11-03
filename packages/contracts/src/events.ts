// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
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

export const deviceConnectionChangedEvent = defineEvent(
  'device.connection-changed',
  z.object({
    deviceId: z.string(),
    deviceName: z.string(),
    state: deviceConnectionStateSchema,
    reason: z.string().optional(),
  }),
);

export type DeviceConnectionChangedPayload = z.infer<typeof deviceConnectionChangedEvent.schema>;

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
