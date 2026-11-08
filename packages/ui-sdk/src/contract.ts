// SPDX-License-Identifier: Apache-2.0

import type {
  EventDefinition,
  EventEnvelope,
  PluginSettingsContext,
  ServiceDefinition,
  StateDefinition,
  StateView,
  UiRegistry,
} from '@ridrs/contracts';

export type Unsubscribe = () => void;

export type UiLogger = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

/** One frame of the shell's render clock. Every component in a frame sees the same frame. */
export interface UiFrame {
  /** 0, 1, 2 … since the frame clock started. */
  readonly index: number;
  /** The host clock (epoch ms) at the frame: render time is on the simulation's time axis. */
  readonly time: number;
}

export interface OutletOptions {
  /** The ids of the screens shown in the outlet instead of on their own. */
  readonly screens: readonly string[];
  /**
   * The screens shown in `container` over the page instead (ADR 0071): navigating to one keeps
   * the shown screen, in the outlet or not, mounted beneath it as the page.
   */
  readonly dialog?: { readonly container: HTMLElement; readonly screens: readonly string[] };
}

export interface SlotOptions {
  /** The one contribution to mount, as `<pluginId>/<contributionId>`; all of them without it. */
  readonly contribution?: string;
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
  /** App state beside the bus (ADR 0068): the topics of the plugin's own `ui.state`. */
  readonly state: {
    /**
     * Calls `listener` with every entry first, then with the keys changed since, coalesced per
     * tick. Throws `undeclared-state` unless the topic is in the plugin's own `ui.state`.
     */
    watch<T>(topic: StateDefinition<T>, listener: (view: StateView<T>) => void): Unsubscribe;
  };
  /**
   * Calls a service of the plugin's own `ui.calls` (ADR 0068). Rejects with a RidrsError:
   * `undeclared-service`, `service-unavailable`, `unknown-key`, `invalid-request`, or the reason
   * of the plugin that answers.
   */
  call<Req, Res>(service: ServiceDefinition<Req, Res>, request: Req): Promise<Res>;
  /**
   * Mounts every contribution of the extension point into `container` and keeps it in sync. With
   * `contribution` (`<pluginId>/<contributionId>`), only that one, once it targets the point.
   */
  slot(extensionPoint: string, container: HTMLElement, options?: SlotOptions): Unsubscribe;
  /**
   * Handles Back (Escape, Backspace, the platform's back button) while the component is mounted.
   * The handler registered last wins; without one, Back does nothing.
   */
  onBack(handler: () => void): Unsubscribe;
  /** Switches the active screen; unknown paths are logged and ignored. */
  navigate(path: string): void;
  /**
   * Leaves the shown screen, as Back does by default: a screen in a dialog closes and gives the
   * page beneath it back; any other screen gives way to the first screen (Today).
   */
  leave(): void;
  /** Whether a screen with this id is there to navigate to: a screen of a plugin that may be absent. */
  hasScreen(path: string): boolean;
  /**
   * The plugin's settings documents (ADR 0059): the same as its host side's `ctx.settings`, with
   * the same permissions (`persistence` in the manifest). A write is kept once it resolves. The
   * same object for every component of the plugin while its host runs.
   */
  readonly settings: PluginSettingsContext;
  /**
   * Called with the shown screen's id at once and after every navigation. With a screen shown in
   * an outlet, that is the screen in the outlet, not the screen around it. `page` is the screen
   * beneath a dialog while one is shown in a dialog (ADR 0071), else the shown screen itself.
   */
  onNavigated(handler: (screen: string, page: string) => void): Unsubscribe;
  /**
   * Takes over the screens named in `options`: navigating to one of them while this screen is
   * shown mounts it into `container` and keeps this screen mounted around it. Elsewhere they are
   * shown on their own. Only for a screen's own component; the outlet opened last counts.
   */
  outlet(container: HTMLElement, options: OutletOptions): Unsubscribe;
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
 * One message of a state watch (ADR 0068), shaped so a remote bridge can send it as it is: the
 * first is the snapshot, later ones carry the keys changed since, each with its last value.
 */
export interface StateUpdate {
  /** The first update of a watch: `values` holds every entry. */
  readonly snapshot: boolean;
  readonly values: Readonly<Record<string, unknown>>;
  readonly removed: readonly string[];
}

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
  /** The snapshot of the topic, then its changes. Throws `state-not-allowed` outside `registry().state`. */
  watchState(topicId: string, listener: (update: StateUpdate) => void): Unsubscribe;
  /** The service's answer or its error; rejects `call-not-allowed` outside `registry().calls`. */
  call(serviceId: string, request: unknown): Promise<unknown>;
  loadModule(pluginId: string): Promise<Record<string, unknown>>;
  reportClientError(pluginId: string, message: string): void;
  /** The settings documents of a plugin in the registry; throws for any other. */
  settings(pluginId: string): PluginSettingsContext;
  /** The host clock (epoch ms). Exact in-process; a remote bridge would need clock sync. */
  now(): number;
}
