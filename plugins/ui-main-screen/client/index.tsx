// SPDX-License-Identifier: AGPL-3.0-or-later

import { activityStateChangedEvent } from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import configured from '../layout.json' with { type: 'json' };
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
  --ridrs-radius: 16px; --ridrs-gap: 16px;
  box-sizing: border-box; display: grid; height: 100%; min-height: 100vh;
  grid-template-columns: 200px minmax(0, 1fr); grid-template-areas: "menu main";
  background: var(--ridrs-bg); color: var(--ridrs-text); font: 15px/1.4 system-ui, sans-serif; }
.ms-root *, .ms-root *::before, .ms-root *::after { box-sizing: inherit; }
.ms-root[data-breakpoint="medium"] { grid-template-columns: 76px minmax(0, 1fr); }
.ms-root[data-breakpoint="compact"] { grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto; grid-template-areas: "main" "menu"; }
.ms-menu { grid-area: menu; border-right: 1px solid var(--ridrs-line); }
.ms-root[data-breakpoint="compact"] .ms-menu { border-right: 0; border-top: 1px solid var(--ridrs-line); }
.ms-column { grid-area: main; display: flex; flex-direction: column; min-width: 0; min-height: 0;
  overflow: auto; }
.ms-head { display: flex; align-items: center; gap: 16px; padding: 28px 40px 0; }
.ms-head > header { flex: 1; min-width: 0; }
.ms-root[data-breakpoint="compact"] .ms-head { padding: 12px 16px 0; }
.ms-actions { display: flex; gap: 10px; margin-left: auto; }
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
.ms-outlet { flex: 1 0 auto; display: grid; min-width: 0; }
.ms-outlet[hidden] { display: none; }
.ms-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--ridrs-gap); }
.ms-grid > [data-tile] > [data-contribution] { height: 100%; }
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

function MainScreenView({ ctx, layout, view }: { readonly ctx: UiContext; readonly layout: Layout; readonly view: Window }) {
  const breakpoint = useBreakpoint(view);
  const menu = useSlot(ctx, 'main/menu', layout.menu);
  // The screens the layout names take the place of the top bar and the tiles; the menu stays.
  const outlet = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<string>();
  useEffect(() => ctx.onNavigated(setShown), [ctx]);
  useEffect(
    () => (outlet.current ? ctx.outlet(outlet.current, { screens: layout.screens }) : undefined),
    [ctx, layout],
  );
  const framing = shown !== undefined && layout.screens.includes(shown);

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

  // Reading order is the keyboard's order (ADR 0045): the menu, the top bar, the global actions,
  // then the tiles or the screen in the content area. The top bar and the tiles are unmounted
  // while another screen is there; the menu and the actions stay.
  return (
    <div className="ms-root" data-testid="main-layout" data-breakpoint={breakpoint}>
      <style>{CSS}</style>
      {layout.menu ? <div className="ms-menu" data-testid="slot-main-menu" ref={menu} /> : null}
      <div className="ms-column">
        {layout.topBar || layout.actions.length > 0 ? (
          <div className="ms-head">
            {layout.topBar && !framing ? (
              <TopBar ctx={ctx} contribution={layout.topBar} hidden={breakpoint === 'compact'} />
            ) : null}
            <div className="ms-actions" data-testid="slot-main-action">
              {layout.actions.map((action) => (
                <Action key={action} ctx={ctx} contribution={action} />
              ))}
            </div>
          </div>
        ) : null}
        {framing ? null : <Home ctx={ctx} layout={layout} breakpoint={breakpoint} />}
        <div className="ms-outlet" data-testid="main-outlet" ref={outlet} hidden={!framing} />
      </div>
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
