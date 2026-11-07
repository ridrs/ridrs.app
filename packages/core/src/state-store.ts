// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type Diagnostic,
  type EventSubscription,
  RidrsError,
  type StateDefinition,
  type StateView,
} from '@ridrs/contracts';

/** Sees every write as it happens: a removed key comes with `undefined`. */
export type StateObserver = (topicId: string, key: string, value: unknown, ownerId: string) => void;

interface Entry {
  readonly owner: string;
  readonly value: unknown;
}

interface Topic {
  readonly definition: StateDefinition;
  readonly entries: Map<string, Entry>;
}

interface Watcher {
  readonly owner: string;
  readonly topicId: string;
  readonly listener: (view: StateView<unknown>) => void;
  /** Until its first delivery, which is the snapshot. */
  snapshot: boolean;
  readonly pending: Set<string>;
}

export interface StateStoreOptions {
  readonly report: (diagnostic: Diagnostic) => void;
}

/**
 * App state beside the bus (ADR 0068): registered topics, values by key with one owner each,
 * validated on write. Watchers get the snapshot, then the changed keys, coalesced by one
 * microtask per tick: never inside a turn, never recorded. Knows no topic.
 */
export class StateStore {
  private readonly topics = new Map<string, Topic>();
  private readonly watchers = new Set<Watcher>();
  private readonly observers = new Map<StateObserver, string>();
  private flushQueued = false;
  /** The watcher whose listener runs right now. */
  private delivering: Watcher | undefined;
  private readonly feedbackReported = new Set<string>();

  constructor(private readonly options: StateStoreOptions) {}

  register(definitions: Iterable<StateDefinition>): void {
    for (const definition of definitions) {
      if (!this.topics.has(definition.id)) {
        this.topics.set(definition.id, { definition, entries: new Map() });
      }
    }
  }

  topicIds(): readonly string[] {
    return [...this.topics.keys()];
  }

  private topic(topicId: string): Topic {
    const topic = this.topics.get(topicId);
    if (!topic) {
      throw new RidrsError('unknown-state', `No app state topic "${topicId}" is registered`);
    }
    return topic;
  }

  private assertOwner(topicId: string, key: string, entry: Entry | undefined, owner: string): void {
    if (entry && entry.owner !== owner) {
      throw new RidrsError(
        'state-key-owned',
        `Plugin "${owner}" cannot write "${topicId}" "${key}": plugin "${entry.owner}" owns it`,
        { pluginId: owner },
      );
    }
  }

  /** Validated once, whoever watches; the first writer of a key owns it. */
  set(owner: string, topicId: string, key: string, value: unknown): void {
    const topic = this.topic(topicId);
    const entry = topic.entries.get(key);
    this.assertOwner(topicId, key, entry, owner);
    const parsed = topic.definition.schema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(value)'}: ${issue.message}`)
        .join('; ');
      throw new RidrsError(
        'invalid-state-value',
        `Invalid value for "${topicId}" "${key}" from "${owner}": ${issues}`,
        { pluginId: owner },
      );
    }
    if (this.delivering?.owner === owner && this.delivering.topicId === topicId) {
      this.reportFeedback(owner, topicId);
    }
    topic.entries.set(key, { owner, value: parsed.data });
    this.changed(topicId, key, parsed.data, owner);
  }

  /** Only the owner; a missing key is not an error. */
  remove(owner: string, topicId: string, key: string): void {
    const topic = this.topic(topicId);
    const entry = topic.entries.get(key);
    if (!entry) {
      return;
    }
    this.assertOwner(topicId, key, entry, owner);
    topic.entries.delete(key);
    this.changed(topicId, key, undefined, owner);
  }

  get(topicId: string, key: string): unknown {
    return this.topic(topicId).entries.get(key)?.value;
  }

  entries(topicId: string): ReadonlyMap<string, unknown> {
    return new Map(
      [...this.topic(topicId).entries].map(([key, entry]) => [key, entry.value] as const),
    );
  }

  ownerOf(topicId: string, key: string): string | undefined {
    return this.topics.get(topicId)?.entries.get(key)?.owner;
  }

  /** The first delivery is the snapshot, in the next flush. */
  watch(
    owner: string,
    topicId: string,
    listener: (view: StateView<unknown>) => void,
  ): EventSubscription {
    this.topic(topicId);
    const watcher: Watcher = { owner, topicId, listener, snapshot: true, pending: new Set() };
    this.watchers.add(watcher);
    this.queueFlush();
    return { unsubscribe: () => this.watchers.delete(watcher) };
  }

  /** Every write as it happens, read-only (composition roots, tests). */
  observe(owner: string, observer: StateObserver): EventSubscription {
    this.observers.set(observer, owner);
    return { unsubscribe: () => this.observers.delete(observer) };
  }

  /** A stopped plugin: its watches and observations end, its keys are removed. */
  releasePlugin(pluginId: string): void {
    for (const watcher of [...this.watchers]) {
      if (watcher.owner === pluginId) {
        this.watchers.delete(watcher);
      }
    }
    for (const [observer, owner] of [...this.observers]) {
      if (owner === pluginId) {
        this.observers.delete(observer);
      }
    }
    for (const [topicId, topic] of this.topics) {
      for (const [key, entry] of [...topic.entries]) {
        if (entry.owner === pluginId) {
          topic.entries.delete(key);
          this.changed(topicId, key, undefined, pluginId);
        }
      }
    }
  }

  private changed(topicId: string, key: string, value: unknown, owner: string): void {
    for (const [observer] of [...this.observers]) {
      observer(topicId, key, value, owner);
    }
    for (const watcher of this.watchers) {
      if (watcher.topicId === topicId) {
        watcher.pending.add(key);
      }
    }
    this.queueFlush();
  }

  private queueFlush(): void {
    if (this.flushQueued) {
      return;
    }
    this.flushQueued = true;
    queueMicrotask(() => this.flush());
  }

  /** Writes made while it delivers go to the next flush. */
  private flush(): void {
    this.flushQueued = false;
    // Every view of this flush is taken before the first listener runs.
    const views = new Map<string, ReadonlyMap<string, unknown>>();
    const due = [...this.watchers]
      .filter((w) => w.snapshot || w.pending.size > 0)
      .map((watcher) => {
        let entries = views.get(watcher.topicId);
        if (!entries) {
          entries = this.entries(watcher.topicId);
          views.set(watcher.topicId, entries);
        }
        const changed = watcher.snapshot ? [...entries.keys()] : [...watcher.pending];
        watcher.snapshot = false;
        watcher.pending.clear();
        return { watcher, entries, changed };
      });
    for (const { watcher, entries, changed } of due) {
      if (!this.watchers.has(watcher)) {
        continue;
      }
      this.delivering = watcher;
      try {
        watcher.listener({ entries, changed });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.options.report({
          code: 'event-handler-failure',
          pluginId: watcher.owner,
          message: `A watcher of "${watcher.topicId}" failed: ${reason}`,
          details: { topic: watcher.topicId },
        });
      } finally {
        this.delivering = undefined;
      }
    }
  }

  private reportFeedback(owner: string, topicId: string): void {
    const id = `${owner}|${topicId}`;
    if (this.feedbackReported.has(id)) {
      return;
    }
    this.feedbackReported.add(id);
    this.options.report({
      code: 'state-feedback',
      pluginId: owner,
      message: `Plugin "${owner}" writes "${topicId}" while it receives it: its writes arrive in the next delivery`,
      details: { topic: topicId },
    });
  }
}
