// SPDX-License-Identifier: Apache-2.0

import type { z } from 'zod';
import { eventIdSchema } from './manifest-ids.ts';

/**
 * A UI capability (ADR 0083): a component with typed input, provided by exactly one UI plugin and
 * drawn by others with `ctx.render(capability, container, input)`. The host decides *what* is
 * shown, the provider *how*. Input and output are plain JSON-like data: no callbacks, no
 * framework elements. Ride data is never render input: a consumer reads it from the bus and at
 * most passes it on.
 */
export interface UiCapabilityDefinition<
  In = unknown,
  Out extends Record<string, unknown> = Record<string, unknown>,
  TId extends string = string,
> {
  /** A lowercase dotted id, `ui.<name>`. */
  readonly id: TId;
  /** Checked before the input reaches the provider. */
  readonly input: z.ZodType<In>;
  /** The events the component reports back, each with its payload; checked before a consumer sees it. */
  readonly output: { readonly [K in keyof Out]: z.ZodType<Out[K]> };
}

/** The input of a UI capability. */
export type UiCapabilityInput<C> = C extends UiCapabilityDefinition<infer In> ? In : never;

/** The output events of a UI capability, by name. */
export type UiCapabilityOutput<C> =
  C extends UiCapabilityDefinition<unknown, infer Out> ? Out : never;

/** Throws at definition time unless the id is a dotted id starting with `ui.`. */
export function defineUiCapability<
  In,
  TId extends string,
  Out extends Record<string, unknown> = Record<never, never>,
>(
  id: TId,
  options: {
    readonly input: z.ZodType<In>;
    readonly output?: { readonly [K in keyof Out]: z.ZodType<Out[K]> };
  },
): UiCapabilityDefinition<In, Out, TId> {
  const parsedId = eventIdSchema.parse(id) as TId;
  if (!parsedId.startsWith('ui.')) {
    throw new Error(`UI capability "${parsedId}" must start with "ui."`);
  }
  return Object.freeze({
    id: parsedId,
    input: options.input,
    output: Object.freeze({ ...(options.output ?? {}) }) as UiCapabilityDefinition<
      In,
      Out,
      TId
    >['output'],
  });
}
