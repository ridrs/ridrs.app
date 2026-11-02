// SPDX-License-Identifier: Apache-2.0

import type { EventDefinition, EventEnvelope, UiRegistry } from '@ridrs/contracts';

export type Unsubscribe = () => void;

export type UiLogger = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

/** One frame of the shell's render clock. Every component in a frame sees the same frame. */
export interface UiFrame {
  /** 0, 1, 2 … since the frame clock started. */
  readonly index: number;
  /** The host clock (epoch ms) at the frame: render time is on the simulation's time axis. */
  readonly time: number;
}

/**
 * What the shell hands to every screen and contribution. Mirrors the plugin context of the core:
 * subscriptions and slot mounts made through it belong to the component and are released when the
 * component is unmounted.
 */
export interface UiContext {
  readonly pluginId: string;
  readonly logger: UiLogger;
  readonly events: {
    /** Throws `undeclared-event` unless the event is in the plugin's own `ui.events.subscribe`. */
    subscribe<T>(
      def: EventDefinition<T>,
      handler: (envelope: EventEnvelope<T>) => void,
    ): Unsubscribe;
    /** Throws `undeclared-event` unless the event is in the plugin's own `ui.events.publish`. */
    publish<T>(def: EventDefinition<T>, payload: T): void;
  };
  /** Mounts every contribution of the extension point into `container` and keeps it in sync. */
  slot(extensionPoint: string, container: HTMLElement): Unsubscribe;
  /** Switches the active screen; unknown paths are logged and ignored. */
  navigate(path: string): void;
  /** The shell's one render clock, at the display's refresh rate. Read-only: frames drive nothing. */
  readonly frames: {
    /** Called once per frame while subscribed. Only while the component is mounted. */
    onFrame(handler: (frame: UiFrame) => void): Unsubscribe;
  };
}

/**
 * The exported client entry of a screen or contribution. Framework-neutral: a plugin may render
 * with React or anything else inside `container`. The returned function cleans up what the
 * component created itself.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: components without cleanup simply return nothing.
export type UiComponent = (container: HTMLElement, ctx: UiContext) => void | Unsubscribe;

/**
 * Port between the shell and the host. The native app implements it in-process; a remote
 * implementation (e.g. a WebSocket gateway) can be added without changing the shell.
 */
export interface UiBridge {
  registry(): UiRegistry;
  onRegistryChanged(listener: (registry: UiRegistry) => void): Unsubscribe;
  /**
   * Receives the latest envelope of the event first (if any), then live ones.
   * Throws `event-not-allowed` for events outside the registry's allow-list.
   */
  subscribe(eventId: string, listener: (envelope: EventEnvelope) => void): Unsubscribe;
  /** Throws `event-not-allowed` or `invalid-event-payload`; nothing is published then. */
  publish(eventId: string, payload: unknown): void;
  loadModule(pluginId: string): Promise<Record<string, unknown>>;
  reportClientError(pluginId: string, message: string): void;
  /** The host clock (epoch ms). Exact in-process; a remote bridge would need clock sync. */
  now(): number;
}
