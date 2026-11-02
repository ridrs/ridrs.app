// SPDX-License-Identifier: AGPL-3.0-or-later

import { Channel, invoke } from '@tauri-apps/api/core';

const FRAME_HEADER_BYTES = 20;
const $ = (id: string) => document.getElementById(id) as HTMLElement;

function log(line: string): void {
  const stamp = new Date().toISOString().slice(11, 23);
  $('log').textContent = `${stamp} ${line}\n${$('log').textContent ?? ''}`.slice(0, 20_000);
  console.log(`[spike] ${line}`);
}

function report(kind: string, data: unknown): void {
  const line = JSON.stringify({ kind, ...(data as object) });
  log(line);
  void invoke('spike_report', { line });
}

/** Wall clock with sub-ms resolution, comparable to the Rust `SystemTime` milliseconds. */
const nowMs = () => performance.timeOrigin + performance.now();

// ---------------------------------------------------------------- companion

type CompanionEvent =
  | { kind: 'clientConnected'; peer: string }
  | { kind: 'clientGone'; peer: string; reason: string }
  | { kind: 'stats'; peer: string; sent: number; rateHz: number };

async function startCompanion(): Promise<{ port: number; addresses: string[] }> {
  $('companion').hidden = false;
  const clients = new Map<string, string>();
  const render = () => {
    $('c-clients').textContent = clients.size ? [...clients.values()].join(' | ') : 'no ridrs connected';
  };
  const events = new Channel<CompanionEvent>();
  events.onmessage = (e) => {
    if (e.kind === 'clientConnected') {
      clients.set(e.peer, `${e.peer} connected`);
      report('companion-client', { peer: e.peer, state: 'connected' });
    } else if (e.kind === 'clientGone') {
      clients.delete(e.peer);
      report('companion-client', { peer: e.peer, state: 'gone', reason: e.reason });
    } else {
      clients.set(e.peer, `${e.peer}: ${e.sent} frames @ ${e.rateHz} Hz`);
    }
    render();
  };
  const name = `spike-${navigator.platform.replace(/\W+/g, '').toLowerCase() || 'device'}`;
  const info = await invoke<{ port: number; fullname: string; addresses: string[] }>('companion_start', {
    name,
    events,
  });
  $('c-address').textContent = info.addresses.map((a) => `${a}:${info.port}`).join('  ') || `port ${info.port}`;
  $('c-info').textContent = `advertised as ${info.fullname}`;
  render();
  report('companion-started', info);
  return info;
}

// ---------------------------------------------------------------- host links

interface Link {
  readonly path: 'webview' | 'rust';
  send(text: string): void;
  close(): void;
  onFrame?: (frame: DataView) => void;
  onText?: (text: string) => void;
  onClose?: (reason: string) => void;
}

function openWebViewLink(url: string): Promise<Link> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      reject(new Error(`constructor threw: ${String(error)}`));
      return;
    }
    socket.binaryType = 'arraybuffer';
    let opened = false;
    const link: Link = {
      path: 'webview',
      send: (text) => socket.send(text),
      close: () => socket.close(),
    };
    socket.onopen = () => {
      opened = true;
      resolve(link);
    };
    socket.onerror = () => {
      if (!opened) reject(new Error('error event before open (blocked or unreachable)'));
    };
    socket.onclose = (e) => {
      const reason = `close code ${e.code}${e.reason ? ` ${e.reason}` : ''}`;
      if (!opened) reject(new Error(reason));
      link.onClose?.(reason);
    };
    socket.onmessage = (e) => {
      if (typeof e.data === 'string') link.onText?.(e.data);
      else link.onFrame?.(new DataView(e.data as ArrayBuffer));
    };
  });
}

async function openRustLink(url: string): Promise<Link> {
  const channel = new Channel<ArrayBuffer | number[]>();
  const link: Link = {
    path: 'rust',
    send: (text) => void invoke('host_rust_send', { text }).catch((e) => log(`rust send: ${String(e)}`)),
    close: () => void invoke('host_rust_close'),
  };
  const decoder = new TextDecoder();
  channel.onmessage = (message) => {
    const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : Uint8Array.from(message);
    const body = bytes.subarray(1);
    if (bytes[0] === 0) link.onFrame?.(new DataView(body.buffer, body.byteOffset, body.byteLength));
    else if (bytes[0] === 1) link.onText?.(decoder.decode(body));
    else link.onClose?.(decoder.decode(body));
  };
  await invoke('host_rust_connect', { url, events: channel });
  return link;
}

// ---------------------------------------------------------------- measurement

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function quantile(values: number[], q: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

const round = (n: number) => Math.round(n * 100) / 100;

async function runPhase(link: Link, rateHz: number, seconds: number) {
  link.send(`rate:${rateHz}`);
  await sleep(1000);
  const rtts: number[] = [];
  const offsets: { rtt: number; offset: number }[] = [];
  const latencies: number[] = [];
  let frames = 0;
  let minSeq = Number.POSITIVE_INFINITY;
  let maxSeq = Number.NEGATIVE_INFINITY;
  let maxGapMs = 0;
  let lastArrival = 0;
  let closed: string | undefined;

  link.onText = (text) => {
    const [kind, sent, companionWall] = text.split(':');
    if (kind !== 'pong') return;
    const t1 = nowMs();
    const t0 = Number(sent);
    const rtt = t1 - t0;
    rtts.push(rtt);
    offsets.push({ rtt, offset: Number(companionWall) - (t0 + t1) / 2 });
  };
  const arrivals: { arrived: number; companionWall: number }[] = [];
  link.onFrame = (view) => {
    const arrived = nowMs();
    if (view.byteLength < FRAME_HEADER_BYTES) return;
    const seq = view.getUint32(0, true);
    arrivals.push({ arrived, companionWall: view.getFloat64(12, true) });
    frames++;
    minSeq = Math.min(minSeq, seq);
    maxSeq = Math.max(maxSeq, seq);
    if (lastArrival) maxGapMs = Math.max(maxGapMs, arrived - lastArrival);
    lastArrival = arrived;
  };
  link.onClose = (reason) => {
    closed = reason;
  };

  const pinger = setInterval(() => link.send(`ping:${nowMs()}`), 200);
  await sleep(seconds * 1000);
  clearInterval(pinger);

  // The minimum-RTT ping gives the best clock offset estimate (NTP style).
  const best = offsets.sort((a, b) => a.rtt - b.rtt)[0];
  if (best) {
    for (const a of arrivals) latencies.push(a.arrived - (a.companionWall - best.offset));
  }
  const expected = Number.isFinite(minSeq) ? maxSeq - minSeq + 1 : 0;
  return {
    path: link.path,
    rateHz,
    seconds,
    frames,
    lost: expected - frames,
    maxGapMs: round(maxGapMs),
    rttMedianMs: round(quantile(rtts, 0.5)),
    rttP95Ms: round(quantile(rtts, 0.95)),
    oneWayMedianMs: round(quantile(latencies, 0.5)),
    oneWayP95Ms: round(quantile(latencies, 0.95)),
    oneWayMaxMs: round(Math.max(...latencies)),
    clockOffsetMs: best ? round(best.offset) : null,
    closed: closed ?? null,
  };
}

async function testUrl(url: string): Promise<void> {
  for (const open of [openWebViewLink, openRustLink]) {
    const path = open === openWebViewLink ? 'webview' : 'rust';
    const started = nowMs();
    let link: Link;
    try {
      link = await open(url);
    } catch (error) {
      report('host-connect', { path, url, ok: false, error: String(error), origin: location.origin });
      continue;
    }
    report('host-connect', { path, url, ok: true, connectMs: round(nowMs() - started), origin: location.origin });
    for (const [rateHz, seconds] of [
      [4, 15],
      [200, 10],
    ] as const) {
      $('h-status').textContent = `${path}: ${rateHz} Hz for ${seconds} s…`;
      report('host-phase', await runPhase(link, rateHz, seconds));
    }
    link.close();
    await sleep(500);
  }
  $('h-status').textContent = 'done';
  report('host-done', { url });
}

type BrowseEvent =
  | {
      kind: 'resolved';
      fullname: string;
      name: string;
      host: string;
      port: number;
      ipv4: string[];
      protocol: string;
      elapsedMs: number;
    }
  | { kind: 'removed'; fullname: string };

async function startHost(): Promise<void> {
  $('host').hidden = false;
  const found = new Map<string, string>();
  let tested = false;
  const events = new Channel<BrowseEvent>();
  events.onmessage = (e) => {
    if (e.kind === 'removed') {
      found.delete(e.fullname);
      report('host-removed', e);
    } else {
      found.set(e.fullname, `${e.name} → ${e.ipv4.join(', ')}:${e.port} (protocol ${e.protocol})`);
      report('host-resolved', e);
      // mDNS also announces loopback for a service on the same machine; only a LAN address proves anything.
      const ip = e.ipv4.find((a) => !a.startsWith('127.') && !a.startsWith('169.254.'));
      if (!tested && ip) {
        tested = true;
        void testUrl(`ws://${ip}:${e.port}`);
      }
    }
    $('h-found').textContent = found.size ? [...found.values()].join('\n') : 'browsing…';
  };
  await invoke('host_browse', { events });
  report('host-browsing', { origin: location.origin });
}

// ---------------------------------------------------------------- wiring

/** Switching roles reloads, so each role starts from a clean page. */
function switchRole(role: string): void {
  try {
    localStorage.setItem('spike-role', role);
  } catch {
    // Storage is a convenience only.
  }
  location.reload();
}

async function chooseRole(role: string): Promise<void> {
  ($(`role-${role}`) as HTMLButtonElement).style.fontWeight = '700';
  if (role === 'companion' || role === 'both') await startCompanion();
  if (role === 'host' || role === 'both') await startHost();
}

$('h-manual').addEventListener('click', () => {
  const url = ($('h-url') as HTMLInputElement).value.trim();
  if (url) void testUrl(url);
});

const config = await invoke<{ role: string; platform: string }>('spike_config');
$('env').textContent = `${config.platform} · origin ${location.origin} · ${navigator.userAgent}`;
for (const role of ['companion', 'host', 'both']) $(`role-${role}`).addEventListener('click', () => switchRole(role));
let remembered: string | null = null;
try {
  remembered = localStorage.getItem('spike-role');
} catch {
  // ignore
}
const autoRole = config.role || remembered;
if (autoRole) void chooseRole(autoRole).catch((e) => report('error', { message: String(e) }));
