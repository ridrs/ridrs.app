// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PluginSettingsContext, ScopedSettings, SettingsDocument } from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { useCallback, useSyncExternalStore } from 'react';

/** Reads the value and changes it; every change is kept at once, without a Save. */
export type UseUserDocument<T> = (
  ctx: UiContext,
) => readonly [T, (change: (current: T) => T) => void];

interface Store<T> {
  value: T;
  /** Set by the first change: a read that ends later leaves the value alone. */
  changed: boolean;
  readonly settings: ScopedSettings<T>;
  readonly listeners: Set<() => void>;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * One user settings document of a plugin, shared by all components of its client module (a
 * screen and its tile on Today see the same value at once). Created once at module level; every
 * change is written right away (ADR 0059).
 *
 * A module is imported once and outlives its plugin's host (a restart of ridrs in one process,
 * the next test scenario). So the value is kept per settings access of the host (`ctx.settings`,
 * one per plugin and host): read once from the host's files, `initial` until then and without one.
 */
export function userDocument<T>(document: SettingsDocument<T>, initial: T): UseUserDocument<T> {
  const stores = new WeakMap<PluginSettingsContext, Store<T>>();

  const storeOf = (ctx: UiContext): Store<T> => {
    const access = ctx.settings;
    let store = stores.get(access);
    if (!store) {
      const listeners = new Set<() => void>();
      const created: Store<T> = {
        value: initial,
        changed: false,
        settings: access.user(document),
        listeners,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
      store = created;
      stores.set(access, created);
      created.settings.read().then(
        (stored) => {
          if (stored !== undefined && !created.changed) set(created, stored);
        },
        (error: unknown) => ctx.logger.warn(`Could not read "${document.name}": ${String(error)}`),
      );
    }
    return store;
  };

  const set = (store: Store<T>, next: T) => {
    store.value = next;
    for (const listener of [...store.listeners]) listener();
  };

  return (ctx) => {
    const store = storeOf(ctx);
    const current = useSyncExternalStore(store.subscribe, () => store.value);
    const change = useCallback(
      (update: (current: T) => T) => {
        store.changed = true;
        const next = update(store.value);
        set(store, next);
        store.settings
          .write(next)
          .catch((error: unknown) =>
            ctx.logger.warn(`Could not keep "${document.name}": ${String(error)}`),
          );
      },
      [ctx, store],
    );
    return [current, change] as const;
  };
}
