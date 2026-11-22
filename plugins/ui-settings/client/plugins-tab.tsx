// SPDX-License-Identifier: AGPL-3.0-or-later

import { type PluginEntry, pluginsRemoveService, pluginsSetEnabledService, pluginsState } from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { useState } from 'react';
import { messages } from './i18n/index.ts';

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Settings › Plugins (ADR 0106): every plugin of the app and every installed one, with a switch for
 * the next start; an installed one can be removed. A change says it takes effect at the next start,
 * and Reload starts the app anew. Off the ride path: pointer and keyboard as the controls give it.
 */
export function PluginsTab({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages).plugins;
  const entries = [...useStateEntries(ctx, pluginsState).values()];
  const [refusal, setRefusal] = useState<string>();
  const call = (run: () => Promise<unknown>) => {
    setRefusal(undefined);
    run().catch((error: unknown) => setRefusal(reasonOf(error)));
  };
  // A plugin whose switch differs from what runs now, or one installed or removed since the start.
  const pending = entries.some((entry) => entry.enabled !== entry.running);
  const row = (entry: PluginEntry) => (
    <li key={entry.id} className="pv-row" style={{ alignItems: 'center', gap: 12 }}>
      <button
        type="button"
        className="pv-chip"
        aria-pressed={entry.enabled}
        disabled={entry.locked}
        onClick={() => call(() => ctx.call(pluginsSetEnabledService, { key: entry.id, enabled: !entry.enabled }))}
      >
        {entry.name}
      </button>
      <span className="pv-muted">
        {[
          entry.version,
          entry.origin === 'installed' ? text.installed : text.bundled,
          entry.locked ? text.locked : '',
          entry.enabled !== entry.running ? (entry.enabled ? text.startsNext : text.stopsNext) : '',
          entry.neededBy.length > 0 ? text.neededBy(entry.neededBy.join(', ')) : '',
          entry.programs.length > 0 ? text.programs(entry.programs.join(', ')) : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {entry.origin === 'installed' ? (
        <button
          type="button"
          className="pv-button"
          aria-label={text.removeOf(entry.name)}
          onClick={() => call(() => ctx.call(pluginsRemoveService, { key: entry.id }))}
        >
          {text.remove}
        </button>
      ) : null}
    </li>
  );
  return (
    <section className="pv-section">
      <p className="pv-muted">{text.intro}</p>
      {pending ? (
        <div className="pv-row" role="status">
          <span>{text.pending}</span>
          <button type="button" className="pv-button" onClick={() => window.location.reload()}>
            {text.reload}
          </button>
        </div>
      ) : null}
      {refusal ? <p role="alert">{refusal}</p> : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {entries.map(row)}
      </ul>
    </section>
  );
}
