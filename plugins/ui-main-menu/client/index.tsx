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

/** The two slashes alone, for the narrow menu. */
const LOGO_MARK = new URL('./assets/logo-mark.svg', import.meta.url).href;

/**
 * Entries of `menu/item` follow one contract (ADR 0058): a `button[data-menu-item]` holding an
 * icon `[data-menu-icon]` and a label `[data-menu-label]`; the menu styles them all alike. The
 * labels leave the view on narrow screens but stay the buttons' names. `menu/section` (the next
 * ride) and `menu/footer` (the trash, ADR 0096) sit together at the bottom of the menu; their
 * entries of the item contract are styled alike.
 */
const CSS = `
/* The brand starts level with the page title (\`--ridrs-page-top\`, ui-main-screen). */
.mm-nav { --mm-cyan: var(--ridrs-info); --mm-volt: var(--ridrs-accent);
  position: relative; display: flex; flex-direction: column; gap: 28px; height: 100%;
  padding: var(--ridrs-page-top) 12px 20px;
  background: linear-gradient(180deg, rgb(14 21 35 / .55), rgb(7 9 14 / 0) 40%, rgb(0 240 255 / .04)); }
.mm-brand { display: block; width: 140px; height: auto; margin: 0 12px; }
.mm-brand-mark { display: none; }
.mm-list { display: flex; flex-direction: column; gap: 4px; }
.mm-list .mm-list, .mm-list [data-contribution] { display: contents; }
/* At the bottom, together: the next ride (menu/section) and the trash (menu/footer, ADR 0096). */
.mm-section:empty, .mm-footer:empty { display: none; }
.mm-section { margin-top: auto; }
.mm-section:empty + .mm-footer { margin-top: auto; }
.mm-footer { display: flex; flex-direction: column; gap: 4px; padding-top: 12px; border-top: 1px solid var(--ridrs-line); }
.mm-footer [data-contribution] { display: contents; }

/* An entry: a round surface under the pointer; the page's own is the navy card with its light edge
   and its icon and label in volt. Nothing is clipped, so the focus ring is always whole. */
.mm-nav [data-menu-item] { position: relative; display: flex; align-items: center; gap: 14px; width: 100%;
  padding: 12px 14px; border: 0; border-radius: var(--ridrs-radius); background: transparent;
  color: var(--ridrs-text-muted); font: 500 var(--ridrs-size-body) var(--ridrs-font-text); text-align: left; cursor: pointer;
  transition: background var(--ridrs-ease), color var(--ridrs-ease); }
.mm-nav [data-menu-label] { font-family: var(--ridrs-font-display) !important; font-style: italic;
  text-transform: uppercase; letter-spacing: .08em; }
.mm-nav [data-menu-item]:hover { background: var(--ridrs-surface-raised); color: var(--ridrs-text); }
.mm-nav [data-menu-item][aria-current="page"] { background: var(--ridrs-card-quiet); box-shadow: var(--ridrs-edge);
  color: var(--mm-volt); }
.mm-nav [data-menu-item][aria-current="page"] [data-menu-icon] { color: inherit; }
.mm-nav [data-menu-item]:focus-visible { outline: var(--ridrs-focus-ring); outline-offset: 2px; }
.mm-nav [data-menu-icon] { flex: none; width: 24px; height: 24px; background: currentColor;
  mask: var(--icon) center / contain no-repeat; -webkit-mask: var(--icon) center / contain no-repeat;
  transition: color .15s; }
@media (prefers-reduced-motion: reduce) { .mm-nav [data-menu-item], .mm-nav [data-menu-icon] { transition: none; } }

[data-breakpoint="medium"] .mm-nav { align-items: center; padding: var(--ridrs-page-top) 10px 20px; }
[data-breakpoint="medium"] .mm-brand { display: none; }
[data-breakpoint="medium"] .mm-brand-mark { display: block; width: 36px; height: auto; margin: 0; }
[data-breakpoint="medium"] .mm-nav [data-menu-item] { justify-content: center; padding: 12px; }
[data-breakpoint="compact"] .mm-nav { flex-direction: row; padding: 6px 8px; background: none; }
[data-breakpoint="compact"] .mm-brand, [data-breakpoint="compact"] .mm-brand-mark { display: none; }
[data-breakpoint="compact"] .mm-list { flex: 1; flex-direction: row; justify-content: space-around; }
[data-breakpoint="compact"] .mm-section:empty + .mm-footer, [data-breakpoint="compact"] .mm-footer { margin-top: 0; padding-top: 0; border-top: 0; flex-direction: row; }
[data-breakpoint="compact"] .mm-nav [data-menu-item] { flex: 1; flex-direction: column; gap: 4px;
  width: auto; padding: 8px 12px; font-size: 11px; text-align: center; }
[data-breakpoint="medium"] .mm-nav [data-menu-label] { position: absolute; width: 1px; height: 1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;

function MainMenuView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const items = useRef<HTMLDivElement>(null);
  // The other screens' entries; the menu does not know them.
  useEffect(() => (items.current ? ctx.slot('menu/item', items.current) : undefined), [ctx]);
  // Below the entries and at the bottom: the next ride and the bin, also unknown to the menu.
  const section = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  useEffect(() => (section.current ? ctx.slot('menu/section', section.current) : undefined), [ctx]);
  useEffect(() => (footer.current ? ctx.slot('menu/footer', footer.current) : undefined), [ctx]);
  // Today stays marked while a dialog is open over it (ADR 0071).
  const [page, setPage] = useState<string>();
  useEffect(() => ctx.onNavigated((_, shownPage) => setPage(shownPage)), [ctx]);

  return (
    <nav className="mm-nav" aria-label={text.menu}>
      <style>{CSS}</style>
      <img className="mm-brand" src={LOGO} alt="" aria-hidden="true" />
      <img className="mm-brand-mark" src={LOGO_MARK} alt="" aria-hidden="true" />
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
      <div ref={section} className="mm-section" data-testid="slot-menu-section" />
      <div ref={footer} className="mm-footer" data-testid="slot-menu-footer" />
    </nav>
  );
}

export const MainMenu: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<MainMenuView ctx={ctx} />);
  return () => root.unmount();
};
