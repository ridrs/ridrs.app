// SPDX-License-Identifier: AGPL-3.0-or-later
// Interface language of ridrs Scenic. The page follows the browser language (navigator.languages); a language
// outside LANGS falls back to English. ?lang=xx and the language menu in the footer override it (stored per browser).
// Texts live in locales/<lang>.js ({key: text}); English is bundled and fills keys a translation lacks.
// Placeholders: {name}. Plurals: an object per Intl.PluralRules category ({one, few, many, other}) with {n}.
// Without initI18n (node tests, admin) the language is English until setLocale is called.
import en from './locales/en.js';

/** The ten languages of the target group (indoor cycling platforms, road-trip and POV-drive viewers). */
export const LANGS = {
  en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano',
  nl: 'Nederlands', pt: 'Português', pl: 'Polski', ja: '日本語', ko: '한국어',
};
export const FALLBACK = 'en';
const STORE = 'ridrs-scenic.lang';

let lang = FALLBACK, dict = en, plural = new Intl.PluralRules(FALLBACK), regionNames = null;

/** First supported language of a preference list (BCP 47 tags, e.g. navigator.languages), else English. */
export function pickLang(prefs = []) {
  for (const p of prefs) {
    const base = String(p || '').toLowerCase().split(/[-_]/)[0];
    if (base in LANGS) return base;
  }
  return FALLBACK;
}

/** Language for this page view: ?lang=, then the stored choice, then the browser languages. */
export function detectLang(win = globalThis) {
  const q = new URLSearchParams(win.location?.search ?? '').get('lang');
  let stored = null;
  try { stored = win.localStorage?.getItem(STORE); } catch { /* storage blocked */ }
  return pickLang([q, stored, ...(win.navigator?.languages ?? [win.navigator?.language])]);
}

/** Store an explicit choice (language menu); null goes back to the browser language. */
export function rememberLang(l) {
  try { if (l) localStorage.setItem(STORE, l); else localStorage.removeItem(STORE); } catch { /* storage blocked */ }
}

export function setLocale(l, d) {
  lang = l in LANGS ? l : FALLBACK;
  dict = d ?? (lang === FALLBACK ? en : dict);
  plural = new Intl.PluralRules(lang);
  try { regionNames = new Intl.DisplayNames([lang], { type: 'region' }); } catch { regionNames = null; }
}

/** Loads the texts of the detected language and sets <html lang>. */
export async function initI18n(win = globalThis) {
  const l = detectLang(win);
  const d = l === FALLBACK ? en : (await import(`./locales/${l}.js`).catch(() => ({ default: en }))).default;
  setLocale(l, d);
  if (win.document) win.document.documentElement.lang = lang;
  return lang;
}

export const getLang = () => lang;

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/** Text for key; vars fill {placeholders}; vars.n picks the plural form and is shown formatted. */
export function t(key, vars = {}) {
  let s = dict[key] ?? en[key];
  if (s == null) return key;
  if (typeof s === 'object') s = s[plural.select(vars.n ?? 0)] ?? s.other;
  return fill(s, 'n' in vars ? { ...vars, n: num(vars.n) } : vars);
}
/** Text for key, or null when no language has it (optional translations, e.g. topics). */
export const tMaybe = (key, vars) => (key in dict || key in en ? t(key, vars) : null);

export const num = (n, opts) => (n ?? 0).toLocaleString(lang, opts);
export const date = (d) => new Date(d).toLocaleDateString(lang);
/** Country name in the interface language (ISO code), else the given fallback. */
export const countryName = (code, fallback) => {
  if (!code) return fallback ?? '';
  try { return regionNames?.of(code) ?? fallback ?? code; } catch { return fallback ?? code; }
};
export const regionName = (r) => (r ? tMaybe(`region.${r}`) ?? r : '');
export const topicName = (x) => tMaybe(`topic.${x}`) ?? x;

/** Static markup: data-i18n="key" sets the text, data-i18n-attr="attr:key;attr:key" sets attributes. */
export function translateDom(root = globalThis.document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) { const [a, k] = pair.split(':'); if (a && k) el.setAttribute(a.trim(), t(k.trim())); }
  }
}

/** Language menu (<select>): the ten languages; a change stores the choice and reloads. */
export function mountLangMenu(select) {
  if (!select) return;
  select.innerHTML = Object.entries(LANGS).map(([k, name]) => `<option value="${k}"${k === lang ? ' selected' : ''}>${name}</option>`).join('');
  select.addEventListener('change', () => {
    rememberLang(select.value);
    const u = new URL(location.href); u.searchParams.delete('lang');
    location.replace(u);
  });
}
