// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type EventDefinition,
  type EventEnvelope,
  RidrsError,
  type UiRegistry,
  type UiRegistryContribution,
  type UiRegistryScreen,
} from '@ridrs/contracts';
import { FrameClock, type FrameSource } from '@ridrs/presentation';
import type { UiBridge, UiComponent, UiContext, UiLogger, Unsubscribe } from '@ridrs/ui-sdk';

export interface ShellOptions {
  readonly logger?: UiLogger;
  /** Screen shown first. The shell is an app, so this convention lives here and nowhere else. */
  readonly initialScreen?: string;
  /** Paces the render clock; requestAnimationFrame of the root's window by default. */
  readonly frameSource?: FrameSource;
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
  readonly container: HTMLElement;
  readonly mounted: Map<string, { readonly wrapper: HTMLElement; readonly handle: Mounted }>;
}

const keyOf = (entry: Entry) => `${entry.pluginId}/${entry.id}`;

/**
 * Renders exactly one screen of the UI registry at a time into `root`, mounts contributions into
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
  let registry = bridge.registry();
  let active: { readonly screen: UiRegistryScreen; readonly handle: Mounted } | undefined;
  let disposed = false;

  const loadModule = (pluginId: string) => {
    let module = modules.get(pluginId);
    if (!module) {
      module = bridge.loadModule(pluginId);
      modules.set(pluginId, module);
    }
    return module;
  };

  const eventsOf = (pluginId: string) =>
    registry.plugins.find((p) => p.pluginId === pluginId)?.events ?? { subscribe: [], publish: [] };

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
      slot: (point, slotContainer) => own(openSlot(point, slotContainer)),
      frames: {
        onFrame: (handler) => own(frames.onFrame(handler, entry.pluginId)),
      },
      navigate: (path) => {
        // Deferred so a component may navigate from inside its own render or event handler.
        queueMicrotask(() => navigate(path));
      },
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
    const wanted = registry.contributions.filter((c) => c.extensionPoint === slot.point);
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

  const openSlot = (point: string, container: HTMLElement): Unsubscribe => {
    const slot: Slot = { point, container, mounted: new Map() };
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

  const show = (screen: UiRegistryScreen | undefined) => {
    active?.handle.unmount();
    root.replaceChildren();
    active = undefined;
    if (!screen) {
      return;
    }
    const wrapper = document.createElement('div');
    wrapper.dataset.screen = screen.id;
    root.appendChild(wrapper);
    active = { screen, handle: mountComponent(screen, wrapper) };
  };

  const defaultScreen = () =>
    registry.screens.find((s) => s.id === initialScreen) ??
    [...registry.screens].sort((a, b) => a.id.localeCompare(b.id))[0];

  function navigate(path: string): void {
    if (disposed || active?.screen.id === path) {
      return;
    }
    const screen = registry.screens.find((s) => s.id === path);
    if (!screen) {
      logger.warn(`Unknown screen "${path}"; staying on the current screen`);
      return;
    }
    show(screen);
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
    const current = active && next.screens.find((s) => s.id === active?.screen.id);
    if (
      !current ||
      current.pluginId !== active?.screen.pluginId ||
      current.export !== active.screen.export
    ) {
      show(current ?? defaultScreen());
    }
    for (const slot of [...slots]) {
      if (slots.has(slot)) {
        syncSlot(slot);
      }
    }
  };

  const stopListening = bridge.onRegistryChanged(onRegistry);
  show(defaultScreen());

  return () => {
    disposed = true;
    stopListening();
    show(undefined);
  };
}
