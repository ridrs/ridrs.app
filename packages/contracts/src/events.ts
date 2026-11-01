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
  readonly id: string;
  readonly type: TType;
  readonly payload: TPayload;
  readonly source: string;
  readonly timestamp: number;
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
