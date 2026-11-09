// SPDX-License-Identifier: AGPL-3.0-or-later

// Runs in the page of the dev app (loaded by the debug bridge on request, never in a build):
// reads what the page renders, as plain data. The judging is in audit.ts, away from the DOM.

const SKIPPED = new Set([
  'SCRIPT',
  'STYLE',
  'HEAD',
  'META',
  'LINK',
  'NOSCRIPT',
  'TEMPLATE',
  'TITLE',
]);
const INTERACTIVE =
  'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], ' +
  '[role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';

const words = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

/** All the text under a node, the text of two elements apart: `<b>9 Nov</b><i>today</i>` is "9 Nov today". */
const textOf = (node) =>
  words(
    [...node.childNodes]
      .map((child) =>
        child.nodeType === 3 ? child.textContent : child.nodeType === 1 ? textOf(child) : '',
      )
      .join(' '),
  );

const visible = (element, style) =>
  style.display !== 'none' &&
  style.visibility !== 'hidden' &&
  (typeof element.checkVisibility !== 'function' || element.checkVisibility());

/** The text a node holds itself, not its children's. */
const ownText = (element) =>
  words(
    [...element.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent)
      .join(' '),
  );

const position = (element) => {
  const siblings = element.parentElement ? [...element.parentElement.children] : [element];
  return `${element.tagName.toLowerCase()}:${siblings.indexOf(element)}`;
};

/** The first non-transparent background up the tree, and whether an image lies behind before it. */
function backgroundOf(element) {
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.backgroundImage !== 'none') return { background: 'rgb(255, 255, 255)', image: true };
    const alpha = /,\s*([\d.]+)\)$/.exec(style.backgroundColor);
    if (
      style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
      style.backgroundColor !== 'transparent' &&
      (!alpha || Number(alpha[1]) > 0)
    ) {
      return { background: style.backgroundColor, image: false };
    }
  }
  return { background: 'rgb(255, 255, 255)', image: false };
}

const clippedAbove = (element) => {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== 'visible') return true;
  }
  return false;
};

/** The facts `audit` in audit.ts judges: one per visible element, at most `limit`. */
export function collectLayout(root = document.body, limit = 3000) {
  const facts = [];
  let truncated = false;
  const paths = new Map([[root, root.tagName.toLowerCase()]]);
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (SKIPPED.has(element.tagName)) continue;
    const style = getComputedStyle(element);
    if (!visible(element, style)) continue;
    const parentPath = element.parentElement ? paths.get(element.parentElement) : undefined;
    const path =
      element === root
        ? paths.get(root)
        : parentPath === undefined
          ? position(element)
          : `${parentPath} > ${position(element)}`;
    paths.set(element, path);
    if (facts.length >= limit) {
      truncated = true;
      break;
    }
    const rect = element.getBoundingClientRect();
    const behind = backgroundOf(element);
    facts.push({
      path,
      tag: element.tagName.toLowerCase(),
      text: ownText(element).slice(0, 40),
      interactive: element.matches(INTERACTIVE),
      display: style.display,
      rect: {
        x: Math.round(rect.x * 10) / 10,
        y: Math.round(rect.y * 10) / 10,
        w: Math.round(rect.width * 10) / 10,
        h: Math.round(rect.height * 10) / 10,
      },
      scrollW: element.scrollWidth,
      clientW: element.clientWidth,
      scrollH: element.scrollHeight,
      clientH: element.clientHeight,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
      color: style.color,
      background: behind.background,
      backgroundImage: behind.image,
      clippedByAncestor: clippedAbove(element),
    });
  }
  return {
    viewport: { width: innerWidth, height: innerHeight },
    documentScrollWidth: document.documentElement.scrollWidth,
    facts,
    truncated,
  };
}

const TAG_ROLES = {
  a: (e) => (e.hasAttribute('href') ? 'link' : undefined),
  article: () => 'article',
  aside: () => 'complementary',
  button: () => 'button',
  dialog: () => 'dialog',
  footer: () => 'contentinfo',
  form: () => 'form',
  h1: () => 'heading',
  h2: () => 'heading',
  h3: () => 'heading',
  h4: () => 'heading',
  h5: () => 'heading',
  h6: () => 'heading',
  header: () => 'banner',
  img: (e) => (e.getAttribute('alt') === '' ? 'presentation' : 'img'),
  input: (e) =>
    ({
      checkbox: 'checkbox',
      radio: 'radio',
      range: 'slider',
      search: 'searchbox',
      button: 'button',
      submit: 'button',
      hidden: undefined,
    })[e.type] ?? 'textbox',
  li: () => 'listitem',
  main: () => 'main',
  nav: () => 'navigation',
  ol: () => 'list',
  section: (e) =>
    e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby') ? 'region' : undefined,
  select: () => 'combobox',
  table: () => 'table',
  td: () => 'cell',
  textarea: () => 'textbox',
  th: (e) => (e.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader'),
  tr: () => 'row',
  ul: () => 'list',
};

const roleOf = (element) =>
  element.getAttribute('role')?.split(/\s+/)[0] ??
  TAG_ROLES[element.tagName.toLowerCase()]?.(element);

/** The accessible name, by the main rules: aria-labelledby, aria-label, label, alt, content, title. */
function nameOf(element, role) {
  const labelled = element.getAttribute('aria-labelledby');
  if (labelled) {
    return words(
      labelled
        .split(/\s+/)
        .map((id) => textOf(element.ownerDocument.getElementById(id) ?? { childNodes: [] }))
        .join(' '),
    );
  }
  if (element.hasAttribute('aria-label')) return words(element.getAttribute('aria-label'));
  if (element.labels?.length) return words([...element.labels].map(textOf).join(' '));
  if (role === 'img') return words(element.getAttribute('alt'));
  if (element.tagName === 'INPUT' && ['button', 'submit'].includes(element.type))
    return words(element.value);
  const fromContent = [
    'button',
    'link',
    'heading',
    'cell',
    'columnheader',
    'rowheader',
    'tab',
    'menuitem',
    'listitem',
    'checkbox',
    'radio',
    'switch',
    'region',
  ];
  if (fromContent.includes(role)) return textOf(element);
  return words(element.getAttribute('title'));
}

const STATES = [
  'aria-pressed',
  'aria-checked',
  'aria-expanded',
  'aria-selected',
  'aria-current',
  'aria-disabled',
];

/** The roles and names of the page, as a screen reader finds them: elements without a role are passed through. */
export function accessibilityTree(root = document.body) {
  const walk = (element) => {
    if (
      SKIPPED.has(element.tagName) ||
      element.getAttribute('aria-hidden') === 'true' ||
      element.hidden
    )
      return [];
    if (getComputedStyle(element).display === 'none') return [];
    const children = [...element.children].flatMap(walk);
    const role = roleOf(element);
    if (role === undefined || role === 'presentation' || role === 'none') return children;
    const node = { role, name: nameOf(element, role) };
    if (/^h[1-6]$/.test(element.tagName.toLowerCase())) node.level = Number(element.tagName[1]);
    const states = {};
    for (const state of STATES) {
      if (element.hasAttribute(state)) states[state.slice(5)] = element.getAttribute(state);
    }
    if (element.disabled) states.disabled = 'true';
    if (element.checked) states.checked = 'true';
    if (Object.keys(states).length > 0) node.states = states;
    // A button's or link's children are its name; a text field has none.
    if (children.length > 0 && !['button', 'link', 'heading', 'img'].includes(role))
      node.children = children;
    return [node];
  };
  return walk(root);
}
