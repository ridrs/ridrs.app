// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { eventIdSchema } from './manifest.ts';

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
