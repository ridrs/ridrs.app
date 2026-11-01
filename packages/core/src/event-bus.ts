// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from 'node:crypto';
import {
  type Clock,
  type EventDefinition,
  type EventEnvelope,
  type EventHandler,
  type EventSubscription,
  type PluginEventsContext,
  RidrsError,
} from '@ridrs/contracts';
import { queueScheduler, Subject, type Subscription } from 'rxjs';
import { z } from 'zod';
import type { DiagnosticCollector } from './diagnostics.ts';

export class EventBus {
  private readonly subjects = new Map<string, Subject<EventEnvelope>>();
  private readonly pluginSubscriptions = new Map<string, Set<Subscription>>();
  private readonly clock: Clock;
  private readonly diagnostics: DiagnosticCollector;
  private readonly canPluginPublish: (pluginId: string) => boolean;

  constructor(options: {
    clock: Clock;
    diagnostics: DiagnosticCollector;
    canPluginPublish: (pluginId: string) => boolean;
  }) {
    this.clock = options.clock;
    this.diagnostics = options.diagnostics;
    this.canPluginPublish = options.canPluginPublish;
  }

  createPluginEventsContext(pluginId: string): PluginEventsContext {
    return {
      publish: <TPayload, TType extends string>(
        event: EventDefinition<TPayload, TType>,
        payload: TPayload,
      ): void => {
        if (!this.canPluginPublish(pluginId)) {
          throw new RidrsError(
            'plugin-not-active',
            `Plugin "${pluginId}" cannot publish event "${event.id}" because it is not started`,
            { pluginId },
          );
        }
        this.publishFromSource(pluginId, event, payload);
      },

      subscribe: <TPayload, TType extends string>(
        event: EventDefinition<TPayload, TType>,
        handler: EventHandler<TPayload, TType>,
      ): EventSubscription => {
        return this.subscribeForPlugin(pluginId, event, handler);
      },
    };
  }

  publishSystemEvent<TPayload, TType extends string>(
    source: string,
    event: EventDefinition<TPayload, TType>,
    payload: TPayload,
  ): void {
    this.publishFromSource(source, event, payload);
  }

  private publishFromSource<TPayload, TType extends string>(
    source: string,
    event: EventDefinition<TPayload, TType>,
    payload: TPayload,
  ): void {
    const parsed = event.schema.safeParse(payload);
    if (!parsed.success) {
      const pretty = z.prettifyError(parsed.error);
      throw new RidrsError(
        'invalid-event-payload',
        `Invalid payload for event "${event.id}" from "${source}": ${pretty}`,
        { pluginId: source },
      );
    }

    const envelope: EventEnvelope<TPayload, TType> = Object.freeze({
      id: randomUUID(),
      type: event.id,
      payload: parsed.data,
      source,
      timestamp: this.clock.now(),
    });

    queueScheduler.schedule(() => {
      const subject = this.subjects.get(event.id);
      if (subject) {
        subject.next(envelope);
      }
    });
  }

  private subscribeForPlugin<TPayload, TType extends string>(
    pluginId: string,
    event: EventDefinition<TPayload, TType>,
    handler: EventHandler<TPayload, TType>,
  ): EventSubscription {
    let subject = this.subjects.get(event.id);
    if (!subject) {
      subject = new Subject<EventEnvelope>();
      this.subjects.set(event.id, subject);
    }

    let pluginSubs = this.pluginSubscriptions.get(pluginId);
    if (!pluginSubs) {
      pluginSubs = new Set<Subscription>();
      this.pluginSubscriptions.set(pluginId, pluginSubs);
    }

    const rxSubscription = subject.subscribe((envelope) => {
      try {
        handler(envelope as EventEnvelope<TPayload, TType>);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.diagnostics.report({
          code: 'event-handler-failure',
          pluginId,
          message: `Subscriber "${pluginId}" failed while handling event "${event.id}": ${reason}`,
          details: { eventType: event.id },
        });
      }
    });

    pluginSubs.add(rxSubscription);
    rxSubscription.add(() => {
      const currentSubs = this.pluginSubscriptions.get(pluginId);
      if (currentSubs) {
        currentSubs.delete(rxSubscription);
        if (currentSubs.size === 0) {
          this.pluginSubscriptions.delete(pluginId);
        }
      }
    });

    return {
      unsubscribe(): void {
        rxSubscription.unsubscribe();
      },
    };
  }

  removeSubscriptionsForPlugin(pluginId: string): void {
    const subs = this.pluginSubscriptions.get(pluginId);
    if (!subs) {
      return;
    }
    for (const sub of [...subs]) {
      sub.unsubscribe();
    }
    this.pluginSubscriptions.delete(pluginId);
  }

  removeAllSubscriptions(): void {
    for (const pluginId of [...this.pluginSubscriptions.keys()]) {
      this.removeSubscriptionsForPlugin(pluginId);
    }
  }

  getSubscriptionCount(pluginId?: string): number {
    if (pluginId !== undefined) {
      return this.pluginSubscriptions.get(pluginId)?.size ?? 0;
    }
    let total = 0;
    for (const subs of this.pluginSubscriptions.values()) {
      total += subs.size;
    }
    return total;
  }
}
