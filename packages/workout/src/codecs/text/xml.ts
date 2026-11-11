// SPDX-License-Identifier: AGPL-3.0-or-later

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ImportError } from './common.ts';

/**
 * XML for the ZWO and TCX importers (ADR 0066's parser): a small ordered tree that keeps the order
 * of attributes and children, and an `Attrs` / `Kids` pair that lets an importer take what it maps
 * and hand everything else to `extensions.<format>` as JSON (`XmlJson`), so nothing is lost.
 */

export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}
export type XmlNode = XmlElement | { readonly text: string } | { readonly comment: string };

/** An element, text or comment as plain JSON: the form unknown nodes take in the extensions. */
export type XmlJson =
  | {
      name: string;
      attributes?: Record<string, string>;
      children?: XmlJson[];
    }
  | { text: string }
  | { comment: string };

export const isElement = (node: XmlNode): node is XmlElement => 'name' in node;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  commentPropName: '#comment',
  ignoreDeclaration: true,
  ignorePiTags: true,
});

type Raw = Record<string, unknown>;

function convert(items: unknown): XmlNode[] {
  const nodes: XmlNode[] = [];
  for (const item of (items as Raw[] | undefined) ?? []) {
    const key = Object.keys(item).find((k) => k !== ':@');
    if (key === undefined) continue;
    if (key === '#text') {
      nodes.push({ text: String(item[key]) });
    } else if (key === '#comment') {
      const inner = item[key] as Raw[];
      nodes.push({ comment: inner.map((i) => String(i['#text'] ?? '')).join('') });
    } else {
      nodes.push({
        name: key,
        attributes: (item[':@'] as Record<string, string> | undefined) ?? {},
        children: convert(item[key]),
      });
    }
  }
  return nodes;
}

/** Parses an XML document into its root element; a broken document is refused with its place. */
export function parseXml(text: string): XmlElement {
  const valid = XMLValidator.validate(text);
  if (valid !== true) {
    const { code, msg, line, col } = valid.err;
    throw new ImportError(
      'invalid-xml',
      `The file is not well-formed XML (${code}, line ${line}, column ${col}): ${msg}`,
      `line ${line}`,
    );
  }
  const root = convert(parser.parse(text)).find(isElement);
  if (!root) throw new ImportError('invalid-xml', 'The file has no XML element.');
  return root;
}

export const elementsOf = (element: XmlElement): XmlElement[] => element.children.filter(isElement);

/** The text directly inside an element, as written, trimmed. */
export const textOf = (element: XmlElement): string =>
  element.children
    .filter((n): n is { text: string } => 'text' in n)
    .map((n) => n.text)
    .join('')
    .trim();

export function toJson(node: XmlNode): XmlJson {
  if (!isElement(node)) return node;
  return {
    name: node.name,
    ...(Object.keys(node.attributes).length > 0 ? { attributes: { ...node.attributes } } : {}),
    ...(node.children.length > 0 ? { children: node.children.map(toJson) } : {}),
  };
}

/** The attributes of one element: what an importer takes is marked, the rest is returned verbatim. */
export class Attrs {
  readonly names: string[];
  private readonly values = new Map<string, string>();
  private readonly lower = new Map<string, string>();
  private readonly taken = new Set<string>();
  constructor(element: XmlElement) {
    this.names = Object.keys(element.attributes);
    for (const name of this.names) {
      this.values.set(name, element.attributes[name] ?? '');
      if (!this.lower.has(name.toLowerCase())) this.lower.set(name.toLowerCase(), name);
    }
  }
  /** The value of an attribute (found regardless of case); it is no longer "rest". */
  take(name: string): string | undefined {
    const actual = this.lower.get(name.toLowerCase());
    if (actual === undefined) return undefined;
    this.taken.add(actual);
    return this.values.get(actual);
  }
  /** The value of an attribute without taking it, to check it before it is taken. */
  peek(name: string): string | undefined {
    const actual = this.lower.get(name.toLowerCase());
    return actual === undefined ? undefined : this.values.get(actual);
  }
  /** The attributes nobody took, in source order. */
  rest(): Record<string, string> | undefined {
    const rest = this.names.filter((n) => !this.taken.has(n));
    return rest.length === 0
      ? undefined
      : Object.fromEntries(rest.map((n) => [n, this.values.get(n) ?? '']));
  }
}

/** The child nodes of one element: elements by name, the unknown ones returned with their position. */
export class Kids {
  readonly elements: XmlElement[];
  private readonly taken = new Set<XmlElement>();
  constructor(element: XmlElement) {
    this.elements = elementsOf(element);
  }
  /** Every child with a name (case-insensitive), in order; they are no longer "rest". */
  takeAll(name: string): XmlElement[] {
    const found = this.elements.filter(
      (e) => e.name.toLowerCase() === name.toLowerCase() && !this.taken.has(e),
    );
    for (const e of found) this.taken.add(e);
    return found;
  }
  /** The first child with that name; later ones with the same name stay "rest". */
  takeFirst(name: string): XmlElement | undefined {
    const found = this.elements.find(
      (e) => e.name.toLowerCase() === name.toLowerCase() && !this.taken.has(e),
    );
    if (found) this.taken.add(found);
    return found;
  }
  /** Marks children as taken without reading them. */
  take(element: XmlElement): void {
    this.taken.add(element);
  }
  /** Children nobody took, with their place among the element's children, as JSON. */
  rest(): { index: number; node: XmlJson }[] | undefined {
    const rest = this.elements
      .map((e, index) => ({ e, index }))
      .filter(({ e }) => !this.taken.has(e))
      .map(({ e, index }) => ({ index, node: toJson(e) }));
    return rest.length === 0 ? undefined : rest;
  }
}
