// SPDX-License-Identifier: AGPL-3.0-or-later

/** What the page reports about one visible element (see `collect.js`); the audit needs no DOM. */
export interface LayoutFact {
  /** A path of tag and index, like `main > div:2 > button:0`; an ancestor's path is a prefix. */
  readonly path: string;
  readonly tag: string;
  /** The element's own text, shortened; empty for an element with none. */
  readonly text: string;
  readonly interactive: boolean;
  readonly display: string;
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly scrollW: number;
  readonly clientW: number;
  readonly scrollH: number;
  readonly clientH: number;
  readonly overflowX: string;
  readonly overflowY: string;
  readonly fontSize: number;
  readonly fontWeight: number;
  /** Computed `color` and the first non-transparent background of the element or an ancestor. */
  readonly color: string;
  readonly background: string;
  /** A background image or gradient somewhere above: the colour behind the text is unknown. */
  readonly backgroundImage: boolean;
  /** A scrolling or clipping ancestor lets the element lie beyond the viewport. */
  readonly clippedByAncestor: boolean;
}

export interface LayoutInput {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly documentScrollWidth: number;
  readonly facts: readonly LayoutFact[];
  readonly truncated: boolean;
}

export type IssueKind =
  | 'clipped-text'
  | 'horizontal-overflow'
  | 'overlap'
  | 'zero-size'
  | 'small-target'
  | 'low-contrast';

export interface Issue {
  readonly kind: IssueKind;
  readonly path: string;
  readonly text: string;
  readonly detail: string;
}

/** The smallest side of a click target (WCAG 2.2, 2.5.8: 24 CSS px). */
export const MIN_TARGET = 24;

export type Rgba = readonly [number, number, number, number];

/** `rgb(…)`, `rgba(…)` or `color(srgb …)` as computed styles give them; undefined for anything else. */
export function parseColor(value: string): Rgba | undefined {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(
    value.trim(),
  );
  if (!match) return undefined;
  const alpha =
    match[4] === undefined
      ? 1
      : match[4].endsWith('%')
        ? Number.parseFloat(match[4]) / 100
        : Number(match[4]);
  return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
}

const channel = (value: number): number => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: Rgba): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** The WCAG contrast ratio of a text colour on a background (1 to 21); the text is blended on it. */
export function contrast(foreground: Rgba, background: Rgba): number {
  const [fr, fg, fb, fa] = foreground;
  const [br, bg, bb] = background;
  const blended: Rgba = [
    fr * fa + br * (1 - fa),
    fg * fa + bg * (1 - fa),
    fb * fa + bb * (1 - fa),
    1,
  ];
  const a = luminance(blended);
  const b = luminance([br, bg, bb, 1]);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Large text (WCAG): 24 px, or 18.66 px and bold. */
const isLarge = (fact: LayoutFact): boolean =>
  fact.fontSize >= 24 || (fact.fontSize >= 18.66 && fact.fontWeight >= 700);

const area = (r: LayoutFact['rect']): number => r.w * r.h;

function overlapArea(a: LayoutFact['rect'], b: LayoutFact['rect']): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

const related = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b} > `) || b.startsWith(`${a} > `);

/** Content past the box is cut off, not scrolled to. */
const cuts = (overflow: string): boolean => overflow === 'hidden' || overflow === 'clip';

/** The layout problems a page shows: what a rider would see cut off, crowded or hard to hit or read. */
export function audit(input: LayoutInput): Issue[] {
  const issues: Issue[] = [];
  const add = (kind: IssueKind, fact: LayoutFact, detail: string) =>
    issues.push({ kind, path: fact.path, text: fact.text, detail });

  if (input.documentScrollWidth > input.viewport.width + 1) {
    issues.push({
      kind: 'horizontal-overflow',
      path: 'document',
      text: '',
      detail: `The page is ${input.documentScrollWidth} px wide in a ${input.viewport.width} px window`,
    });
  }

  for (const fact of input.facts) {
    const { rect } = fact;
    const hasText = fact.text !== '';
    if (hasText && cuts(fact.overflowX) && fact.scrollW > fact.clientW + 1) {
      add('clipped-text', fact, `The text is ${fact.scrollW} px wide in ${fact.clientW} px`);
    } else if (hasText && cuts(fact.overflowY) && fact.scrollH > fact.clientH + 1) {
      add('clipped-text', fact, `The text is ${fact.scrollH} px high in ${fact.clientH} px`);
    }
    if (
      !fact.clippedByAncestor &&
      rect.w > 0 &&
      rect.x + rect.w > input.viewport.width + 1 &&
      input.documentScrollWidth > input.viewport.width + 1
    ) {
      add(
        'horizontal-overflow',
        fact,
        `Ends at ${Math.round(rect.x + rect.w)} px, beyond the ${input.viewport.width} px window`,
      );
    }
    if ((hasText || fact.interactive) && (rect.w === 0 || rect.h === 0)) {
      add('zero-size', fact, `The element is ${rect.w} × ${rect.h} px`);
    }
    // An inline link in a sentence is exempt, as in WCAG.
    if (
      fact.interactive &&
      rect.w > 0 &&
      rect.h > 0 &&
      Math.min(rect.w, rect.h) < MIN_TARGET &&
      fact.display !== 'inline'
    ) {
      add(
        'small-target',
        fact,
        `The target is ${Math.round(rect.w)} × ${Math.round(rect.h)} px, under ${MIN_TARGET} px`,
      );
    }
    if (hasText && !fact.backgroundImage) {
      const fg = parseColor(fact.color);
      const bg = parseColor(fact.background);
      if (fg && bg) {
        const ratio = contrast(fg, [bg[0], bg[1], bg[2], 1]);
        const needed = isLarge(fact) ? 3 : 4.5;
        if (ratio < needed) {
          add(
            'low-contrast',
            fact,
            `Contrast ${ratio.toFixed(2)}:1, ${needed}:1 needed (${fact.color} on ${fact.background})`,
          );
        }
      }
    }
  }

  const targets = input.facts.filter((fact) => fact.interactive && area(fact.rect) > 0);
  for (const [index, a] of targets.entries()) {
    for (const b of targets.slice(index + 1)) {
      if (related(a.path, b.path)) continue;
      const shared = overlapArea(a.rect, b.rect);
      if (shared > 0.2 * Math.min(area(a.rect), area(b.rect))) {
        add('overlap', a, `Overlaps ${b.path} (${b.text || b.tag}) by ${Math.round(shared)} px²`);
      }
    }
  }
  return issues;
}

export interface LayoutReport {
  readonly viewport: LayoutInput['viewport'];
  readonly elements: number;
  readonly truncated: boolean;
  readonly counts: Partial<Record<IssueKind, number>>;
  readonly issues: Issue[];
}

export function report(input: LayoutInput): LayoutReport {
  const issues = audit(input);
  const counts: Partial<Record<IssueKind, number>> = {};
  for (const issue of issues) counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
  return {
    viewport: input.viewport,
    elements: input.facts.length,
    truncated: input.truncated,
    counts,
    issues,
  };
}
