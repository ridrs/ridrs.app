// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type EventDefinition,
  type EventEnvelope,
  RidrsError,
  type ServiceDefinition,
  type StateDefinition,
  type StateView,
  type UiRegistry,
  type UiRegistryContribution,
  type UiRegistryPlugin,
  type UiRegistryScreen,
} from '@ridrs/contracts';
import { FrameClock, type FrameSource } from '@ridrs/presentation';
import type {
  OutletOptions,
  UiBridge,
  UiComponent,
  UiContext,
  UiLogger,
  Unsubscribe,
} from '@ridrs/ui-sdk';
import { keyboardNavigation } from './keyboard.ts';

export interface ShellOptions {
  readonly logger?: UiLogger;
  /** Screen shown first. The shell is an app, so this convention lives here and nowhere else. */
  readonly initialScreen?: string;
  /** Paces the render clock; requestAnimationFrame of the root's window by default. */
  readonly frameSource?: FrameSource;
  /** The platform's back button (Android's), if it has one: calls `press` on every press. */
  readonly backButton?: (press: () => void) => Unsubscribe;
}

/** Frames at the display's refresh rate; the WebView pauses them while it is hidden. */
function animationFrameSource(view: Window): FrameSource {
  return {
    request(callback) {
      const id = view.requestAnimationFrame(() => callback());
      return () => view.cancelAnimationFrame(id);
    },
  };
}

type Entry = UiRegistryScreen | UiRegistryContribution;

interface Mounted {
  unmount(): void;
}

/** A slot keeps one extension point's contributions mounted in a container. */
interface Slot {
  readonly point: string;
  /** The one contribution the slot holds, by key; every contribution of the point without it. */
  readonly only?: string;
  readonly container: HTMLElement;
  readonly mounted: Map<string, { readonly wrapper: HTMLElement; readonly handle: Mounted }>;
}

/** Where an outlet shows screens: its container and the ids of the screens it takes over. */
interface Place {
  readonly container: HTMLElement;
  readonly screens: ReadonlySet<string>;
}

/** A screen mounted into a place. */
interface Placed {
  readonly screen: UiRegistryScreen;
  readonly container: HTMLElement;
  readonly wrapper: HTMLElement;
  readonly handle: Mounted;
}

const keyOf = (entry: Entry) => `${entry.pluginId}/${entry.id}`;

/** The same screen of the same plugin, whichever registry revision it comes from. */
const sameScreen = (a: UiRegistryScreen | undefined, b: UiRegistryScreen | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.pluginId === b.pluginId &&
    a.id === b.id &&
    a.export === b.export);

/**
 * Renders one screen of the UI registry at a time into `root` (or into the outlet of the screen in
 * `root`, which stays mounted around it, when that screen takes it over; or into its dialog over
 * the page, which stays mounted beneath it, ADR 0071), mounts contributions into
 * the slots screens and contributions open, and keeps everything in sync with registry changes.
 * Owns the one frame clock that components reach through `ctx.frames`. Knows no screen,
 * extension point or plugin by name.
 */
export function mountShell(
  root: HTMLElement,
  bridge: UiBridge,
  options: ShellOptions = {},
): Unsubscribe {
  const logger = options.logger ?? console;
  const initialScreen = options.initialScreen ?? 'main';
  const document = root.ownerDocument;
  const view = document.defaultView;
  const frameSource = options.frameSource ?? (view ? animationFrameSource(view) : undefined);
  if (!frameSource) {
    throw new Error('The shell needs a frame source: its root is in no window');
  }
  // The one render clock of the app: on the host's time axis, running only while subscribed.
  const frames = new FrameClock({
    source: frameSource,
    now: () => bridge.now(),
    onError: (error, owner) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`A frame handler of "${owner}" failed: ${message}`);
      if (owner) {
        bridge.reportClientError(owner, `frame handler: ${message}`);
      }
    },
  });
  const modules = new Map<string, Promise<Record<string, unknown>>>();
  const slots = new Set<Slot>();
  // Back goes to the component that asked for it last: the innermost one still mounted.
  const backHandlers: (() => void)[] = [];
  const back = () => backHandlers.at(-1)?.();
  let registry = bridge.registry();
  /** The screen in `root`: the shown screen, or the screen around the shown one. */
  let active: { readonly screen: UiRegistryScreen; readonly handle: Mounted } | undefined;
  /** The shown screen while it is in the outlet of `active`. */
  let wanted: UiRegistryScreen | undefined;
  /** The shown screen while it is in the dialog of `active`, over the page. */
  let over: UiRegistryScreen | undefined;
  let outlet: (Place & { readonly dialog?: Place }) | undefined;
  let framed: Placed | undefined;
  let overlaid: Placed | undefined;
  const navigated = new Set<(screen: string, page: string) => void>();
  let announced: { readonly screen: string; readonly page: string } | undefined;
  let disposed = false;
  /** The page: the screen beneath a dialog, or the shown screen. */
  const pageScreen = () => wanted ?? active?.screen;
  const shownScreen = () => over ?? pageScreen();

  const loadModule = (pluginId: string) => {
    let module = modules.get(pluginId);
    if (!module) {
      module = bridge.loadModule(pluginId);
      modules.set(pluginId, module);
    }
    return module;
  };

  const listsOf = (pluginId: string): UiRegistryPlugin =>
    registry.plugins.find((p) => p.pluginId === pluginId) ?? {
      pluginId,
      events: { subscribe: [], publish: [] },
      state: [],
      calls: [],
    };
  const eventsOf = (pluginId: string) => listsOf(pluginId).events;

  /** Mounts one component; everything it obtains through its context is released on unmount. */
  const mountComponent = (entry: Entry, container: HTMLElement): Mounted => {
    const owned = new Set<Unsubscribe>();
    const own = (release: Unsubscribe): Unsubscribe => {
      const once = () => {
        if (owned.delete(once)) {
          release();
        }
      };
      owned.add(once);
      return once;
    };
    let cleanup: Unsubscribe | undefined;
    let unmounted = false;

    const ctx: UiContext = {
      pluginId: entry.pluginId,
      logger,
      events: {
        subscribe<T>(def: EventDefinition<T>, handler: (envelope: EventEnvelope<T>) => void) {
          if (!eventsOf(entry.pluginId).subscribe.includes(def.id)) {
            throw new RidrsError(
              'undeclared-event',
              `Plugin "${entry.pluginId}" did not declare "${def.id}" in ui.events.subscribe`,
              { pluginId: entry.pluginId },
            );
          }
          return own(
            bridge.subscribe(def.id, (envelope) => {
              const parsed = def.schema.safeParse(envelope.payload);
              if (!parsed.success) {
                logger.warn(`Dropped an invalid "${def.id}" payload for "${entry.pluginId}"`);
                return;
              }
              handler({ ...envelope, payload: parsed.data } as EventEnvelope<T>);
            }),
          );
        },
        publish<T>(def: EventDefinition<T>, payload: T) {
          if (!eventsOf(entry.pluginId).publish.includes(def.id)) {
            throw new RidrsError(
              'undeclared-event',
              `Plugin "${entry.pluginId}" did not declare "${def.id}" in ui.events.publish`,
              { pluginId: entry.pluginId },
            );
          }
          bridge.publish(def.id, payload);
        },
      },
      state: {
        watch<T>(topic: StateDefinition<T>, listener: (view: StateView<T>) => void) {
          if (!listsOf(entry.pluginId).state.includes(topic.id)) {
            throw new RidrsError(
              'undeclared-state',
              `Plugin "${entry.pluginId}" did not declare "${topic.id}" in ui.state`,
              { pluginId: entry.pluginId },
            );
          }
          // The client's own copy of the topic, rebuilt from the bridge's messages.
          const entries = new Map<string, T>();
          return own(
            bridge.watchState(topic.id, (update) => {
              if (update.snapshot) {
                entries.clear();
              }
              const changed = [...update.removed];
              for (const key of update.removed) {
                entries.delete(key);
              }
              for (const [key, value] of Object.entries(update.values)) {
                const parsed = topic.schema.safeParse(value);
                if (!parsed.success) {
                  logger.warn(`Dropped an invalid "${topic.id}" value for "${entry.pluginId}"`);
                  continue;
                }
                entries.set(key, parsed.data);
                changed.push(key);
              }
              listener({ entries: new Map(entries), changed });
            }),
          );
        },
      },
      call<Req, Res>(service: ServiceDefinition<Req, Res>, request: Req): Promise<Res> {
        if (!listsOf(entry.pluginId).calls.includes(service.id)) {
          return Promise.reject(
            new RidrsError(
              'undeclared-service',
              `Plugin "${entry.pluginId}" did not declare "${service.id}" in ui.calls`,
              { pluginId: entry.pluginId },
            ),
          );
        }
        return bridge.call(service.id, request) as Promise<Res>;
      },
      slot: (point, slotContainer, slotOptions) =>
        own(openSlot(point, slotContainer, slotOptions?.contribution)),
      frames: {
        onFrame: (handler) => own(frames.onFrame(handler, entry.pluginId)),
      },
      onBack: (handler) => {
        const entryHandler = () => handler();
        backHandlers.push(entryHandler);
        return own(() => backHandlers.splice(backHandlers.lastIndexOf(entryHandler), 1));
      },
      navigate: (path) => {
        // Deferred so a component may navigate from inside its own render or event handler.
        queueMicrotask(() => navigate(path));
      },
      leave: () => {
        queueMicrotask(leave);
      },
      hasScreen: (path) => registry.screens.some((s) => s.id === path),
      onNavigated: (handler) => {
        const entryHandler = (screen: string, page: string) => handler(screen, page);
        navigated.add(entryHandler);
        const shown = shownScreen();
        const page = pageScreen();
        if (shown && page) {
          handler(shown.id, page.id);
        }
        return own(() => navigated.delete(entryHandler));
      },
      // The host's one settings access of the plugin, the same object for all its components.
      get settings() {
        return bridge.settings(entry.pluginId);
      },
      outlet: (outletContainer, outletOptions) =>
        own(openOutlet(entry, outletContainer, outletOptions)),
    };

    const fail = (reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      logger.error(`UI component "${keyOf(entry)}" failed: ${message}`);
      bridge.reportClientError(entry.pluginId, `${keyOf(entry)}: ${message}`);
    };

    loadModule(entry.pluginId).then(
      (module) => {
        if (unmounted) {
          return;
        }
        const component = module[entry.export];
        if (typeof component !== 'function') {
          fail(new Error(`The client module does not export a component "${entry.export}"`));
          return;
        }
        try {
          cleanup = (component as UiComponent)(container, ctx) ?? undefined;
        } catch (error) {
          for (const release of [...owned]) {
            release();
          }
          fail(error);
        }
      },
      (error: unknown) => {
        if (!unmounted) {
          fail(error);
        }
      },
    );

    return {
      unmount() {
        if (unmounted) {
          return;
        }
        unmounted = true;
        for (const release of [...owned]) {
          release();
        }
        try {
          cleanup?.();
        } catch (error) {
          logger.error(`UI component "${keyOf(entry)}" failed to clean up: ${String(error)}`);
        }
        container.replaceChildren();
      },
    };
  };

  const syncSlot = (slot: Slot) => {
    const wanted = registry.contributions.filter(
      (c) => c.extensionPoint === slot.point && (slot.only === undefined || keyOf(c) === slot.only),
    );
    const wantedKeys = new Set(wanted.map(keyOf));
    for (const [key, { wrapper, handle }] of [...slot.mounted]) {
      if (!wantedKeys.has(key)) {
        slot.mounted.delete(key);
        handle.unmount();
        wrapper.remove();
      }
    }
    for (const contribution of wanted) {
      const key = keyOf(contribution);
      let mounted = slot.mounted.get(key);
      if (!mounted) {
        const wrapper = document.createElement('div');
        wrapper.dataset.contribution = key;
        mounted = { wrapper, handle: mountComponent(contribution, wrapper) };
        slot.mounted.set(key, mounted);
      }
      // Re-appending moves existing nodes into registry order without remounting them.
      slot.container.appendChild(mounted.wrapper);
    }
  };

  const openSlot = (point: string, container: HTMLElement, only?: string): Unsubscribe => {
    const other = only && registry.contributions.find((c) => keyOf(c) === only);
    if (other && other.extensionPoint !== point) {
      logger.warn(`"${only}" contributes to "${other.extensionPoint}", not to "${point}"`);
    }
    const slot: Slot = { point, container, only, mounted: new Map() };
    slots.add(slot);
    syncSlot(slot);
    return () => {
      slots.delete(slot);
      for (const { wrapper, handle } of slot.mounted.values()) {
        handle.unmount();
        wrapper.remove();
      }
      slot.mounted.clear();
    };
  };

  /** Keeps `screen` mounted in `place`; unmounts what is there when either is gone or changed. */
  const placeScreen = (
    placed: Placed | undefined,
    screen: UiRegistryScreen | undefined,
    place: Place | undefined,
  ): Placed | undefined => {
    const fits = screen !== undefined && place?.screens.has(screen.id) === true;
    if (
      placed &&
      (!fits || !sameScreen(placed.screen, screen) || placed.container !== place?.container)
    ) {
      placed.handle.unmount();
      placed.wrapper.remove();
    } else if (placed) {
      return placed;
    }
    if (!screen || !place || !fits) {
      return undefined;
    }
    const wrapper = document.createElement('div');
    wrapper.dataset.screen = screen.id;
    place.container.appendChild(wrapper);
    return { screen, container: place.container, wrapper, handle: mountComponent(screen, wrapper) };
  };

  /** Mounts the wanted screen into the outlet and the one over the page into its dialog. */
  const syncFramed = () => {
    framed = placeScreen(framed, wanted, outlet);
    overlaid = placeScreen(overlaid, over, outlet?.dialog);
  };

  const openOutlet = (
    entry: Entry,
    container: HTMLElement,
    { screens, dialog }: OutletOptions,
  ): Unsubscribe => {
    if (entry !== active?.screen) {
      logger.warn(`"${keyOf(entry)}" is not the screen in the root; its outlet stays empty`);
      return () => {};
    }
    const opened = {
      container,
      screens: new Set(screens),
      dialog: dialog && { container: dialog.container, screens: new Set(dialog.screens) },
    };
    outlet = opened;
    syncFramed();
    return () => {
      if (outlet === opened) {
        outlet = undefined;
        syncFramed();
      }
    };
  };

  const announce = () => {
    const screen = shownScreen()?.id;
    const page = pageScreen()?.id;
    if (
      screen !== undefined &&
      page !== undefined &&
      (screen !== announced?.screen || page !== announced.page)
    ) {
      announced = { screen, page };
      for (const handler of [...navigated]) {
        handler(screen, page);
      }
    }
  };

  const mountRoot = (screen: UiRegistryScreen | undefined) => {
    active?.handle.unmount();
    root.replaceChildren();
    active = undefined;
    if (screen) {
      const wrapper = document.createElement('div');
      wrapper.dataset.screen = screen.id;
      root.appendChild(wrapper);
      active = { screen, handle: mountComponent(screen, wrapper) };
    }
  };

  /**
   * Shows a screen: in the dialog of the screen in the root over the page, or in its outlet, when
   * that one took it over, otherwise in the root. The screen in the root stays mounted when it is
   * shown again.
   */
  const show = (screen: UiRegistryScreen | undefined) => {
    const inRoot = sameScreen(active?.screen, screen);
    over = screen && !inRoot && outlet?.dialog?.screens.has(screen.id) ? screen : undefined;
    if (over) {
      // The page stays as it is beneath the dialog.
    } else if (screen && !inRoot && outlet?.screens.has(screen.id)) {
      wanted = screen;
    } else {
      wanted = undefined;
      if (!inRoot) {
        mountRoot(screen);
      }
    }
    syncFramed();
    announce();
  };

  const defaultScreen = () =>
    registry.screens.find((s) => s.id === initialScreen) ??
    [...registry.screens].sort((a, b) => a.id.localeCompare(b.id))[0];

  function navigate(path: string): void {
    if (disposed || shownScreen()?.id === path) {
      return;
    }
    const screen = registry.screens.find((s) => s.id === path);
    if (!screen) {
      logger.warn(`Unknown screen "${path}"; staying on the current screen`);
      return;
    }
    show(screen);
  }

  /** Closes the dialog over the page, or goes to the first screen from any other screen. */
  function leave(): void {
    if (disposed) {
      return;
    }
    if (over) {
      over = undefined;
      syncFramed();
      announce();
      return;
    }
    navigate(initialScreen);
  }

  const onRegistry = (next: UiRegistry) => {
    registry = next;
    const present = new Set([...next.screens, ...next.contributions].map((e) => e.pluginId));
    for (const pluginId of [...modules.keys()]) {
      if (!present.has(pluginId)) {
        // A restarted plugin's module is imported again on its next appearance.
        modules.delete(pluginId);
      }
    }
    // Keeps what is unchanged mounted. A restarted screen around the outlet gets the screen in it
    // back once it opens its outlet again; without it, that screen is shown on its own.
    const around = active && next.screens.find((s) => s.id === active?.screen.id);
    const inside = wanted && next.screens.find((s) => s.id === wanted?.id);
    const overInside = over && next.screens.find((s) => s.id === over?.id);
    if (around && (wanted || over)) {
      if (!sameScreen(around, active?.screen)) {
        mountRoot(around);
      }
      wanted = inside;
      over = overInside;
      syncFramed();
      announce();
    } else {
      const shown = shownScreen();
      const current = next.screens.find((s) => s.id === shown?.id);
      if (!around) {
        wanted = undefined;
        over = undefined;
        mountRoot(undefined);
      }
      show(current ?? defaultScreen());
    }
    for (const slot of [...slots]) {
      if (slots.has(slot)) {
        syncSlot(slot);
      }
    }
  };

  const stopListening = bridge.onRegistryChanged(onRegistry);
  const stopKeyboard = keyboardNavigation(root, { back });
  const stopBackButton = options.backButton?.(back);
  show(defaultScreen());

  return () => {
    disposed = true;
    stopListening();
    stopKeyboard();
    stopBackButton?.();
    show(undefined);
  };
}
