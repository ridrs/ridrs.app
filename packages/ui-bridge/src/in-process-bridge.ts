// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type EventDefinition,
  type EventEnvelope,
  type EventSubscription,
  RidrsError,
  uiRegistryChangedEvent,
} from '@ridrs/contracts';
import type { PluginHost } from '@ridrs/core';
import type { StateUpdate, UiBridge, Unsubscribe } from '@ridrs/ui-sdk';

export interface InProcessUiBridge extends UiBridge {
  dispose(): void;
}

/** Source name of events the bridge publishes on behalf of client code. */
const BRIDGE_SOURCE = 'ui-bridge';

/**
 * `UiBridge` for a shell running in the same process as the host (the native app's WebView).
 * Enforces the registry's allow-list, replays the latest envelope of every bridged event to new
 * subscribers and turns client failures into diagnostics. Knows nothing about rides or metrics.
 *
 * Create it before `host.start()` with every event the UI may use, so values published while
 * plugins start (e.g. the initial activity state) are already cached.
 */
export function createInProcessUiBridge(
  host: PluginHost,
  events: Iterable<EventDefinition>,
): InProcessUiBridge {
  const definitions = new Map<string, EventDefinition>();
  const latest = new Map<string, EventEnvelope>();
  const listeners = new Map<string, Set<(envelope: EventEnvelope) => void>>();
  const busSubscriptions: EventSubscription[] = [];
  const stateWatches = new Set<EventSubscription>();

  for (const definition of events) {
    definitions.set(definition.id, definition);
    busSubscriptions.push(
      host.subscribeEvent(BRIDGE_SOURCE, definition, (envelope) => {
        latest.set(definition.id, envelope);
        for (const listener of [...(listeners.get(definition.id) ?? [])]) {
          listener(envelope);
        }
      }),
    );
  }

  const refuse = (eventId: string, direction: 'subscribe to' | 'publish'): never => {
    throw new RidrsError(
      'event-not-allowed',
      `No started UI plugin declares the right to ${direction} "${eventId}"`,
    );
  };

  return {
    registry: () => host.getUiRegistry(),

    onRegistryChanged(listener): Unsubscribe {
      const subscription = host.subscribeEvent(BRIDGE_SOURCE, uiRegistryChangedEvent, () =>
        listener(host.getUiRegistry()),
      );
      return () => subscription.unsubscribe();
    },

    subscribe(eventId, listener): Unsubscribe {
      if (!host.getUiRegistry().events.subscribe.includes(eventId) || !definitions.has(eventId)) {
        refuse(eventId, 'subscribe to');
      }
      let set = listeners.get(eventId);
      if (!set) {
        set = new Set();
        listeners.set(eventId, set);
      }
      set.add(listener);
      const cached = latest.get(eventId);
      if (cached) {
        listener(cached);
      }
      return () => {
        set.delete(listener);
      };
    },

    publish(eventId, payload): void {
      const definition = definitions.get(eventId);
      if (!host.getUiRegistry().events.publish.includes(eventId) || !definition) {
        refuse(eventId, 'publish');
        return;
      }
      host.publishEvent(BRIDGE_SOURCE, definition, payload);
    },

    watchState(topicId, listener): Unsubscribe {
      if (!host.getUiRegistry().state.includes(topicId)) {
        throw new RidrsError(
          'state-not-allowed',
          `No started UI plugin declares the right to watch "${topicId}"`,
        );
      }
      let snapshot = true;
      const watch = host.watchState(BRIDGE_SOURCE, topicId, ({ entries, changed }) => {
        const values: Record<string, unknown> = {};
        const removed: string[] = [];
        for (const key of changed) {
          if (entries.has(key)) {
            values[key] = entries.get(key);
          } else {
            removed.push(key);
          }
        }
        const update: StateUpdate = { snapshot, values, removed };
        snapshot = false;
        listener(update);
      });
      stateWatches.add(watch);
      return () => {
        stateWatches.delete(watch);
        watch.unsubscribe();
      };
    },

    async call(serviceId, request) {
      if (!host.getUiRegistry().calls.includes(serviceId)) {
        throw new RidrsError(
          'call-not-allowed',
          `No started UI plugin declares the right to call "${serviceId}"`,
        );
      }
      return host.callService(serviceId, request, { pluginId: BRIDGE_SOURCE });
    },

    async loadModule(pluginId) {
      return (await host.loadClientModule(pluginId)) as Record<string, unknown>;
    },

    reportClientError(pluginId, message): void {
      host.reportDiagnostic({
        code: 'client-load-failure',
        pluginId,
        message: `UI client of plugin "${pluginId}" failed: ${message}`,
      });
    },

    now: () => host.now(),

    settings: (pluginId) => host.getClientSettings(pluginId),

    dispose(): void {
      for (const subscription of busSubscriptions.splice(0)) {
        subscription.unsubscribe();
      }
      for (const watch of stateWatches) {
        watch.unsubscribe();
      }
      stateWatches.clear();
      listeners.clear();
      latest.clear();
    },
  };
}
