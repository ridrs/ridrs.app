// SPDX-License-Identifier: AGPL-3.0-or-later

import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PREVIEW_CSS } from './style.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as a mask in the text colour. */
const HIDE = new URL('./assets/icons/eye-off.svg', import.meta.url).href;

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

/** The id of the page: the screen beneath a dialog while one is open (ADR 0071), else the shown one. */
function usePage(ctx: UiContext): string | undefined {
  const [page, setPage] = useState<string>();
  useEffect(() => ctx.onNavigated((_, shownPage) => setPage(shownPage)), [ctx]);
  return page;
}

/**
 * Back leaves the screen (`ctx.leave`: an area for Today, a dialog for the page beneath it),
 * unless `inner` handles it first (closing a detail view) and returns `true`.
 */
export function useBack(ctx: UiContext, inner?: () => boolean): void {
  const latest = useRef(inner);
  latest.current = inner;
  useEffect(
    () =>
      ctx.onBack(() => {
        if (!latest.current?.()) ctx.leave();
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
  // An area stays marked while a dialog is open over it.
  const page = usePage(ctx);
  return (
    <button
      type="button"
      data-menu-item
      aria-current={page === screen ? 'page' : undefined}
      onClick={() => ctx.navigate(screen)}
    >
      <span data-menu-icon aria-hidden="true" style={iconStyle(icon)} />
      <span data-menu-label>{label}</span>
    </button>
  );
}

/**
 * A global action (`main/action`, ADR 0059): a round icon button that opens its screen, in a
 * dialog over the page where the layout says so (ADR 0071).
 */
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

/** A fact of a card's details with a small icon that says what it is, e.g. distance or climb. */
export interface CardFact {
  readonly icon: string;
  readonly text: string;
}

export interface CardProps {
  /** What the card is, above the title: e.g. `Video`, `Next event`. Also the card's name if `label` is not given. */
  readonly classifier: string;
  /** An icon URL painted in front of the classifier. */
  readonly icon?: string;
  /** One or two lines; longer titles are cut. */
  readonly title: string;
  /**
   * The facts under the title, shown as one line: `Tue 18:30 · 60 min`; a fact with an icon
   * stands by its icon instead of a dot.
   */
  readonly details?: readonly (string | CardFact | undefined)[];
  /** A picture that fills the whole card, the text over its darkened lower part. */
  readonly image?: string;
  /** Drawn behind the text at the card's lower edge, e.g. an elevation profile. */
  readonly backdrop?: ReactNode;
  /** Small controls in the upper right corner, e.g. a badge or a favourite toggle. */
  readonly tools?: ReactNode;
  /** Opens what the card stands for: the whole card is then one button. */
  readonly onOpen?: () => void;
  /** The name of the card and of its button. */
  readonly label?: string;
  readonly testId?: string;
  /** Below the details: a progress bar, buttons. */
  readonly children?: ReactNode;
}

/**
 * The card of the app (Today, lists of rides): a classifier, a title of one or two lines and a
 * line of details, on a picture if there is one.
 */
export function Card({
  classifier,
  icon,
  title,
  details = [],
  image,
  backdrop,
  tools,
  onOpen,
  label,
  testId,
  children,
}: CardProps) {
  const facts = details.filter(
    (detail): detail is string | CardFact => detail !== undefined && detail !== '',
  );
  const text = (
    <>
      <strong className="pv-teaser-title">{title}</strong>
      {facts.length > 0 ? (
        <span className="pv-teaser-details">
          {facts.map((fact, index) =>
            typeof fact === 'string' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the facts are positional and never reorder.
              <span key={index}>
                {index > 0 && typeof facts[index - 1] === 'string' ? ' · ' : null}
                {fact}
              </span>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: the facts are positional and never reorder.
              <span key={index} className="pv-teaser-fact">
                <span className="pv-glyph" aria-hidden="true" style={iconStyle(fact.icon)} />
                {fact.text}
              </span>
            ),
          )}
        </span>
      ) : null}
    </>
  );
  return (
    <article
      className="pv-teaser"
      aria-label={label ?? classifier}
      data-testid={testId}
      data-media={image === undefined && backdrop === undefined ? undefined : ''}
    >
      <style>{PREVIEW_CSS}</style>
      {image ? <img className="pv-teaser-image" src={image} alt="" /> : null}
      {backdrop ? <div className="pv-teaser-backdrop">{backdrop}</div> : null}
      <span className="pv-teaser-classifier">
        {icon ? <span className="pv-glyph" aria-hidden="true" style={iconStyle(icon)} /> : null}
        {classifier}
      </span>
      {onOpen ? (
        <button
          type="button"
          className="pv-teaser-open"
          aria-label={label ?? title}
          onClick={onOpen}
        >
          {text}
        </button>
      ) : (
        <div className="pv-teaser-text">{text}</div>
      )}
      {children}
      {tools ? <div className="pv-teaser-tools">{tools}</div> : null}
    </article>
  );
}

/** A small label in a card's corner, e.g. `45 %` for a download on its way, or a named icon. */
export function Badge({
  tone,
  label,
  children,
}: {
  readonly tone?: 'busy' | 'warn' | 'done';
  /** Names a badge that shows only an icon. */
  readonly label?: string;
  readonly children: ReactNode;
}) {
  return label ? (
    <span className="pv-badge" data-tone={tone} role="img" aria-label={label}>
      {children}
    </span>
  ) : (
    <span className="pv-badge" data-tone={tone}>
      {children}
    </span>
  );
}

/** A card on Today that the rider can hide; its area shows it again. The classifier names it. */
export function TodayCard({
  onHide,
  tools,
  ...card
}: Omit<CardProps, 'label'> & { readonly onHide: () => void }) {
  return (
    <Card
      {...card}
      tools={
        <>
          {tools}
          <PreviewLabel />
          <button
            type="button"
            className="pv-icon"
            aria-label={`Hide ${card.classifier}`}
            onClick={onHide}
          >
            <span className="pv-glyph" aria-hidden="true" style={iconStyle(HIDE)} />
          </button>
        </>
      }
    />
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
