// SPDX-License-Identifier: AGPL-3.0-or-later

import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { messages } from './i18n/index.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as a mask in the text colour. */
const TODAY = new URL('./assets/icons/sun.svg', import.meta.url).href;
/** The ridrs wordmark: chrome letters and two slashes in the cyan-to-volt gradient. */
const LOGO = new URL('./assets/logo.svg', import.meta.url).href;

/**
 * Entries of `menu/item` follow one contract (ADR 0058): a `button[data-menu-item]` holding an
 * icon `[data-menu-icon]` and a label `[data-menu-label]`; the menu styles them all alike. The
 * labels leave the view on narrow screens but stay the buttons' names.
 */
const CSS = `
/* The brand starts level with the page title (\`--ridrs-page-top\`, ui-main-screen). */
.mm-nav { display: flex; flex-direction: column; gap: 28px; height: 100%;
  padding: var(--ridrs-page-top, 28px) 12px 28px; }
.mm-brand { display: block; width: 140px; height: auto; margin: 0 12px; }
.mm-list { display: flex; flex-direction: column; gap: 6px; }
.mm-list .mm-list, .mm-list [data-contribution] { display: contents; }
.mm-nav [data-menu-item] { display: flex; align-items: center; gap: 14px; width: 100%; padding: 12px;
  border: 0; border-radius: 12px; background: transparent; color: var(--ridrs-text, #f2f5fa);
  font: 500 16px system-ui, sans-serif; text-align: left; cursor: pointer; }
.mm-nav [data-menu-item]:hover { background: var(--ridrs-surface, #131c2e); }
.mm-nav [data-menu-item][aria-current="page"] { background: var(--ridrs-info, #2aa8ff); color: #fff; }
.mm-nav [data-menu-item]:focus-visible { outline: 3px solid var(--ridrs-focus, #fff); outline-offset: 2px; }
.mm-nav [data-menu-icon] { flex: none; width: 24px; height: 24px; background: currentColor;
  mask: var(--icon) center / contain no-repeat; -webkit-mask: var(--icon) center / contain no-repeat; }
[data-breakpoint="medium"] .mm-nav { align-items: center; padding: var(--ridrs-page-top, 24px) 10px 24px; }
[data-breakpoint="medium"] .mm-brand { width: 60px; margin: 0; }
[data-breakpoint="medium"] .mm-nav [data-menu-item] { justify-content: center; }
[data-breakpoint="compact"] .mm-nav { flex-direction: row; padding: 6px 8px; }
[data-breakpoint="compact"] .mm-brand { display: none; }
[data-breakpoint="compact"] .mm-list { flex: 1; flex-direction: row; justify-content: space-around; }
[data-breakpoint="compact"] .mm-nav [data-menu-item] { flex: 1; flex-direction: column; gap: 4px;
  width: auto; padding: 8px 12px; font-size: 12px; text-align: center; }
[data-breakpoint="medium"] .mm-nav [data-menu-label] { position: absolute; width: 1px; height: 1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;

function MainMenuView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const items = useRef<HTMLDivElement>(null);
  // The other screens' entries; the menu does not know them.
  useEffect(() => (items.current ? ctx.slot('menu/item', items.current) : undefined), [ctx]);
  // Today stays marked while a dialog is open over it (ADR 0071).
  const [page, setPage] = useState<string>();
  useEffect(() => ctx.onNavigated((_, shownPage) => setPage(shownPage)), [ctx]);

  return (
    <nav className="mm-nav" aria-label={text.menu}>
      <style>{CSS}</style>
      <img className="mm-brand" src={LOGO} alt="" aria-hidden="true" />
      <div className="mm-list">
        {/* Today is the main screen, where the menu lives; the areas mark their own entries. */}
        <button
          type="button"
          data-menu-item
          aria-current={page === 'main' ? 'page' : undefined}
          onClick={() => ctx.navigate('main')}
        >
          <span data-menu-icon aria-hidden="true" style={{ '--icon': `url("${TODAY}")` } as object} />
          <span data-menu-label>{text.today}</span>
        </button>
        <div ref={items} className="mm-list" data-testid="slot-menu-item" />
      </div>
    </nav>
  );
}

export const MainMenu: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<MainMenuView ctx={ctx} />);
  return () => root.unmount();
};
