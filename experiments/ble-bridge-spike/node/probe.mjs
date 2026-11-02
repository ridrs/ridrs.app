// SPDX-License-Identifier: AGPL-3.0-or-later

// O2 probe: the headless ridrs path.
//   node node/probe.mjs client ws://host:port   -> Node's global WebSocket against a companion
//   node node/probe.mjs server [port]           -> a `ws` stand-in companion (same wire format)
import { WebSocketServer } from 'ws';

const FRAME_HEADER_BYTES = 20;
const SAMPLE = Uint8Array.of(0x45, 0x00, 0xb4, 0x00, 0xc8, 0x00);
const nowMs = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (v, p) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(p * v.length))];
const round = (n) => Math.round(n * 100) / 100;

async function client(url) {
  const started = nowMs();
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`cannot connect to ${url}`));
  });
  console.log(JSON.stringify({ kind: 'node-connect', url, connectMs: round(nowMs() - started) }));
  for (const [rateHz, seconds] of [
    [4, 10],
    [200, 10],
  ]) {
    socket.send(`rate:${rateHz}`);
    await sleep(1000);
    const rtts = [];
    const offsets = [];
    const arrivals = [];
    socket.onmessage = (e) => {
      const t1 = nowMs();
      if (typeof e.data === 'string') {
        const [kind, t0, wall] = e.data.split(':');
        if (kind === 'pong') {
          rtts.push(t1 - Number(t0));
          offsets.push({ rtt: t1 - Number(t0), offset: Number(wall) - (Number(t0) + t1) / 2 });
        }
        return;
      }
      const view = new DataView(e.data);
      if (view.byteLength >= FRAME_HEADER_BYTES) arrivals.push({ t1, seq: view.getUint32(0, true), wall: view.getFloat64(12, true) });
    };
    const pinger = setInterval(() => socket.send(`ping:${nowMs()}`), 200);
    await sleep(seconds * 1000);
    clearInterval(pinger);
    const best = offsets.sort((a, b) => a.rtt - b.rtt)[0];
    const lat = arrivals.map((a) => a.t1 - (a.wall - best.offset));
    const seqs = arrivals.map((a) => a.seq);
    console.log(
      JSON.stringify({
        kind: 'node-phase',
        rateHz,
        frames: arrivals.length,
        lost: Math.max(...seqs) - Math.min(...seqs) + 1 - arrivals.length,
        rttMedianMs: round(q(rtts, 0.5)),
        rttP95Ms: round(q(rtts, 0.95)),
        oneWayMedianMs: round(q(lat, 0.5)),
        oneWayP95Ms: round(q(lat, 0.95)),
      }),
    );
  }
  socket.close();
}

function server(port) {
  const wss = new WebSocketServer({ port });
  wss.on('listening', () => console.log(JSON.stringify({ kind: 'ws-server', port: wss.address().port })));
  wss.on('connection', (socket) => {
    let seq = 0;
    let timer;
    const start = (hz) => {
      clearInterval(timer);
      timer = setInterval(() => {
        const frame = new ArrayBuffer(FRAME_HEADER_BYTES + SAMPLE.length);
        const view = new DataView(frame);
        view.setUint32(0, seq++, true);
        view.setBigUint64(4, BigInt(Math.round(performance.now() * 1000)), true);
        view.setFloat64(12, nowMs(), true);
        new Uint8Array(frame, FRAME_HEADER_BYTES).set(SAMPLE);
        socket.send(frame);
      }, 1000 / hz);
    };
    start(4);
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (text.startsWith('ping:')) socket.send(`pong:${text.slice(5)}:${nowMs()}`);
      else if (text.startsWith('rate:')) start(Number(text.slice(5)));
    });
    socket.on('close', () => clearInterval(timer));
  });
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'client') await client(arg);
else server(Number(arg ?? 0));
