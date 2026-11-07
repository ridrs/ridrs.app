// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type { StateDefinition } from './app-state.ts';
import { eventIdSchema } from './manifest-ids.ts';

/**
 * A service beside the simulation bus (ADR 0068): a request with an answer or an error. Answers
 * are quick: long work is a call that starts it, state that reports it and a call that cancels it.
 * Never recorded: a service that changes the ride must not exist, a ride changes by inputs.
 */
export interface ServiceDefinition<Req = unknown, Res = unknown, TId extends string = string> {
  /** A lowercase dotted id, like an event's. */
  readonly id: TId;
  readonly request: z.ZodType<Req>;
  readonly response: z.ZodType<Res>;
  /** Routes a call to the owner of `request.key` in this topic; the request schema has `key: string`. */
  readonly keyedBy?: StateDefinition;
}

/** Throws at definition time when `keyedBy` is given and the request has no `key: string`. */
export function defineService<Req, Res, TId extends string>(
  id: TId,
  options: {
    readonly request: z.ZodType<Req>;
    readonly response: z.ZodType<Res>;
    readonly keyedBy?: StateDefinition;
  },
): ServiceDefinition<Req, Res, TId> {
  const parsedId = eventIdSchema.parse(id) as TId;
  if (options.keyedBy) {
    const key =
      options.request instanceof z.ZodObject
        ? (options.request.shape as Record<string, unknown>).key
        : undefined;
    if (!(key instanceof z.ZodString)) {
      throw new Error(
        `Service "${parsedId}" is keyed by "${options.keyedBy.id}": its request needs "key: z.string()"`,
      );
    }
  }
  return Object.freeze({
    id: parsedId,
    request: options.request,
    response: options.response,
    ...(options.keyedBy ? { keyedBy: options.keyedBy } : {}),
  });
}

/** Who calls a service: a plugin id, `ui-bridge` for UI clients. */
export interface ServiceCaller {
  readonly pluginId: string;
}

export type ServiceHandler<Req, Res> = (request: Req, caller: ServiceCaller) => Res | Promise<Res>;

/** `ctx.services`: only for plugins of the input-side types, as their manifest declares. */
export interface PluginServicesContext {
  /** Only services in `services.provides`. Ends when the plugin stops. */
  provide<Req, Res>(service: ServiceDefinition<Req, Res>, handler: ServiceHandler<Req, Res>): void;
  /**
   * Only services in `services.calls`. Rejects with a RidrsError: `service-unavailable`,
   * `unknown-key`, `invalid-request`, `invalid-response`, or the handler's error.
   */
  call<Req, Res>(service: ServiceDefinition<Req, Res>, request: Req): Promise<Res>;
}
