// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — interface languages (site/i18n.js, site/locales/*.js): language choice with English fallback,
// complete translations (same keys, same placeholders, every plural form the language needs), formatting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGS, pickLang, detectLang, setLocale, t, num, countryName, regionName } from '../site/i18n.js';
import en from '../site/locales/en.js';

const load = async (l) => (await import(`../site/locales/${l}.js`)).default;
const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const forms = (v) => (typeof v === 'object' ? Object.values(v) : [v]);

test('ten languages; browser preference picks the first supported one, else English', () => {
  assert.equal(Object.keys(LANGS).length, 10);
  assert.equal(pickLang(['de-AT', 'en']), 'de');
  assert.equal(pickLang(['sv-SE', 'pt-BR']), 'pt');
  assert.equal(pickLang(['zh-CN', 'ru']), 'en');
  assert.equal(pickLang([]), 'en');
  assert.equal(pickLang(['ko_KR']), 'ko');
  const win = (search, langs, stored = null) => ({ location: { search }, navigator: { languages: langs }, localStorage: { getItem: () => stored } });
  assert.equal(detectLang(win('', ['fr-CA', 'en'])), 'fr');
  assert.equal(detectLang(win('?lang=ja', ['fr-CA'])), 'ja');
  assert.equal(detectLang(win('?lang=xx', ['fr-CA'])), 'fr');
  assert.equal(detectLang(win('', ['fr-CA'], 'nl')), 'nl');
  assert.equal(detectLang({ location: { search: '' }, navigator: { languages: ['ru'] }, get localStorage() { throw new Error('blocked'); } }), 'en');
});

for (const l of Object.keys(LANGS).filter((x) => x !== 'en')) {
  test(`locale ${l}: same keys and placeholders as English, all plural forms`, async () => {
    const d = await load(l);
    assert.deepEqual(Object.keys(d).sort(), Object.keys(en).sort(), 'keys');
    const cats = new Intl.PluralRules(l).resolvedOptions().pluralCategories;
    for (const [k, v] of Object.entries(en)) {
      const ph = holes(forms(v).find((x) => x.includes('{')) ?? '');
      for (const s of forms(d[k])) {
        assert.equal(typeof s, 'string', `${k}`);
        assert.ok(s.trim(), `${k} empty`);
        if (!(typeof v === 'object')) assert.equal(holes(s), holes(v), `${k} placeholders`);
        else assert.ok(holes(s).split(',').every((h) => !h || ph.split(',').includes(h)), `${k} placeholders`);
      }
      if (typeof v === 'object') for (const c of cats) assert.ok(c in d[k] || 'other' in d[k], `${k}: ${c}`);
      if (typeof v === 'object') assert.ok('other' in d[k], `${k}: other`);
    }
  });
}

test('t: placeholders, plurals with formatted numbers, fallback to English and to the key', async () => {
  setLocale('de', await load('de'));
  assert.equal(t('stack.title', { n: 1 }), '1 Video an diesem Ort');
  assert.equal(t('stack.title', { n: 1200 }), '1.200 Videos an diesem Ort');
  assert.equal(t('detail.loc', { l: 2, name: 'Verankert' }), 'Lokalisierung: 2 · Verankert');
  assert.equal(num(1234.5), '1.234,5');
  assert.equal(countryName('IT'), 'Italien');
  assert.equal(regionName('Alps'), 'Alpen');
  assert.equal(regionName('Nowhere'), 'Nowhere');
  setLocale('pl', await load('pl'));
  assert.notEqual(t('f.show', { n: 2 }), t('f.show', { n: 5 }), 'Polish few/many');
  setLocale('ja', await load('ja'));
  assert.equal(countryName('FR'), 'フランス');
  setLocale('en');
  assert.equal(t('f.show', { n: 3 }), 'Show 3 videos');
  assert.equal(t('no.such.key'), 'no.such.key');
});
