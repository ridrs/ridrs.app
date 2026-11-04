// SPDX-License-Identifier: CC-BY-SA-4.0
// Prototype helpers: navigation bar, state switcher, shared components. Not app code.

const SCREENS = [
  ['Start', [['index.html', 'Map'], ['setup.html', 'Setup']]],
  ['Onboarding', [
    ['onboarding-1-welcome.html', '1 Welcome'],
    ['onboarding-2-bluetooth.html', '2 Bluetooth'],
    ['onboarding-3-rider.html', '3 Rider'],
    ['setup.html?state=first', '4 Devices'],
  ]],
  ['Home', [['main.html', 'Main'], ['menu.html', 'Menu'], ['device.html', 'Device']]],
  ['Companion', [['companion-add.html', 'Add companion']]],
  ['Ride', [['activity.html', 'Activity'], ['ride-saved.html', 'Ride saved']]],
  ['Settings', [['settings-rider.html', 'Rider'], ['settings-connection.html', 'Connection'], ['rides.html', 'Rides'], ['about.html', 'About']]],
];

const ICON = {
  power: '<svg width="30" height="34" viewBox="0 0 24 28" fill="currentColor" aria-hidden="true"><path d="M14 1 3 16h7l-2 11 12-16h-7z"/></svg>',
  trainer: '<svg width="34" height="34" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="19" cy="11" r="7"/><circle cx="19" cy="11" r="2.5"/><path d="M14 16 6 26h14"/><circle cx="5" cy="27" r="1.6"/><circle cx="22" cy="27" r="1.6"/></svg>',
  heart: '<svg width="34" height="32" viewBox="0 0 32 30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" aria-hidden="true"><path d="M16 27C6 19 3 14 3 9.5 3 5.6 6 3 9.5 3c2.8 0 5 1.7 6.5 4 1.5-2.3 3.7-4 6.5-4C26 3 29 5.6 29 9.5 29 14 26 19 16 27z"/></svg>',
  bike: '<svg width="96" height="64" viewBox="0 0 96 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="20" cy="42" r="15"/><circle cx="62" cy="42" r="15"/><path d="M20 42 32 18h20l10 24M32 18l12 24h-24M28 12h10M50 18l-3-8h9"/><path d="M76 18c5 3 8 8 8 14M82 10c8 5 12 13 12 22" opacity=".8"/></svg>',
  menu: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  bt: '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 7 10 10-5 4V3l5 4L7 17"/></svg>',
  person: '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-5 4-7 8-7s7 2 8 7"/></svg>',
  rides: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 19V9M10 19V5M16 19v-8M22 19H2"/></svg>',
  info: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.1"/></svg>',
  laptop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>',
  phone: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>',
  phoneBig: '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/><path d="M19.5 8c1 1 1.5 2.4 1.5 4s-.5 3-1.5 4M3.5 8C2.5 9 2 10.4 2 12s.5 3 1.5 4" opacity=".7"/></svg>',
  merge: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v6a6 6 0 0 0 6 6h6M18 3v6a6 6 0 0 1-2 4.5M15 12l3 3-3 3"/></svg>',
};

const KIND = {
  power: { title: 'Power Meter', eg: 'e.g. Assioma, Favero, Stages', icon: ICON.power },
  trainer: { title: 'Smart Trainer', eg: 'e.g. Wahoo, Tacx, Elite', icon: ICON.trainer },
  hr: { title: 'Heart Rate Monitor', eg: 'e.g. Polar, Garmin, Apple Watch', icon: ICON.heart },
};

/** This machine's name and the paired companion's, as the rider would see them. */
const HERE = 'This Mac';
const COMPANION = 'Pixel 8';

const STATUS = {
  ok: (t = 'Connected') => `<span class="st ok" role="status"><span class="tick">✓</span>${t}</span>`,
  busy: (t) => `<span class="st busy" role="status"><span class="spin"></span>${t}</span>`,
  warn: (t) => `<span class="st warn" role="status">⚠ ${t}</span>`,
  none: (t = 'Not set up') => `<span class="st none" role="status">${t}</span>`,
  choose: (t = 'Choose') => `<span class="st choose" role="status">● ${t}</span>`,
};

/** Which link carries a device: this machine's Bluetooth or the companion phone. */
function route(via, { auto = true, also } = {}) {
  const here = via === 'here';
  const label = here ? HERE : `via ${COMPANION}`;
  const extra = also ? ` <span class="also" title="Seen by both; shown once">${ICON.merge} also ${also === 'here' ? HERE : COMPANION}</span>` : '';
  return `<span class="route ${here ? 'here' : 'comp'}${auto ? '' : ' pinned'}">${here ? ICON.laptop : ICON.phone}${label}${auto ? '' : ' · pinned'}</span>${extra}`;
}

/**
 * One device row. `sub` replaces the "e.g." hint with the chosen device's name, `via` adds the
 * route chip. Rows without `href` have no chevron: nothing to open, nothing promised.
 */
function row(kind, status, { sub, via, also, pinned, focus, href } = {}) {
  const k = KIND[kind];
  const tag = href ? 'a' : 'div';
  const routeChip = via ? `<span class="routes">${route(via, { auto: !pinned, also })}</span>` : '';
  return `<${tag} class="row${focus ? ' focus' : ''}${href ? '' : ' nochev'}"${href ? ` href="${href}"` : ''}>
    <span class="ico">${k.icon}</span>
    <span class="meta"><b>${k.title}</b><small>${sub ?? k.eg}</small>${routeChip}</span>
    ${status}${href ? '<span class="chev">›</span>' : ''}</${tag}>`;
}

/**
 * Candidate list for one kind. Each candidate is one physical device; `routes` lists who sees it
 * (a duplicate seen by this machine and the companion is one entry with two routes).
 */
function candidates(title, list, selected, foot = 'ridrs remembers your choice and reconnects automatically.') {
  return `<div class="picker" role="radiogroup" aria-label="${title}"><h4>${title}</h4>
    ${list.map((c, i) => `<div class="cand${i === selected ? ' sel' : ''}" data-cand="${i}" role="radio" tabindex="0" aria-checked="${i === selected}">
      <span class="radio"></span><span><b>${c.name}</b><small>${c.note}</small>
        <span class="routes">${c.routes.map((r) => route(r)).join('')}${c.routes.length > 1 ? `<span class="also">${ICON.merge} one device, seen twice</span>` : ''}</span></span>
      <span class="bars" aria-label="signal ${c.bars} of 4">${[1, 2, 3, 4].map((n) => `<i class="${n <= c.bars ? 'on' : ''}"></i>`).join('')}</span></div>`).join('')}
    ${foot ? `<p class="small" style="margin:8px 4px 0">${foot}</p>` : ''}</div>`;
}

/** Companion status strip; `state` is online, offline, searching or none. */
function companionStrip(state) {
  if (state === 'none') return '';
  const t = {
    online: [`${COMPANION} connected`, 'ok', 'Adds its Bluetooth to this Mac'],
    offline: [`${COMPANION} offline`, 'warn', 'Devices only it could reach wait for it'],
    searching: [`Looking for ${COMPANION}…`, 'busy', 'Same Wi-Fi needed'],
  }[state];
  return `<a class="compstrip ${t[1]}" href="settings-connection.html">${ICON.phone}<span><b>${t[0]}</b><small>${t[2]}</small></span><span class="chev">›</span></a>`;
}

function buildBar() {
  const here = location.pathname.split('/').pop() || 'index.html';
  const bar = document.createElement('nav');
  bar.className = 'protobar';
  bar.setAttribute('aria-label', 'Prototype screens');
  bar.innerHTML = SCREENS.map(([group, items]) =>
    `<span class="grp">${group}</span>${items.map(([href, label]) => {
      const [file, query] = href.split('?');
      const on = file === here && (!query || location.search.includes(query));
      return `<a href="${href}" class="${on ? 'on' : ''}">${label}</a>`;
    }).join('')}`).join('');
  document.body.prepend(bar);
}

/** `<main data-states="a:Label A,b:Label B">`; elements with `data-show="a b"` / `data-hide` follow the state. */
function buildStates(onChange) {
  const host = document.querySelector('[data-states]');
  if (!host) return;
  const states = host.dataset.states.split(',').map((s) => s.split(':'));
  const wanted = new URLSearchParams(location.search).get('state');
  let current = states.find(([id]) => id === wanted)?.[0] ?? states[0][0];
  const wrap = document.createElement('div');
  wrap.className = 'states';
  wrap.innerHTML = '<span>State</span>' + states.map(([id, label]) => `<button data-s="${id}">${label}</button>`).join('');
  host.before(wrap);
  const apply = () => {
    wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.s === current));
    document.querySelectorAll('[data-show]').forEach((el) => {
      el.hidden = !el.dataset.show.split(' ').includes(current);
    });
    document.querySelectorAll('[data-hide]').forEach((el) => {
      el.hidden = el.dataset.hide.split(' ').includes(current);
    });
    onChange?.(current);
  };
  window.setState = (id) => {
    current = id;
    history.replaceState(null, '', `?state=${current}`);
    apply();
  };
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) window.setState(b.dataset.s);
  });
  apply();
}

/** Hold-to-confirm: `data-hold="ms"` on a link; releasing early cancels. */
function bindHold() {
  document.querySelectorAll('[data-hold]').forEach((el) => {
    let timer;
    const ms = Number(el.dataset.hold);
    const start = (e) => {
      e.preventDefault();
      el.classList.add('holding');
      el.style.setProperty('--hold', `${ms}ms`);
      timer = setTimeout(() => { location.href = el.getAttribute('href'); }, ms);
    };
    const cancel = () => { clearTimeout(timer); el.classList.remove('holding'); };
    el.addEventListener('pointerdown', start);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => el.addEventListener(t, cancel));
    el.addEventListener('click', (e) => e.preventDefault());
  });
}

document.addEventListener('DOMContentLoaded', () => {
  buildBar();
  buildStates(window.renderState);
  bindHold();
  const pick = (c) => {
    c.parentElement.querySelectorAll('.cand').forEach((x) => {
      x.classList.toggle('sel', x === c);
      x.setAttribute('aria-checked', String(x === c));
    });
    window.onPick?.(Number(c.dataset.cand));
  };
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cand]');
    if (c) pick(c);
  });
  document.addEventListener('keydown', (e) => {
    const c = e.target.closest?.('[data-cand]');
    if (c && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); pick(c); }
  });
});
