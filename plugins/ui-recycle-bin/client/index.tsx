// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BinnedItem,
  carries,
  DRAG_REMOVABLE,
  type Removable,
  readDragged,
  removableSchema,
  type TrashItem,
  trainingCalendarState,
  trainingHistoryState,
  trashItemState,
  trashPurgeService,
  trashPutService,
  trashRestoreService,
} from '@ridrs/contracts';
import { iconStyle, PREVIEW_CSS, reactComponent, useBack } from '@ridrs/ui-preview';
import type { UiContext } from '@ridrs/ui-sdk';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { useEffect, useRef, useState } from 'react';
import { messages } from './i18n/index.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as a mask in the text colour. */
const TRASH = new URL('./assets/icons/trash-2.svg', import.meta.url).href;

/** The bin's page in the content area. */
const PAGE = 'trash';

/**
 * The bin follows the menu's item contract (ADR 0058) and adds a count and, while something it
 * takes is dragged, a hint beside it. It is the drop target itself: the menu is beside every page.
 */
const ENTRY_CSS = `
[data-recycle-bin] { position: relative; }
[data-recycle-bin] [data-bin-count] { margin-left: auto; min-width: 22px; padding: 1px 7px; border-radius: 999px;
  background: var(--ridrs-surface-2, #1c2840); color: var(--ridrs-text, #f2f5fa); font: 600 12px system-ui, sans-serif;
  text-align: center; }
[data-recycle-bin][data-armed] { outline: 2px dashed var(--ridrs-danger, #ff4d6d); outline-offset: -2px; }
[data-recycle-bin][data-over] { outline-style: solid; background: rgb(70 18 30 / .96); }
[data-recycle-bin] [data-bin-hint] { position: absolute; left: calc(100% + 12px); top: 50%; z-index: 1000;
  transform: translateY(-50%); padding: 8px 12px; border-radius: 10px; white-space: nowrap;
  background: rgb(70 18 30 / .96); color: #fff; font: 500 14px system-ui, sans-serif; pointer-events: none; }
[data-breakpoint="medium"] [data-recycle-bin] [data-bin-count] { position: absolute; top: 2px; right: 2px; margin: 0; }
[data-breakpoint="compact"] [data-recycle-bin] [data-bin-count] { position: absolute; top: 0; right: 8px; margin: 0; }
[data-breakpoint="compact"] [data-recycle-bin] [data-bin-hint] { left: 50%; top: auto; bottom: calc(100% + 8px);
  transform: translateX(-50%); }
`;

/** What a drag carries for the bin, read on its start: the data store can be read then. */
function removableOf(event: DragEvent): Removable | undefined {
  return carries(event.dataTransfer, DRAG_REMOVABLE)
    ? readDragged(event.dataTransfer, DRAG_REMOVABLE, removableSchema)
    : undefined;
}

function BinEntryView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const count = useStateEntries(ctx, trashItemState).size;
  // Marked as the page while it is shown, also under a dialog (ADR 0071).
  const [page, setPage] = useState<string>();
  useEffect(() => ctx.onNavigated((_, shownPage) => setPage(shownPage)), [ctx]);
  // What is dragged anywhere in the window, while it is something the bin takes.
  const [dragged, setDragged] = useState<Removable['kind']>();
  const [over, setOver] = useState(false);
  useEffect(() => {
    const start = (event: DragEvent) => setDragged(removableOf(event)?.kind);
    const end = () => {
      setDragged(undefined);
      setOver(false);
    };
    document.addEventListener('dragstart', start);
    document.addEventListener('dragend', end);
    document.addEventListener('drop', end);
    return () => {
      document.removeEventListener('dragstart', start);
      document.removeEventListener('dragend', end);
      document.removeEventListener('drop', end);
    };
  }, []);

  return (
    <button
      type="button"
      data-menu-item
      data-recycle-bin
      data-count={count}
      data-armed={dragged ? 'true' : undefined}
      data-over={over || undefined}
      aria-current={page === PAGE ? 'page' : undefined}
      aria-description={count > 0 ? text.items(count) : undefined}
      onClick={() => ctx.navigate(PAGE)}
      onDragOver={(event) => {
        if (!carries(event.dataTransfer, DRAG_REMOVABLE)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        const item = readDragged(event.dataTransfer, DRAG_REMOVABLE, removableSchema);
        if (!item) return;
        event.preventDefault();
        setOver(false);
        // Its source takes it away itself, seeing the move on `dragend`; the bin keeps nothing.
        if (item.kind === 'dismissed') return;
        ctx
          .call(trashPutService, { item })
          .catch((error: unknown) => ctx.logger.warn(`Could not put into the bin: ${String(error)}`));
      }}
    >
      <style>{ENTRY_CSS}</style>
      <span data-menu-icon aria-hidden="true" style={iconStyle(TRASH)} />
      <span data-menu-label>{text.bin}</span>
      {count > 0 ? (
        <span data-bin-count aria-hidden="true">
          {count}
        </span>
      ) : null}
      {dragged ? (
        <span data-bin-hint aria-hidden="true">
          {dragged === 'done-ride' ? text.dropToDeleteRide : text.dropToRemove}
        </span>
      ) : null}
    </button>
  );
}

export const BinEntry = reactComponent((ctx) => <BinEntryView ctx={ctx} />);

const PAGE_CSS = `
.rb-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.rb-item { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 16px; border-radius: 12px;
  background: var(--ridrs-surface, #131c2e); }
.rb-item-text { display: flex; flex-direction: column; gap: 2px; flex: 1 1 220px; min-width: 0; }
.rb-item-text strong { overflow-wrap: anywhere; }
.rb-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.rb-danger { color: var(--ridrs-danger, #ff4d6d); }
.rb-refusal { flex-basis: 100%; margin: 0; color: var(--ridrs-danger, #ff4d6d); }
.rb-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.rb-ask { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--ridrs-danger, #ff4d6d);
  border-radius: 12px; background: var(--ridrs-surface, #131c2e); }
.rb-ask p { margin: 0; }
`;

/** What the page asks before deleting: one item, or all of them. */
type Ask = { readonly key: string } | { readonly all: true };

function BinPageView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const bin = useStateEntries(ctx, trashItemState);
  const calendars = useStateEntries(ctx, trainingCalendarState);
  const histories = useStateEntries(ctx, trainingHistoryState);
  const [ask, setAsk] = useState<Ask>();
  // Why an item is still in the bin after a deletion, by its key.
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(new Map());
  const askRef = useRef(ask);
  askRef.current = ask;
  // Back closes the question first, then leaves the page.
  useBack(ctx, () => {
    if (askRef.current === undefined) return false;
    setAsk(undefined);
    return true;
  });

  const items = [...bin.entries()]
    .filter((entry): entry is [string, TrashItem] => entry[1] !== undefined)
    .sort(([, a], [, b]) => b.binnedAt - a.binnedAt);
  const planned = items.filter(([, each]) => each.item.kind === 'calendar-entry');
  const done = items.filter(([, each]) => each.item.kind === 'done-ride');

  const labelOf = (provider: string) =>
    calendars.get(provider)?.label ?? histories.get(provider)?.label ?? provider;
  const providersOf = (item: BinnedItem) =>
    item.kind === 'calendar-entry' ? [item.provider] : item.removals.map((each) => each.provider);
  const titleOf = (item: BinnedItem) => item.title || item.date;
  const day = new Intl.DateTimeFormat(text.dateLocale, { weekday: 'short', day: 'numeric', month: 'short' });
  const dateOf = (date: string) => {
    const [year, month, dayOfMonth] = date.split('-').map(Number);
    return day.format(new Date(year ?? 1970, (month ?? 1) - 1, dayOfMonth ?? 1));
  };

  const purge = (key: string | undefined) => {
    setAsk(undefined);
    ctx.call(trashPurgeService, key === undefined ? {} : { key }).then(
      ({ failed }) => {
        const next = new Map<string, string>();
        for (const failure of failed) {
          if (!next.has(failure.key)) next.set(failure.key, text.refused(labelOf(failure.provider), failure.reason));
        }
        setRefusals(next);
      },
      (error: unknown) => ctx.logger.warn(`Could not delete from the bin: ${String(error)}`),
    );
  };
  const restore = (key: string) => {
    ctx
      .call(trashRestoreService, { key })
      .catch((error: unknown) => ctx.logger.warn(`Could not restore from the bin: ${String(error)}`));
  };

  const asked = ask && 'key' in ask ? bin.get(ask.key) : undefined;
  const question =
    ask === undefined
      ? undefined
      : 'all' in ask
        ? text.askAll(items.length)
        : asked
          ? text.askOne(titleOf(asked.item), text.and(providersOf(asked.item).map(labelOf)))
          : undefined;

  const list = (heading: string, entries: readonly (readonly [string, TrashItem])[]) =>
    entries.length === 0 ? null : (
      <section className="pv-section" aria-label={heading}>
        <h2>{heading}</h2>
        <ul className="rb-list">
          {entries.map(([key, { item, binnedAt }]) => (
            <li key={key} className="rb-item" data-bin-item={key}>
              <div className="rb-item-text">
                <strong data-bin-title>{titleOf(item)}</strong>
                <span className="pv-muted">
                  {[dateOf(item.date), text.and(providersOf(item).map(labelOf))].join(' · ')}
                </span>
                <span className="pv-muted">{text.binnedOn(day.format(new Date(binnedAt)))}</span>
              </div>
              <div className="rb-actions">
                <button
                  type="button"
                  className="pv-button"
                  aria-label={text.restore(titleOf(item))}
                  onClick={() => restore(key)}
                >
                  {text.restoreLabel}
                </button>
                <button
                  type="button"
                  className="pv-button rb-danger"
                  aria-label={text.deleteForGood(titleOf(item))}
                  onClick={() => setAsk({ key })}
                >
                  {text.deleteLabel}
                </button>
              </div>
              {refusals.has(key) ? (
                <p className="rb-refusal" role="status">
                  {refusals.get(key)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <div className="pv-page" data-bin-page>
      <style>{PREVIEW_CSS}</style>
      <style>{PAGE_CSS}</style>
      <header className="pv-title rb-head">
        <h1>{text.bin}</h1>
        <button
          type="button"
          className="pv-button rb-danger"
          disabled={items.length === 0}
          onClick={() => setAsk({ all: true })}
        >
          <span className="pv-glyph" aria-hidden="true" style={iconStyle(TRASH)} />
          {text.emptyBin}
        </button>
      </header>
      <p className="pv-muted">{text.intro}</p>
      {question ? (
        <div className="rb-ask" role="alertdialog" aria-modal="false" aria-label={text.deleteLabel}>
          <p>{question}</p>
          <div className="rb-actions">
            <button
              type="button"
              className="pv-button rb-danger"
              onClick={() => purge(ask && 'key' in ask ? ask.key : undefined)}
            >
              {text.deleteLabel}
            </button>
            <button type="button" className="pv-button" onClick={() => setAsk(undefined)}>
              {text.cancel}
            </button>
          </div>
        </div>
      ) : null}
      {items.length === 0 ? (
        <section className="pv-section" data-bin-empty>
          <p>{text.empty}</p>
          <p className="pv-muted">{text.emptyHint}</p>
        </section>
      ) : (
        <>
          {list(text.planned, planned)}
          {list(text.done, done)}
        </>
      )}
    </div>
  );
}

export const BinPage = reactComponent((ctx) => <BinPageView ctx={ctx} />);
