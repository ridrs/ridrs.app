// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineState } from './app-state.ts';
import type { ControllerButton } from './events.ts';
import { defineService } from './services.ts';

/**
 * What a controller button can stand for in the user interface (ADR 0098): the arrow keys, Enter
 * and Back, which make every screen of the ride path usable (AGENTS.md rule 12).
 */
export const CONTROLLER_COMMANDS = ['up', 'down', 'left', 'right', 'confirm', 'back'] as const;

export const controllerCommandSchema = z.enum(CONTROLLER_COMMANDS);

export type ControllerCommand = z.infer<typeof controllerCommandSchema>;

/**
 * The buttons a command can be put on: the d-pad and A, B, Y, Z. The shift and power-up buttons
 * shift gears and set the ERG target during a ride, and the on/off buttons switch the controller
 * off: they stay as they are.
 */
export const BINDABLE_CONTROLLER_BUTTONS = [
  'up',
  'down',
  'left',
  'right',
  'a',
  'b',
  'y',
  'z',
] as const satisfies readonly ControllerButton[];

export const bindableControllerButtonSchema = z.enum(BINDABLE_CONTROLLER_BUTTONS);

export type BindableControllerButton = z.infer<typeof bindableControllerButtonSchema>;

/** The button of each command; no two commands share one. */
export const controllerBindingsSchema = z
  .object(
    Object.fromEntries(
      CONTROLLER_COMMANDS.map((c) => [c, bindableControllerButtonSchema]),
    ) as Record<ControllerCommand, typeof bindableControllerButtonSchema>,
  )
  .strict()
  .refine((bindings) => new Set(Object.values(bindings)).size === CONTROLLER_COMMANDS.length, {
    message: 'Two commands share a button',
  });

export type ControllerBindings = z.infer<typeof controllerBindingsSchema>;

/** As a Zwift Ride is used everywhere: the d-pad moves, A confirms, B goes back. */
export const DEFAULT_CONTROLLER_BINDINGS: ControllerBindings = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  confirm: 'a',
  back: 'b',
};

/** The one key of `controller.bindings`: one set of bindings for every controller. */
export const CONTROLLER_BINDINGS_KEY = 'controller';

/**
 * The rider's controller bindings, under `CONTROLLER_BINDINGS_KEY`. Owned by the settings plugin,
 * which keeps them; the shell turns the buttons into keys with them. Without an owner it is empty,
 * and the shell uses `DEFAULT_CONTROLLER_BINDINGS`.
 */
export const controllerBindingsState = defineState('controller.bindings', controllerBindingsSchema);

/** Replaces every binding at once; answered once they are kept, or could not be. */
export const controllerBindingsSetService = defineService('controller.set-bindings', {
  request: z.object({ bindings: controllerBindingsSchema }).strict(),
  response: z.object({}).strict(),
});

/**
 * Puts `command` on `button`. A command that had the button gets the command's old button in
 * exchange, as in a game: no command ever loses its button.
 */
export function bindControllerButton(
  bindings: ControllerBindings,
  command: ControllerCommand,
  button: BindableControllerButton,
): ControllerBindings {
  const previous = bindings[command];
  const next = { ...bindings };
  for (const other of CONTROLLER_COMMANDS) {
    if (other !== command && next[other] === button) {
      next[other] = previous;
    }
  }
  next[command] = button;
  return next;
}
