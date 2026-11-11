// SPDX-License-Identifier: AGPL-3.0-or-later

import { record } from './common.ts';

/**
 * A small XML writer for the ZWO and TCX exporters: ordered attributes, text and comments, and the
 * JSON nodes the importers keep in `extensions` (`{ name, attributes?, children? }`, `{ text }`,
 * `{ comment }`) written back as they were.
 */
export type XNode =
  | {
      readonly name: string;
      readonly attrs: readonly (readonly [string, string])[];
      readonly children: readonly XNode[];
    }
  | { readonly text: string }
  | { readonly cdata: string }
  | { readonly comment: string };

export const el = (
  name: string,
  attrs: readonly (readonly [string, string])[] = [],
  children: readonly XNode[] = [],
): XNode => ({ name, attrs, children });

/** An element with only text. */
export const textEl = (name: string, text: string): XNode => el(name, [], [{ text }]);

const escapeText = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const escapeAttr = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\t', '&#9;');

/** An extension's JSON node as an XML node; anything that is not one is dropped. */
export function fromJson(value: unknown): XNode | undefined {
  const node = record(value);
  if (!node) return undefined;
  if (typeof node.text === 'string') return { text: node.text };
  if (typeof node.comment === 'string') return { comment: node.comment };
  if (typeof node.name !== 'string') return undefined;
  const attributes = record(node.attributes) ?? {};
  const children = Array.isArray(node.children)
    ? node.children.flatMap((child) => fromJson(child) ?? [])
    : [];
  return el(
    node.name,
    Object.entries(attributes).map(([k, v]) => [k, String(v)] as const),
    children,
  );
}

/** `{ index, node }` pairs as `Kids.rest()` keeps them. */
export function placedNodes(value: unknown): { index: number; node: XNode }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = record(entry);
    const node = item ? fromJson(item.node) : undefined;
    return item && node && typeof item.index === 'number' ? [{ index: item.index, node }] : [];
  });
}

/**
 * The children of an element: `known` ones in their order, with the `placed` unknown ones at the
 * position they had among all the element's children (the importers store it as `index`).
 */
export function interleave<T>(
  known: readonly T[],
  placed: readonly { index: number; node: T }[],
): T[] {
  const out: T[] = [];
  const byIndex = new Map<number, T[]>();
  for (const { index, node } of placed) byIndex.set(index, [...(byIndex.get(index) ?? []), node]);
  let next = 0;
  const total = known.length + placed.length;
  for (let position = 0; position < total; position += 1) {
    const here = byIndex.get(position);
    if (here) {
      out.push(...here);
      byIndex.delete(position);
      // A position taken twice pushes the rest of the row back by one place.
      continue;
    }
    const item = known[next];
    if (item !== undefined) {
      out.push(item);
      next += 1;
    }
  }
  for (const rest of byIndex.values()) out.push(...rest);
  while (next < known.length) {
    out.push(known[next] as T);
    next += 1;
  }
  return out;
}

const INDENT = '    ';

function render(node: XNode, level: number, indent: string, lines: string[]): void {
  const pad = indent.repeat(level);
  if ('text' in node) {
    lines.push(`${pad}${escapeText(node.text)}`);
    return;
  }
  if ('cdata' in node) {
    lines.push(`${pad}<![CDATA[${node.cdata}]]>`);
    return;
  }
  if ('comment' in node) {
    lines.push(`${pad}<!--${node.comment}-->`);
    return;
  }
  const open = `<${node.name}${node.attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')}`;
  if (node.children.length === 0) {
    lines.push(`${pad}${open}/>`);
    return;
  }
  const inline = node.children.every((c) => 'text' in c || 'cdata' in c);
  if (inline) {
    const body = node.children
      .map((c) => ('text' in c ? escapeText(c.text) : 'cdata' in c ? `<![CDATA[${c.cdata}]]>` : ''))
      .join('');
    lines.push(`${pad}${open}>${body}</${node.name}>`);
    return;
  }
  lines.push(`${pad}${open}>`);
  for (const child of node.children) render(child, level + 1, indent, lines);
  lines.push(`${pad}</${node.name}>`);
}

/** The document: an optional declaration, then the element, one line each, LF. */
export function renderXml(
  root: XNode,
  options: { declaration?: string; indent?: string } = {},
): string {
  const lines: string[] = options.declaration ? [options.declaration] : [];
  render(root, 0, options.indent ?? INDENT, lines);
  return `${lines.join('\n')}\n`;
}
