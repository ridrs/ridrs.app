// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineState, type StateDefinition } from './app-state.ts';
import { defineService, type ServiceDefinition } from './services.ts';

/**
 * Data sources (ADR 0075): a data type has one source of truth, chosen from every provider that
 * offers it. Nothing is copied or merged between stores, and switching the source copies nothing.
 */

/** A provider's id, the key of its entry in a data type's topic: `ridrs`, `intervals.icu`. */
export const providerIdSchema = z.string().regex(/^[a-z0-9]+([.-][a-z0-9]+)*$/);

export type ProviderId = z.infer<typeof providerIdSchema>;

/** The provider that is always there and the default of every choice. */
export const DEFAULT_PROVIDER: ProviderId = 'ridrs';

/**
 * Whether a provider's data can be read now: `ready`, `offline` (a cache), `unavailable` (not
 * connected, nothing to read) or `loading`.
 */
export const DATA_SOURCE_STATUSES = ['ready', 'offline', 'unavailable', 'loading'] as const;

export const dataSourceStatusSchema = z.enum(DATA_SOURCE_STATUSES);

export type DataSourceStatus = z.infer<typeof dataSourceStatusSchema>;

/** What a provider says about a data type: the status, and the data when it has any. */
export interface DataSource<D> {
  readonly provider: ProviderId;
  /** Shown on the settings page. */
  readonly label: string;
  readonly status: DataSourceStatus;
  /** False for a read-only provider, or one whose token lacks the scope. */
  readonly writable: boolean;
  /** When the provider last loaded the data, epoch ms. */
  readonly fetchedAt?: number;
  readonly data?: D;
}

/** Why a provider did not write: it cannot, or it could not reach its service. */
export const DATA_WRITE_REFUSALS = ['read-only', 'unreachable'] as const;

export const dataWriteResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(DATA_WRITE_REFUSALS) }).strict(),
]);

/** A write is refused, never queued: the caller keeps the old value and says why. */
export type DataWriteResult = z.infer<typeof dataWriteResultSchema>;

type WriteRequest<W extends z.ZodObject> = z.infer<W> & { readonly key: string };

/** A data type: the topic of its providers and one keyed service per write. */
export interface DataType<D, W extends Record<string, z.ZodObject>> {
  readonly id: string;
  /** Keyed by the provider id: its keys are the providers that offer the type. */
  readonly topic: StateDefinition<DataSource<D>>;
  /** `<id>.<name>`, keyed by the topic: the host routes a write to the owner of `request.key`. */
  readonly writes: {
    readonly [K in keyof W]: ServiceDefinition<WriteRequest<W[K]>, DataWriteResult>;
  };
}

/**
 * Defines a data type the same way for every provider: the topic `<id>` keyed by provider, and
 * one service `<id>.<name>` per entry of `writes` (an object schema of the change, without the
 * `key`). A provider offers the type by owning its key; one that cannot write answers
 * `{ ok: false, reason: 'read-only' }`.
 */
export function defineDataType<D, W extends Record<string, z.ZodObject>>(
  id: string,
  data: z.ZodType<D>,
  writes: W,
): DataType<D, W> {
  const sourceSchema = z
    .object({
      provider: providerIdSchema,
      label: z.string().min(1),
      status: dataSourceStatusSchema,
      writable: z.boolean(),
      fetchedAt: z.number().nonnegative().optional(),
      data: data.optional(),
    })
    .strict() as unknown as z.ZodType<DataSource<D>>;
  const topic = defineState(id, sourceSchema);
  const services = Object.fromEntries(
    Object.entries(writes).map(([name, change]) => [
      name,
      defineService(`${id}.${name}`, {
        request: change.extend({ key: z.string().min(1) }),
        response: dataWriteResultSchema,
        keyedBy: topic,
      }),
    ]),
  ) as unknown as DataType<D, W>['writes'];
  return Object.freeze({ id, topic, writes: services });
}

/** The choice for one data type: a provider id. */
export const dataSourceChoiceSchema = z.object({ provider: providerIdSchema }).strict();

export type DataSourceChoice = z.infer<typeof dataSourceChoiceSchema>;

/**
 * The provider each data type is read from, keyed by the data type (`athlete.profile`). Owned by
 * the host side of the settings plugin, which keeps the choice. A key whose provider is gone holds
 * `ridrs`.
 */
export const dataSourceState = defineState('data.source', dataSourceChoiceSchema);

/**
 * Chooses the provider of a data type (`key`); answered once the choice is kept. Fails when the
 * type has no such provider.
 */
export const dataSelectService = defineService('data.select', {
  request: z.object({ key: z.string().min(1), provider: providerIdSchema }).strict(),
  response: z.object({}).strict(),
  keyedBy: dataSourceState,
});
