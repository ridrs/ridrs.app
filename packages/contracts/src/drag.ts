// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { rideWorldSchema } from './activity.ts';
import { providerIdSchema } from './data-sources.ts';

/**
 * Things dragged from one plugin's view to another's (ADR 0096): each plugin renders into its own
 * root, so nothing but the drag's data crosses between them. While the pointer hovers, the web
 * view shows a target only the types (WebKit lowercases them), so the kind is in the type and the
 * payload, JSON, is read and checked on the drop.
 */

/** A workout: one of a library, or one planned in a calendar. */
export const DRAG_WORKOUT = 'application/x-ridrs-workout+json';
/** A route the ride page offers. */
export const DRAG_ROUTE = 'application/x-ridrs-route+json';
/** Something the bin takes. */
export const DRAG_REMOVABLE = 'application/x-ridrs-removable+json';

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A dragged workout, with the name shown for it. */
export const draggedWorkoutSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('library'),
      from: providerIdSchema,
      workoutId: z.string().min(1),
      name: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('planned'),
      from: providerIdSchema,
      id: z.string().min(1),
      name: z.string().min(1),
      date: localDateSchema,
    })
    .strict(),
]);

export type DraggedWorkout = z.infer<typeof draggedWorkoutSchema>;

/** A dragged route: its offer, what Go puts into `activity.start-requested`, and its title. */
export const draggedRouteSchema = z
  .object({
    offer: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    world: rideWorldSchema,
    title: z.string().min(1),
  })
  .strict();

export type DraggedRoute = z.infer<typeof draggedRouteSchema>;

/**
 * What the bin takes (ADR 0096): a planned entry of a provider's calendar, or a ride done with
 * every provider that has it, each with a title and a date to list it by. Or something its source
 * takes away itself (`dismissed`, a part of the next ride): the bin takes the drop as a move and
 * keeps nothing, and the source sees the move in `dropEffect` on `dragend`.
 */
export const removableSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('calendar-entry'),
      provider: providerIdSchema,
      id: z.string().min(1),
      title: z.string(),
      date: localDateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('done-ride'),
      removals: z
        .array(z.object({ provider: providerIdSchema, id: z.string().min(1) }).strict())
        .min(1),
      title: z.string(),
      date: localDateSchema,
    })
    .strict(),
  z.object({ kind: z.literal('dismissed'), title: z.string() }).strict(),
]);

export type Removable = z.infer<typeof removableSchema>;

/** The part of a `DataTransfer` the drags use. */
export interface DragData {
  readonly types: ArrayLike<string> | Iterable<string>;
  setData(type: string, data: string): void;
  getData(type: string): string;
}

/** Puts a payload of `type` into a drag, on `dragstart`. */
export function setDragged(
  data: DragData | null | undefined,
  type: string,
  payload: unknown,
): void {
  data?.setData(type, JSON.stringify(payload));
}

/** Whether a drag carries `type`: all a target can tell while the pointer hovers. */
export function carries(data: DragData | null | undefined, type: string): boolean {
  if (!data?.types) return false;
  return Array.from(data.types as ArrayLike<string>).some((each) => each.toLowerCase() === type);
}

/** The payload of `type` in a drag, on `drop`; nothing when it is missing or not of the schema. */
export function readDragged<T>(
  data: DragData | null | undefined,
  type: string,
  schema: z.ZodType<T>,
): T | undefined {
  const text = data?.getData(type);
  if (!text) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
