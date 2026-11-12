// SPDX-License-Identifier: AGPL-3.0-or-later

import { activityStateChangedEvent, appLinkState } from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import configured from '../layout.json' with { type: 'json' };
import { messages } from './i18n/index.ts';
import { KineticStyle } from './kinetic.tsx';
import { BREAKPOINTS, type Breakpoint, breakpointAt, columnsAt, type Layout, layoutSchema, type Tile } from './layout.ts';

/**
 * The design tokens of ADR 0058: the menu, the top bar and every tile draw with them. The root
 * carries `data-breakpoint`, so contributions can follow the breakpoint in their own style sheets.
 */
const CSS = `
.ms-root { --ridrs-bg: #0b1220; --ridrs-surface: #131c2e; --ridrs-surface-raised: #1a2540;
  --ridrs-line: #24324d; --ridrs-text: #f2f5fa; --ridrs-text-muted: #93a1b8;
  --ridrs-accent: #b8f53b; --ridrs-accent-text: #0b1220; --ridrs-info: #2aa8ff;
  --ridrs-ok: #3ddc84; --ridrs-warn: #ffb62e; --ridrs-favourite: #ffd60a; --ridrs-focus: #ffffff;
  --ridrs-radius: 16px; --ridrs-gap: 16px; --ridrs-page-top: 40px;
  box-sizing: border-box; display: grid; height: 100%; min-height: 100vh;
  grid-template-columns: 200px minmax(0, 1fr); grid-template-areas: "menu main";
  background: var(--ridrs-bg); color: var(--ridrs-text); font: 15px/1.4 system-ui, sans-serif; }
.ms-root *, .ms-root *::before, .ms-root *::after { box-sizing: inherit; }
/* Scroll bars: a slim rounded thumb on no track, instead of the grey bar of the system. */
.ms-root ::-webkit-scrollbar { width: 12px; height: 12px; background: transparent; }
.ms-root ::-webkit-scrollbar-track, .ms-root ::-webkit-scrollbar-corner { background: transparent; }
.ms-root ::-webkit-scrollbar-thumb { border: 3px solid transparent; border-radius: 6px;
  background: rgb(255 255 255 / .16) padding-box; }
.ms-root ::-webkit-scrollbar-thumb:hover { background-color: rgb(255 255 255 / .32); }
.ms-root ::-webkit-scrollbar-thumb:active { background-color: var(--ridrs-info); }
@supports not selector(::-webkit-scrollbar) {
  .ms-root, .ms-root * { scrollbar-width: thin; scrollbar-color: rgb(255 255 255 / .2) transparent; }
}
.ms-root[data-breakpoint="medium"] { grid-template-columns: 76px minmax(0, 1fr); }
.ms-root[data-breakpoint="compact"] { grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto; grid-template-areas: "main" "menu"; }
.ms-menu { grid-area: menu; border-right: 1px solid var(--ridrs-line); }
.ms-root[data-breakpoint="compact"] .ms-menu { border-right: 0; border-top: 1px solid var(--ridrs-line); }
.ms-column { grid-area: main; display: flex; flex-direction: column; min-width: 0; min-height: 0;
  overflow: auto; }
.ms-column { position: relative; }
/* The actions stay at the top right while the page scrolls: a bar of no height over the column.
   They keep as much room to the top as to the right (the column's scroll bar aside); their top is
   level with the top of the page title (the title trims its line to the letters). */
.ms-bar { grid-area: main; align-self: start; position: relative; z-index: 3; display: flex;
  justify-content: flex-end; height: 0; padding: 0 calc(40px + var(--ms-scrollbar, 0px)) 0 40px;
  pointer-events: none; }
.ms-actions { display: flex; gap: 10px; margin-top: var(--ridrs-page-top); pointer-events: auto; }
.ms-head { padding: var(--ridrs-page-top) calc(46px + var(--ms-actions, 0) * 54px) 0 40px; }
.ms-root[data-breakpoint="compact"] .ms-bar { padding: 12px calc(16px + var(--ms-scrollbar, 0px)) 0 16px; }
.ms-root[data-breakpoint="compact"] .ms-actions { margin-top: 0; }
.ms-root[data-breakpoint="compact"] .ms-head { padding: 12px 16px 0; }
/* A screen without the page head keeps the actions' row free above it, unless it starts with a
   picture across its towp (\`[data-hero]\`): that runs under the actions, which stand over it on a
   glass of their own. */
.ms-column:not(:has(> .ms-head)):not(:has(> .ms-outlet:not([hidden]) :is([data-hero], [data-page-head])))::before {
  content: ""; flex: none; height: calc(var(--ridrs-page-top) + 44px); }
.ms-root[data-breakpoint="compact"] .ms-column:not(:has(> .ms-outlet:not([hidden]) :is([data-hero], [data-page-head])))::before {
  content: ""; flex: none; height: 56px; }
.ms-root:has(> .ms-column > .ms-outlet:not([hidden]) [data-hero]) .ms-actions [data-action] {
  border-color: rgb(255 255 255 / .14); background: rgb(11 18 32 / .55); backdrop-filter: blur(8px); }
/* Once it scrolls, the page fades out under the actions instead of showing behind them; a picture
   across its top stays until its end (\`--ms-hero-end\`). The scroll bar stays whole. Set by
   useScrollFade. */
.ms-column { --ms-fade: calc(var(--ridrs-page-top) + 44px);
  --ms-fade-mask: linear-gradient(#000 var(--ms-hero-end, 0px),
    rgb(0 0 0 / calc(1 - var(--ms-scrolled, 0))) var(--ms-hero-end, 0px) var(--ms-fade),
    #000 calc(var(--ms-fade) + 24px)) left top / calc(100% - var(--ms-scrollbar, 0px)) 100% no-repeat,
    linear-gradient(#000, #000) right top / var(--ms-scrollbar, 0px) 100% no-repeat;
  -webkit-mask: var(--ms-fade-mask); mask: var(--ms-fade-mask); }
.ms-root[data-breakpoint="compact"] .ms-column { --ms-fade: 56px; }
.ms-actions [data-contribution] { display: contents; }
.ms-actions [data-action] { position: relative; display: grid; place-items: center; width: 44px;
  height: 44px; padding: 0; border: 1px solid var(--ridrs-line); border-radius: 50%;
  background: var(--ridrs-surface); color: var(--ridrs-text); cursor: pointer; }
.ms-actions [data-action]:hover { background: var(--ridrs-surface-raised); }
.ms-actions [data-action][aria-current="page"] { border-color: var(--ridrs-info);
  color: var(--ridrs-info); }
.ms-actions [data-action]:focus-visible { outline: 3px solid var(--ridrs-focus); outline-offset: 2px; }
.ms-actions [data-action-icon] { width: 20px; height: 20px; background: currentColor;
  mask: var(--icon) center / contain no-repeat; -webkit-mask: var(--icon) center / contain no-repeat; }
.ms-actions [data-action-tone] { position: absolute; top: 2px; right: 2px; width: 11px; height: 11px;
  border: 2px solid var(--ridrs-bg); border-radius: 50%; background: var(--ridrs-text-muted); }
.ms-actions [data-action-tone="ok"] { background: var(--ridrs-ok); }
.ms-actions [data-action-tone="busy"] { background: var(--ridrs-info); }
.ms-actions [data-action-tone="warn"] { background: var(--ridrs-warn); }
.ms-main { display: flex; flex-direction: column; gap: 24px; padding: 24px 40px 32px; }
.ms-root[data-breakpoint="compact"] .ms-main { padding: 16px; }
.ms-outlet { flex: 1 0 auto; display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; }
.ms-outlet[hidden] { display: none; }
.ms-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--ridrs-gap); }
.ms-grid > [data-tile] > [data-contribution] { height: 100%; }
/* A screen in a dialog (ADR 0071) floats over the page, which stays as it is beneath it. */
.ms-dialog { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; padding: 40px;
  background: rgb(4 8 16 / .66); backdrop-filter: blur(6px); }
.ms-dialog[hidden] { display: none; }
.ms-dialog-panel { position: relative; display: flex; flex-direction: column; width: min(960px, 100%);
  max-height: 100%; overflow: hidden; border: 1px solid var(--ridrs-line); border-radius: 20px;
  background: var(--ridrs-bg); box-shadow: 0 24px 64px rgb(0 0 0 / .5); }
.ms-dialog-panel:focus { outline: none; }
.ms-dialog-body { display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; overflow: auto; }
.ms-dialog-close { position: absolute; top: 16px; right: 16px; z-index: 1; width: 40px; height: 40px;
  padding: 0; border: 1px solid var(--ridrs-line); border-radius: 50%; background: var(--ridrs-surface);
  color: var(--ridrs-text); cursor: pointer; }
.ms-dialog-close:hover { background: var(--ridrs-surface-raised); }
.ms-dialog-close:focus-visible { outline: 3px solid var(--ridrs-focus); outline-offset: 2px; }
.ms-dialog-close::before, .ms-dialog-close::after { content: ""; position: absolute; top: 50%; left: 50%;
  width: 16px; height: 2px; border-radius: 1px; background: currentColor; }
.ms-dialog-close::before { transform: translate(-50%, -50%) rotate(45deg); }
.ms-dialog-close::after { transform: translate(-50%, -50%) rotate(-45deg); }
.ms-root[data-breakpoint="compact"] .ms-dialog { padding: 0; }
.ms-root[data-breakpoint="compact"] .ms-dialog-panel { width: 100%; height: 100%; border: 0;
  border-radius: 0; }
`;

/** The breakpoint of the window's width, following it through media queries. */
function useBreakpoint(view: Window): Breakpoint {
  const [breakpoint, setBreakpoint] = useState(() => breakpointAt(view.innerWidth));
  useEffect(() => {
    const update = () => setBreakpoint(breakpointAt(view.innerWidth));
    const queries = BREAKPOINTS.filter(([, from]) => from > 0).map(([, from]) =>
      view.matchMedia(`(min-width: ${from}px)`),
    );
    for (const query of queries) query.addEventListener('change', update);
    update();
    return () => {
      for (const query of queries) query.removeEventListener('change', update);
    };
  }, [view]);
  return breakpoint;
}

/** A container that holds the one configured contribution of an extension point. */
function useSlot(ctx: UiContext, point: string, contribution: string | undefined) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current || !contribution) {
      return undefined;
    }
    const release = ctx.slot(point, container.current, { contribution });
    // The contribution may be a React root of its own; unmounting it while this root commits
    // (the tiles leave for a framed screen) races, so it is released right after.
    return () => queueMicrotask(release);
  }, [ctx, point, contribution]);
  return container;
}

/**
 * One cell of the grid. A cell whose contribution shows nothing (its plugin is not running, or it
 * has nothing to say) is hidden, so it leaves no gap.
 */
function Cell({ ctx, tile, columns }: { readonly ctx: UiContext; readonly tile: Tile; readonly columns: number }) {
  const cell = useSlot(ctx, 'main/tile', tile.contribution);
  useLayoutEffect(() => {
    const element = cell.current;
    if (!element) {
      return;
    }
    const update = () => {
      element.hidden = element.querySelector('[data-contribution] > *') === null;
    };
    const observer = new MutationObserver(update);
    observer.observe(element, { childList: true, subtree: true });
    update();
    return () => observer.disconnect();
  }, [cell]);
  return (
    <div
      ref={cell}
      data-tile={tile.contribution}
      data-columns={columns}
      style={{ gridColumn: `span ${columns}` }}
    />
  );
}

/** The configured top bar: shown on Today only, and not at the compact breakpoint. */
function TopBar({ ctx, contribution, hidden }: { readonly ctx: UiContext; readonly contribution: string; readonly hidden: boolean }) {
  const topBar = useSlot(ctx, 'main/top-bar', contribution);
  return <header data-testid="slot-main-top-bar" ref={topBar} hidden={hidden} />;
}

/** One global action of the layout: a `button[data-action]` that the actions row styles. */
function Action({ ctx, contribution }: { readonly ctx: UiContext; readonly contribution: string }) {
  const action = useSlot(ctx, 'main/action', contribution);
  return <div ref={action} data-action-slot={contribution} style={{ display: 'contents' }} />;
}

/** A layer over everything: it places itself, and shows nothing while it has nothing to say. */
function Overlay({ ctx, contribution }: { readonly ctx: UiContext; readonly contribution: string }) {
  const overlay = useSlot(ctx, 'main/overlay', contribution);
  return <div ref={overlay} data-overlay-slot={contribution} style={{ display: 'contents' }} />;
}

/** The tiles: what the main screen shows while no other screen is in its content area. */
function Home({
  ctx,
  layout,
  breakpoint,
}: {
  readonly ctx: UiContext;
  readonly layout: Layout;
  readonly breakpoint: Breakpoint;
}) {
  return (
    <main className="ms-main">
      <div className="ms-grid" data-testid="slot-main-tile">
        {layout.tiles.map((tile) => (
          <Cell key={tile.contribution} ctx={ctx} tile={tile} columns={columnsAt(tile, breakpoint)} />
        ))}
      </div>
    </main>
  );
}

/**
 * The dialog over the page: a screen of `dialogs` in the layout. While it is open, the page beneath
 * it is inert, so the arrows stay in the dialog; it starts with the focus on its panel and gives
 * the focus back to where it was once it closes. Back, Close and the backdrop leave the screen.
 */
function Dialog({
  ctx,
  open,
  container,
}: {
  readonly ctx: UiContext;
  readonly open: boolean;
  readonly container: RefObject<HTMLDivElement | null>;
}) {
  const text = useMessages(ctx, messages);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  // In the effect, not its cleanup: the page beneath is no longer inert only once it committed.
  useLayoutEffect(() => {
    if (open) {
      opener.current = panel.current?.ownerDocument.activeElement ?? null;
      panel.current?.focus();
    } else if (opener.current) {
      const back = opener.current;
      opener.current = null;
      if (back instanceof HTMLElement && back.isConnected) {
        back.focus();
      }
    }
  }, [open]);
  return (
    // The backdrop is a pointer's way out; keys leave with Back.
    <div
      className="ms-dialog"
      role="dialog"
      aria-modal="true"
      hidden={!open}
      data-testid="main-dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget) ctx.leave();
      }}
    >
      <div ref={panel} className="ms-dialog-panel" tabIndex={-1}>
        {open ? (
          <button type="button" className="ms-dialog-close" aria-label={text.close} onClick={() => ctx.leave()} />
        ) : null}
        <div ref={container} className="ms-dialog-body" />
      </div>
    </div>
  );
}

/**
 * Tells the style sheet how far the column has scrolled (`--ms-scrolled`, 0 to 1 over the first
 * 40 px), where a picture across the page's top ends (`--ms-hero-end`) and how wide the scroll bar
 * is (`--ms-scrollbar`), so the page fades out under the actions. Rendering only.
 */
function useScrollFade(view: Window, column: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const scroller = column.current;
    const root = scroller?.parentElement;
    if (!scroller || !root) {
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top;
      const hero = scroller.querySelector('.ms-outlet:not([hidden]) [data-hero]');
      const heroEnd = hero ? Math.max(0, hero.getBoundingClientRect().bottom - top) : 0;
      root.style.setProperty('--ms-scrolled', String(Math.min(scroller.scrollTop / 40, 1)));
      root.style.setProperty('--ms-hero-end', `${heroEnd}px`);
      root.style.setProperty('--ms-scrollbar', `${scroller.offsetWidth - scroller.clientWidth}px`);
    };
    const schedule = () => {
      frame ||= view.requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener('scroll', schedule, { passive: true });
    // The page changes (another screen, a picture loads) without a scroll.
    const changes = new MutationObserver(schedule);
    changes.observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    const sizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    sizes?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', schedule);
      changes.disconnect();
      sizes?.disconnect();
      view.cancelAnimationFrame(frame);
    };
  }, [view, column]);
}

function MainScreenView({ ctx, layout, view }: { readonly ctx: UiContext; readonly layout: Layout; readonly view: Window }) {
  const breakpoint = useBreakpoint(view);
  const menu = useSlot(ctx, 'main/menu', layout.menu);
  // The screens the layout names take the place of the top bar and the tiles; the menu stays.
  // Its dialog screens open over the page, which stays as it is (ADR 0071).
  const outlet = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  useScrollFade(view, column);
  const [shown, setShown] = useState<{ readonly screen: string; readonly page: string }>();
  useEffect(() => ctx.onNavigated((screen, page) => setShown({ screen, page })), [ctx]);
  useEffect(
    () =>
      outlet.current && dialog.current
        ? ctx.outlet(outlet.current, {
            screens: layout.screens,
            dialog: { container: dialog.current, screens: layout.dialogs },
          })
        : undefined,
    [ctx, layout],
  );
  // A link `ridrs://activity/<id>` to a ride of this device opens its debriefing (ADR 0079), only from
  // the main screen: a link never takes the rider out of a ride. The first delivery is the link that
  // is there already; one that is older than this page is not news.
  const mountedAt = useRef(Date.now());
  const seenLink = useRef(0);
  const onMain = shown === undefined || shown.screen === 'main';
  useEffect(
    () =>
      ctx.state.watch(appLinkState, ({ entries }) => {
        const link = entries.get('activity');
        if (link && link.at > seenLink.current && link.at >= mountedAt.current - 5000 && onMain) {
          seenLink.current = link.at;
          ctx.navigate('debriefing');
        }
      }),
    [ctx, onMain],
  );
  const framing = shown !== undefined && layout.screens.includes(shown.page);
  const open = shown !== undefined && shown.screen !== shown.page && layout.dialogs.includes(shown.screen);

  // Navigation follows the activity state, not the click: a replayed "running" state after a
  // reload leads back into the ride as well.
  useEffect(
    () =>
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
        if (payload.state === 'running' || payload.state === 'paused') {
          ctx.navigate('activity');
        }
      }),
    [ctx],
  );

  // Reading order is the keyboard's order (ADR 0045): the menu, the global actions (outside the
  // scrolling column, so they stay; the top bar holds nothing to focus), the top bar, then the
  // tiles or the screen in the content area, then the dialog. The top bar and the tiles
  // are unmounted while another screen is there; the menu and the actions stay.
  // Beneath a dialog the page is inert and hidden from assistive technology.
  return (
    <div className="ms-root" data-testid="main-layout" data-breakpoint={breakpoint}>
      <style>{CSS}</style>
      <KineticStyle doc={view.document} />
      {layout.menu ? <div className="ms-menu" data-testid="slot-main-menu" ref={menu} inert={open} aria-hidden={open || undefined} /> : null}
      {layout.actions.length > 0 ? (
        <div className="ms-bar" inert={open} aria-hidden={open || undefined}>
          <div className="ms-actions" data-testid="slot-main-action">
            {layout.actions.map((action) => (
              <Action key={action} ctx={ctx} contribution={action} />
            ))}
          </div>
        </div>
      ) : null}
      <div className="ms-column" ref={column} inert={open} aria-hidden={open || undefined}>
        {layout.topBar && !framing ? (
          <div className="ms-head" style={{ '--ms-actions': layout.actions.length } as object}>
            <TopBar ctx={ctx} contribution={layout.topBar} hidden={breakpoint === 'compact'} />
          </div>
        ) : null}
        {framing ? null : <Home ctx={ctx} layout={layout} breakpoint={breakpoint} />}
        <div className="ms-outlet" data-testid="main-outlet" ref={outlet} hidden={!framing} />
      </div>
      <Dialog ctx={ctx} open={open} container={dialog} />
      {layout.overlays.map((overlay) => (
        <Overlay key={overlay} ctx={ctx} contribution={overlay} />
      ))}
    </div>
  );
}

export const MainScreen: UiComponent = (container, ctx) => {
  // An invalid layout fails the screen (client-load-failure) instead of guessing.
  const layout = layoutSchema.parse(configured);
  const view = container.ownerDocument.defaultView;
  if (!view) {
    throw new Error('The main screen needs a window');
  }
  const root = createRoot(container);
  root.render(<MainScreenView ctx={ctx} layout={layout} view={view} />);
  return () => root.unmount();
};
