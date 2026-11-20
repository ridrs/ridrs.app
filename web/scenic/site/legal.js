// SPDX-License-Identifier: AGPL-3.0-or-later
// Legal pages (lizenz, impressum, datenschutz): each holds a German <main lang="de"> (binding) and an English
// <main lang="en">. German browsers see German, every other language English (site/i18n.js detectLang;
// ?lang=de / ?lang=en switch). The page title comes from the shown block's data-title.
import { detectLang } from './i18n.js';

const show = detectLang() === 'de' ? 'de' : 'en';
for (const m of document.querySelectorAll('main[lang]')) m.hidden = m.lang !== show;
document.documentElement.lang = show;
const main = document.querySelector(`main[lang="${show}"]`);
if (main?.dataset.title) document.title = main.dataset.title;

// Mail addresses are put together here, so simple address harvesters do not find them in the HTML.
for (const el of document.querySelectorAll('.mail[data-u][data-d]')) {
  const a = document.createElement('a');
  a.href = `mailto:${el.dataset.u}@${el.dataset.d}`;
  a.textContent = `${el.dataset.u}@${el.dataset.d}`;
  el.replaceWith(a);
}
