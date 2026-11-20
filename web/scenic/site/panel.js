// SPDX-License-Identifier: AGPL-3.0-or-later
// Filter panel, quick chips and active-filter chips (FILTER-PLAN.md, UI 1–4, 7, 8).
// Builds the DOM once; sync(state, facets, total) updates values and live counts in place, so focus and
// scroll position survive every filter change. All changes go out through onChange(patch, mode):
//   mode 'push'    discrete change, new history entry
//   mode 'gesture' slider drag or typing: one history entry for the whole gesture (ended by endGesture)
import { RANGES, RES_OPTIONS, resLabel, BR_OPTIONS, VIEWS_OPTIONS, LOC_OPTIONS, STARS_OPTIONS, QUICK, PRESETS,
  flag, activeChips, defaults, norm, chKey, ROADS, roadName, UNP_OPTIONS, unpLabel, unitLabel } from './filters.js';
import { t, num, getLang, regionName, topicName } from './i18n.js';

const fmt = (n) => num(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STORE = 'ridrs-scenic.sections';
const OPEN_DEFAULT = { ort: true, strecke: true, bild: true, video: false, inhalt: false };
const CHANNELS_SHOWN = 40; // without a search term, the channel list shows the biggest channels (and every selected one)

const loadOpen = () => { try { return { ...OPEN_DEFAULT, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch { return { ...OPEN_DEFAULT }; } };
const saveOpen = (o) => { try { localStorage.setItem(STORE, JSON.stringify(o)); } catch { /* private mode */ } };

const viewsLabel = (v) => (v ? num(v, v >= 1_000_000 ? { notation: 'compact' } : undefined) : t('common.all'));

export function mountPanel({ panel, quick, active, toggle, badge, videos, countryNames, levels, onChange, endGesture, onClose }) {
  const open = loadOpen();
  const has = { stars: videos.some((v) => v.stars), pick: videos.some((v) => v.pick) };
  // Stable option order: by count over all videos (a live re-sort would move options under the pointer).
  const countBy = (key) => { const m = new Map(); for (const v of videos) for (const x of [].concat(v[key] ?? [])) if (x != null) m.set(x, (m.get(x) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), getLang())).map((e) => e[0]); };
  const chNames = {};
  for (const v of videos) { const k = chKey(v); if (k && !chNames[k]) chNames[k] = v.channel || k; }
  const countries = countBy('country'), regions = countBy('region'), topics = countBy('topics');
  const channels = (() => { const m = new Map(); for (const v of videos) { const k = chKey(v); if (k) m.set(k, (m.get(k) ?? 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]).map((e) => e[0]); })();
  const techKnown = videos.filter((v) => v.height).length;

  const sec = (id, title, body) => `<details class="sec" data-sec="${id}"${open[id] ? ' open' : ''}><summary>${title}</summary><div class="sec-body">${body}</div></details>`;
  const seg = (k, label, opts) => `<fieldset class="seg" data-k="${k}"><legend>${label}</legend><div class="opts">${opts.map((o) =>
    `<label${o.title ? ` title="${esc(o.title)}"` : ''}><input type="radio" name="f-${k}" value="${o.v}"><span>${o.text}</span><small data-n></small></label>`).join('')}</div></fieldset>`;
  const check = (k, label) => `<label class="chk" data-k="${k}"><input type="checkbox"><span>${label}</span><small data-n></small></label>`;
  const range2 = (k, label) => {
    const r = RANGES[k], u = unitLabel(k), from = esc(t('f.from_aria', { label })), to = esc(t('f.to_aria', { label }));
    return `<fieldset class="range2" data-k="${k}"><legend>${label} <small class="hint" data-hint></small></legend>
      <div class="track"><input type="range" class="lo" min="${r.min}" max="${r.max}" step="${r.step}" aria-label="${from}">
        <input type="range" class="hi" min="${r.min}" max="${r.max}" step="${r.step}" aria-label="${to}"></div>
      <div class="nums"><input type="number" class="nlo" min="${r.min}" step="${r.step}" placeholder="${r.min}" aria-label="${from}${u ? ` (${u})` : ''}">
        <span>–</span><input type="number" class="nhi" min="${r.min}" step="${r.step}" placeholder="${k === 'yr' ? r.max : `${r.max}+`}" aria-label="${to}${u ? ` (${u})` : ''}">
        <span>${u}</span></div></fieldset>`;
  };
  const multi = (k, label, placeholder, items, text) => `<div class="multi" data-k="${k}"><label class="lbl" for="f-${k}-q">${label}</label>
    <input type="search" id="f-${k}-q" placeholder="${placeholder}" autocomplete="off">
    <div class="list" role="group" aria-label="${label}">${items.map((x, i) =>
      `<label data-v="${esc(x)}" data-i="${i}"><input type="checkbox" value="${esc(x)}"><span>${text(x)}</span><small data-n></small></label>`).join('')}</div>
    <p class="more meta" hidden></p></div>`;

  panel.innerHTML = `
    <div class="panel-head"><h2>${t('panel.title')}</h2><button type="button" class="x" aria-label="${esc(t('panel.close'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="presets"><span class="eyebrow">${t('panel.suggestions')}</span>${PRESETS.map((p, i) => `<button type="button" class="pill" data-preset="${i}">${t(p.label)}</button>`).join('')}</div>
    <div class="panel-scroll">
      ${sec('ort', t('sec.place'), `
        ${multi('c', t('f.country'), t('f.country_search'), countries, (c) => `${flag(c)} ${esc(countryNames[c] ?? c)}`)}
        <label class="lbl" for="f-reg">${t('f.region')}</label>
        <select id="f-reg" data-k="reg"><option value="">${t('f.region_all')}</option>${regions.map((r) => `<option value="${esc(r)}">${esc(regionName(r))}</option>`).join('')}</select>
        ${topics.length ? `<div class="lbl">${t('f.topic')}</div><div class="chips" data-k="tp" role="group" aria-label="${esc(t('f.topic'))}">${topics.map((x) =>
          `<button type="button" class="pill" data-v="${esc(x)}" aria-pressed="false">${esc(topicName(x))} <small data-n></small></button>`).join('')}</div>` : ''}`)}
      ${sec('strecke', t('sec.route'), `
        ${seg('loc', t('f.loc_min'), LOC_OPTIONS.map((l) => ({ v: l, text: l === 7 ? t('common.all') : String(l),
          title: l < 7 ? t('f.loc_or_better', { l, name: levels[l]?.[0] ?? '' }) : `${l} · ${levels[l]?.[0] ?? ''}` })))}
        <p class="meta loc-name" data-loc-name></p>
        ${range2('km', t('f.length'))}
        ${range2('dur', t('f.duration'))}
        ${range2('asc', t('f.ascent'))}
        <div class="lbl">${t('f.road_main')}</div><div class="chips" data-k="road" role="group" aria-label="${esc(t('f.road_main'))}">${ROADS.filter((r) => videos.some((v) => v.road === r)).map((r) =>
          `<button type="button" class="pill" data-v="${r}" aria-pressed="false">${roadName(r)} <small data-n></small></button>`).join('')}</div>
        ${seg('unp', t('f.surface'), UNP_OPTIONS.map((u) => ({ v: u, text: unpLabel(u), title: u ? t(`unp.${u}_title`) : '' })))}`)}
      ${sec('bild', t('sec.picture'), `
        ${seg('res', t('f.res_min'), RES_OPTIONS.map((r) => ({ v: r, text: resLabel(r) })))}
        ${seg('fps', t('f.fps'), [{ v: 0, text: t('common.all') }, { v: 50, text: '≥ 50 fps' }])}
        ${check('hdr', 'HDR')}
        ${seg('br', t('f.br_min'), BR_OPTIONS.map((b) => ({ v: b, text: b ? `${b} Mbit/s` : t('common.all') })))}
        <p class="meta">${t('f.tech_note', { a: fmt(techKnown), b: fmt(videos.length) })}</p>`)}
      ${sec('video', t('sec.video'), `
        ${range2('yr', t('f.published'))}
        ${seg('views', t('f.views_min'), VIEWS_OPTIONS.map((v) => ({ v, text: viewsLabel(v) })))}
        ${multi('ch', t('f.channel'), t('f.channel_search'), channels, (c) => esc(chNames[c]))}
        ${check('emb', t('f.emb_only'))}
        ${has.stars ? seg('stars', t('f.stars_min'), STARS_OPTIONS.map((s) => ({ v: s, text: s ? `${s} ★` : t('common.all') }))) : ''}
        ${has.pick ? check('pick', t('f.pick_only')) : ''}`)}
      ${sec('inhalt', t('sec.content'), `${check('vr', t('f.vr_show'))}${check('sim', t('f.sim_show'))}`)}
    </div>
    <div class="panel-foot"><button type="button" class="link" data-reset>${t('f.reset')}</button>
      <button type="button" class="btn btn-primary show" data-show></button></div>`;

  quick.innerHTML = QUICK.map((q) => `<button type="button" class="pill" data-quick="${q.id}" aria-pressed="false">${q.label ? t(q.label) : q.text} <small data-n></small></button>`).join('')
    + `<button type="button" class="pill view" data-quick="view" aria-pressed="false">${t('chip.view')}</button>`;

  const $ = (s, root = panel) => root.querySelector(s);
  const $$ = (s, root = panel) => [...root.querySelectorAll(s)];
  let state = defaults();
  const set = (patch, mode = 'push') => onChange(patch, mode);

  // --- events ---
  panel.addEventListener('toggle', (e) => {
    const d = e.target.closest?.('details.sec');
    if (d) { open[d.dataset.sec] = d.open; saveOpen(open); }
  }, true);
  panel.addEventListener('change', (e) => {
    const t = e.target, box = t.closest('[data-k]'), k = box?.dataset.k;
    if (!k) return;
    if (t.type === 'radio') set({ [k]: +t.value });
    else if (t.type === 'checkbox' && box.classList.contains('chk')) set({ [k]: t.checked });
    else if (t.type === 'checkbox') {
      const cur = state[k];
      set({ [k]: t.checked ? [...cur, t.value] : cur.filter((x) => x !== t.value) });
    } else if (t.tagName === 'SELECT') set({ reg: t.value });
    else if (t.type === 'range') endGesture();
    else if (t.type === 'number') {
      const r = RANGES[k], lo = $('.nlo', box).value, hi = $('.nhi', box).value;
      let v = [lo === '' ? null : +lo, hi === '' ? null : +hi];
      if (v[0] != null && v[0] <= r.min) v[0] = null;
      if (v[0] != null && v[1] != null && v[0] > v[1]) v = [v[1], v[0]];
      set({ [k]: v });
    }
  });
  panel.addEventListener('input', (e) => {
    const t = e.target, box = t.closest('[data-k]'), k = box?.dataset.k;
    if (t.type === 'range') {
      const r = RANGES[k], lo = $('.lo', box), hi = $('.hi', box);
      if (+lo.value > +hi.value) (t === lo ? hi : lo).value = t.value; // handles push each other
      const v = [+lo.value <= r.min ? null : +lo.value, +hi.value >= r.max ? null : +hi.value];
      set({ [k]: v }, 'gesture');
    } else if (t.type === 'search' && box?.classList.contains('multi')) {
      filterList(box);
    }
  });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.preset != null) set(PRESETS[+b.dataset.preset].patch);
    else if (b.closest('.chips[data-k]')) { const k = b.closest('.chips').dataset.k, v = b.dataset.v; set({ [k]: state[k].includes(v) ? state[k].filter((x) => x !== v) : [...state[k], v] }); }
    else if (b.hasAttribute('data-reset')) set(resetPatch());
    else if (b.hasAttribute('data-show') || b.classList.contains('x')) onClose();
  });
  quick.addEventListener('click', (e) => {
    const b = e.target.closest('[data-quick]');
    if (!b) return;
    if (b.dataset.quick === 'view') { set({ view: !state.view }); return; }
    const q = QUICK.find((x) => x.id === b.dataset.quick);
    set(q.set(state, !q.on(state)));
  });
  active.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-reset')) set(resetPatch());
    else set(chips[+b.dataset.i].patch);
  });
  const resetPatch = () => ({ ...defaults(), q: state.q });

  const filterList = (box) => {
    const k = box.dataset.k, q = norm($('input[type=search]', box).value).trim();
    let shown = 0, matches = 0;
    for (const l of $$('.list > label', box)) {
      const sel = state[k].includes(l.dataset.v);
      const hit = !q || norm(l.textContent).includes(q);
      if (hit) matches++;
      const show = sel || (hit && (k !== 'ch' || q || +l.dataset.i < CHANNELS_SHOWN));
      l.hidden = !show;
      if (show) shown++;
    }
    const more = $('.more', box);
    more.hidden = shown >= matches;
    more.textContent = t('f.more', { n: matches - shown });
  };

  // --- sync: state and counts into the DOM ---
  let chips = [];
  const setN = (el, n, on) => {
    const small = el.querySelector('[data-n]');
    if (small) small.textContent = fmt(n);
    el.classList.toggle('zero', !n && !on);
  };

  function sync(s, facets, total) {
    state = s;
    for (const fs of $$('fieldset.seg')) {
      const k = fs.dataset.k, f = facets[k];
      for (const l of $$('label', fs)) {
        const inp = $('input', l), v = +inp.value;
        inp.checked = s[k] === v;
        setN(l, f?.[v], inp.checked);
      }
    }
    const lv = levels[s.loc];
    $('[data-loc-name]').textContent = s.loc < 7 ? t('f.loc_name', { l: s.loc, name: lv[0] }) : t('f.loc_all');
    for (const l of $$('label.chk')) {
      const k = l.dataset.k, inp = $('input', l);
      inp.checked = !!s[k];
      setN(l, facets[k], inp.checked);
    }
    const sel = $('#f-reg', panel);
    sel.value = s.reg;
    for (const o of sel.options) if (o.value) o.textContent = `${regionName(o.value)} (${fmt(facets.reg.get(o.value) ?? 0)})`;
    for (const box of $$('.multi')) {
      const k = box.dataset.k, f = facets[k];
      for (const l of $$('.list > label', box)) {
        const inp = $('input', l);
        inp.checked = s[k].includes(l.dataset.v);
        setN(l, f.get(l.dataset.v) ?? 0, inp.checked);
      }
      filterList(box);
    }
    for (const b of $$('.chips[data-k] button')) {
      const k = b.closest('.chips').dataset.k, on = s[k].includes(b.dataset.v);
      b.setAttribute('aria-pressed', String(on));
      setN(b, facets[k].get(b.dataset.v) ?? 0, on);
    }
    for (const fs of $$('fieldset.range2')) {
      const k = fs.dataset.k, r = RANGES[k], [lo, hi] = s[k];
      $('.lo', fs).value = lo ?? r.min;
      $('.hi', fs).value = hi ?? r.max;
      for (const [cls, v] of [['.nlo', lo], ['.nhi', hi]]) {
        const inp = $(cls, fs);
        if (document.activeElement !== inp) inp.value = v ?? '';
      }
      $('[data-hint]', fs).textContent = t('f.with_value', { n: facets[k] });
    }
    for (const b of $$('[data-quick]', quick)) {
      if (b.dataset.quick === 'view') { b.setAttribute('aria-pressed', String(s.view)); continue; }
      const q = QUICK.find((x) => x.id === b.dataset.quick), on = q.on(s);
      b.setAttribute('aria-pressed', String(on));
      setN(b, q.count(facets), on);
    }
    chips = activeChips(s, countryNames, chNames);
    active.innerHTML = chips.length ? chips.map((c, i) => `<button type="button" class="pill on" data-i="${i}" aria-label="${esc(t('chip.remove', { x: c.label }))}">${esc(c.label)} <span aria-hidden="true">×</span></button>`).join('')
      + `<button type="button" class="link" data-reset>${t('f.reset')}</button>` : '';
    badge.textContent = chips.length || '';
    $('[data-show]').textContent = t('f.show', { n: total });
  }

  return { sync };
}
