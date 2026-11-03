// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type Clock,
  type EventDefinition,
  type EventEnvelope,
  type EventHandler,
  type EventSubscription,
  type HostObserver,
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
  /** Whether publishing happens inside a turn (or a lifecycle phase) right now. */
  private readonly inTurn: () => boolean;
  /** A publish outside a turn: the host queues it as an input or refuses it. */
  private readonly outsideTurn: (source: string, event: EventDefinition, payload: unknown) => void;
  private readonly runId: string;
  private seq = 0;
  /** Per source: the logical time of its last envelope and how many it published then. */
  private readonly idCounters = new Map<string, { at: number; count: number }>();
  /** Host-level taps, called at publish time in global publish order (see `observe`). */
  private readonly observers: Array<{ readonly owner: string; readonly observer: HostObserver }> =
    [];
  /** Set while an observer runs: observers are read-only. */
  private observing = false;

  constructor(options: {
    clock: Clock;
    diagnostics: DiagnosticCollector;
    canPluginPublish: (pluginId: string) => boolean;
    /** Default: always in a turn (a bus without a host). */
    inTurn?: () => boolean;
    outsideTurn?: (source: string, event: EventDefinition, payload: unknown) => void;
    /** Root of every envelope id. */
    runId?: string;
  }) {
    this.clock = options.clock;
    this.diagnostics = options.diagnostics;
    this.canPluginPublish = options.canPluginPublish;
    this.inTurn = options.inTurn ?? (() => true);
    this.outsideTurn =
      options.outsideTurn ??
      ((source, event, payload) => this.publishFromSource(source, event, payload));
    this.runId = options.runId ?? 'run';
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
        if (this.inTurn()) {
          this.publishFromSource(pluginId, event, payload);
        } else {
          this.outsideTurn(pluginId, event as EventDefinition, payload);
        }
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

  /**
   * Publishes an accepted external input in its own turn. `id` keeps a recorded input's id on
   * replay; live inputs get `<runId>:in:<n>`.
   */
  publishInput<TPayload, TType extends string>(
    source: string,
    event: EventDefinition<TPayload, TType>,
    payload: TPayload,
    meta: { readonly inputSeq: number; readonly receivedAt: number; readonly id?: string },
  ): void {
    this.publishFromSource(source, event, payload, {
      id: meta.id ?? `${this.runId}:in:${meta.inputSeq}`,
      input: true,
      receivedAt: meta.receivedAt,
    });
  }

  /** Throws like a publish would, before an input is queued. */
  validate<TPayload, TType extends string>(
    source: string,
    event: EventDefinition<TPayload, TType>,
    payload: TPayload,
  ): TPayload {
    const parsed = event.schema.safeParse(payload);
    if (!parsed.success) {
      const pretty = z.prettifyError(parsed.error);
      throw new RidrsError(
        'invalid-event-payload',
        `Invalid payload for event "${event.id}" from "${source}": ${pretty}`,
        { pluginId: source },
      );
    }
    return parsed.data;
  }

  /**
   * `<runId>:<source>:<logical time>:<k>`: unique within the run, and the same on replay whenever
   * the source publishes the same events at the same logical times.
   */
  private nextId(source: string, at: number): string {
    const counter = this.idCounters.get(source);
    const count = counter?.at === at ? counter.count + 1 : 0;
    this.idCounters.set(source, { at, count });
    return `${this.runId}:${source}:${at}:${count}`;
  }

  /**
   * Subscription owned by the host or its composition root rather than a plugin; it is not released
   * when plugins stop, only through the returned handle.
   */
  subscribeSystem<TPayload, TType extends string>(
    owner: string,
    event: EventDefinition<TPayload, TType>,
    handler: EventHandler<TPayload, TType>,
  ): EventSubscription {
    let subject = this.subjects.get(event.id);
    if (!subject) {
      subject = new Subject<EventEnvelope>();
      this.subjects.set(event.id, subject);
    }
    const rxSubscription = subject.subscribe((envelope) => {
      try {
        handler(envelope as EventEnvelope<TPayload, TType>);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.diagnostics.report({
          code: 'event-handler-failure',
          message: `Subscriber "${owner}" failed while handling event "${event.id}": ${reason}`,
          details: { eventType: event.id, owner },
        });
      }
    });
    return { unsubscribe: () => rxSubscription.unsubscribe() };
  }

  /**
   * Sees every envelope synchronously at publish time, before queued delivery: the one global
   * order of the bus, including events published from within handlers.
   */
  observe(owner: string, observer: HostObserver): EventSubscription {
    const entry = { owner, observer };
    this.observers.push(entry);
    return {
      unsubscribe: () => {
        const index = this.observers.indexOf(entry);
        if (index >= 0) {
          this.observers.splice(index, 1);
        }
      },
    };
  }

  private notifyObservers(envelope: EventEnvelope): void {
    this.observing = true;
    try {
      for (const { owner, observer } of [...this.observers]) {
        try {
          observer.onEvent?.(envelope);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.diagnostics.report({
            code: 'event-handler-failure',
            message: `Host observer "${owner}" failed while observing event "${envelope.type}": ${reason}`,
            details: { eventType: envelope.type, owner },
          });
        }
      }
    } finally {
      this.observing = false;
    }
  }

  private publishFromSource<TPayload, TType extends string>(
    source: string,
    event: EventDefinition<TPayload, TType>,
    payload: TPayload,
    input?: { readonly id: string; readonly input: true; readonly receivedAt: number },
  ): void {
    if (this.observing) {
      throw new RidrsError(
        'event-not-allowed',
        `Event "${event.id}" cannot be published from a host observer: observers are read-only`,
        { pluginId: source },
      );
    }
    const data = this.validate(source, event, payload);
    const timestamp = this.clock.now();
    this.seq += 1;
    const envelope: EventEnvelope<TPayload, TType> = Object.freeze({
      id: input?.id ?? this.nextId(source, timestamp),
      type: event.id,
      payload: data,
      source,
      timestamp,
      seq: this.seq,
      ...(input ? { input: input.input, receivedAt: input.receivedAt } : {}),
    });

    this.notifyObservers(envelope);
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
