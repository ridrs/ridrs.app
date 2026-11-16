// SPDX-License-Identifier: Apache-2.0

import type { ControllerButton } from '@ridrs/contracts';

/**
 * The DOM event the shell dispatches on the document for every press of a controller button,
 * before it turns the button into a key (ADR 0098). It is cancelable: a component that wants the
 * button itself, such as the settings while they wait for the button to put a command on, calls
 * `preventDefault()`, and the shell presses no key for it.
 */
export const CONTROLLER_BUTTON_EVENT = 'ridrs:controller-button';

export interface ControllerButtonEventDetail {
  readonly button: ControllerButton;
}
