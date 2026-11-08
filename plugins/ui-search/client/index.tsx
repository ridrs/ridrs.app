// SPDX-License-Identifier: AGPL-3.0-or-later

import { ActionButton, AreaPage, reactComponent, Toggle, useBack, userDocument } from '@ridrs/ui-preview';
import type { UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { CATALOGUE, type Result, type ResultKind, search } from './catalogue.ts';
import { messages } from './i18n/index.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as a mask in the text colour. */
const SEARCH = new URL('./assets/icons/search.svg', import.meta.url).href;

const CSS = `
.se-field { width: 100%; max-width: 640px; min-height: 48px; padding: 10px 16px;
  border: 1px solid var(--ridrs-line, #24324d); border-radius: 12px;
  background: var(--ridrs-surface, #131c2e); color: var(--ridrs-text, #f2f5fa); font: 16px system-ui, sans-serif; }
.se-field:focus-visible { outline: 3px solid var(--ridrs-focus, #fff); outline-offset: 2px; }
.se-results { display: flex; flex-direction: column; gap: 8px; max-width: 640px; }
.se-results .pv-open { padding: 12px 16px; border: 1px solid var(--ridrs-line, #24324d); border-radius: 12px;
  background: var(--ridrs-surface, #131c2e); }
`;

const KINDS: readonly ResultKind[] = ['route', 'workout', 'event'];

/** The chosen kinds and the last searches that led somewhere, kept at once (ADR 0059). */
const useSearch = userDocument(
  {
    name: 'preview',
    version: 1,
    schema: z
      .object({ kinds: z.array(z.enum(['route', 'workout', 'event'])), recent: z.array(z.string()).max(5) })
      .strict(),
  },
  { kinds: [] as ResultKind[], recent: [] as string[] },
);

function SearchView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const [state, change] = useSearch(ctx);
  const [query, setQuery] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  useBack(ctx);
  const results = search(CATALOGUE, query, state.kinds);
  const open = (result: Result) => {
    const kept = query.trim();
    change((s) => ({ ...s, recent: [kept, ...s.recent.filter((q) => q !== kept)].slice(0, 5) }));
    ctx.navigate(result.screen);
  };

  return (
    <AreaPage title={text.title} intro={text.intro}>
      <style>{CSS}</style>
      <input
        ref={field}
        type="search"
        className="se-field"
        aria-label={text.field}
        placeholder={text.placeholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="pv-row" aria-label={text.kinds}>
        {KINDS.map((kind) => (
          <Toggle
            key={kind}
            label={text.kindsPlural[kind]}
            on={state.kinds.includes(kind)}
            onChange={(on) =>
              change((s) => ({ ...s, kinds: on ? [...s.kinds, kind] : s.kinds.filter((k) => k !== kind) }))
            }
          />
        ))}
      </div>
      <p className="pv-muted">{text.later}</p>
      <div className="se-results" data-testid="search-results">
        {results.map((result) => (
          <button
            key={result.name}
            type="button"
            className="pv-open"
            aria-label={result.name}
            onClick={() => open(result)}
          >
            <strong>{result.name}</strong>
            <span className="pv-muted">
              {text.kindSingular[result.kind]} · {text.details[result.name] ?? result.detail}
            </span>
          </button>
        ))}
        {query.trim() !== '' && results.length === 0 ? <p className="pv-muted">{text.nothing}</p> : null}
      </div>
      {query.trim() === '' && state.recent.length > 0 ? (
        <section className="pv-section">
          <h2>{text.recent}</h2>
          <div className="pv-row">
            {state.recent.map((recent) => (
              <button key={recent} type="button" className="pv-chip" onClick={() => setQuery(recent)}>
                {recent}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </AreaPage>
  );
}

export const SearchScreen = reactComponent((ctx) => <SearchView ctx={ctx} />);
function SearchActionView({ ctx }: { readonly ctx: UiContext }) {
  return <ActionButton ctx={ctx} screen="search" label={useMessages(ctx, messages).title} icon={SEARCH} />;
}

export const SearchAction = reactComponent((ctx) => <SearchActionView ctx={ctx} />);
