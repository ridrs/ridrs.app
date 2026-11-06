// SPDX-License-Identifier: AGPL-3.0-or-later

import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PREVIEW_CSS } from './style.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as a mask in the text colour. */
const HIDE = new URL('./assets/icons/eye-off.svg', import.meta.url).href;

/** The screen Back leads to from an area: Today, the main screen. */
const TODAY = 'main';

/** A component rendered with React into the shell's container, unmounted with it. */
export function reactComponent(render: (ctx: UiContext) => ReactNode): UiComponent {
  return (container, ctx) => {
    const root = createRoot(container);
    root.render(render(ctx));
    return () => root.unmount();
  };
}

/** The CSS variable `--icon` that `.pv-glyph`, `[data-menu-icon]` and `[data-action-icon]` paint. */
export function iconStyle(url: string): CSSProperties {
  return { '--icon': `url("${url}")` } as CSSProperties;
}

/** The id of the shown screen, following every navigation. */
export function useShownScreen(ctx: UiContext): string | undefined {
  const [shown, setShown] = useState<string>();
  useEffect(() => ctx.onNavigated(setShown), [ctx]);
  return shown;
}

/**
 * Back leaves the area for Today, unless `inner` handles it first (closing a detail view) and
 * returns `true`.
 */
export function useBack(ctx: UiContext, inner?: () => boolean): void {
  const latest = useRef(inner);
  latest.current = inner;
  useEffect(
    () =>
      ctx.onBack(() => {
        if (!latest.current?.()) ctx.navigate(TODAY);
      }),
    [ctx],
  );
}

/** Marks content that is a placeholder of the early alpha (ADR 0059). */
export function PreviewLabel() {
  return (
    <span className="pv-label" data-preview>
      Preview
    </span>
  );
}

/** An area's page: its title with the preview label, an introduction, then its sections. */
export function AreaPage({
  title,
  intro,
  children,
}: {
  readonly title: string;
  readonly intro?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="pv-page">
      <style>{PREVIEW_CSS}</style>
      <header className="pv-title">
        <h1>{title}</h1>
        <PreviewLabel />
      </header>
      {intro ? <p className="pv-muted">{intro}</p> : null}
      {children}
    </div>
  );
}

/** An area's entry of the main menu, in the menu's contract (ADR 0058). */
export function MenuEntry({
  ctx,
  screen,
  label,
  icon,
}: {
  readonly ctx: UiContext;
  readonly screen: string;
  readonly label: string;
  readonly icon: string;
}) {
  const shown = useShownScreen(ctx);
  return (
    <button
      type="button"
      data-menu-item
      aria-current={shown === screen ? 'page' : undefined}
      onClick={() => ctx.navigate(screen)}
    >
      <span data-menu-icon aria-hidden="true" style={iconStyle(icon)} />
      <span data-menu-label>{label}</span>
    </button>
  );
}

/** A global action (`main/action`, ADR 0059): a round icon button that opens its screen. */
export function ActionButton({
  ctx,
  screen,
  label,
  icon,
}: {
  readonly ctx: UiContext;
  readonly screen: string;
  readonly label: string;
  readonly icon: string;
}) {
  const shown = useShownScreen(ctx);
  return (
    <button
      type="button"
      data-action
      aria-label={label}
      aria-current={shown === screen ? 'page' : undefined}
      onClick={() => ctx.navigate(screen)}
    >
      <span data-action-icon aria-hidden="true" style={iconStyle(icon)} />
    </button>
  );
}

/** A card on Today that the rider can hide; its area shows it again. */
export function TodayCard({
  title,
  onHide,
  children,
}: {
  readonly title: string;
  readonly onHide: () => void;
  readonly children: ReactNode;
}) {
  return (
    <section className="pv-tile" aria-label={title}>
      <style>{PREVIEW_CSS}</style>
      <header>
        <h2>{title}</h2>
        <PreviewLabel />
        <button type="button" className="pv-icon" aria-label={`Hide ${title}`} onClick={onHide}>
          <span className="pv-glyph" aria-hidden="true" style={iconStyle(HIDE)} />
        </button>
      </header>
      {children}
    </section>
  );
}

/** A button that is on or off (`aria-pressed`); each press takes effect at once. */
export function Toggle({
  label,
  on,
  onChange,
  children,
  className = 'pv-chip',
}: {
  readonly label: string;
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-label={children === undefined ? undefined : label}
      aria-pressed={on}
      onClick={() => onChange(!on)}
    >
      {children ?? label}
    </button>
  );
}
