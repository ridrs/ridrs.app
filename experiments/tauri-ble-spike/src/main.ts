// SPDX-License-Identifier: AGPL-3.0-or-later

import { FTMS_SERVICE_UUID, INDOOR_BIKE_DATA_CHARACTERISTIC_UUID } from '@ridrs/contracts';
import { parseFtmsIndoorBikeData } from '@ridrs-shared/ftms-parser';
import pRetry from 'p-retry';
import { createTauriIpc } from './ble/ipc.ts';
import {
  type SpikeBleConnection,
  type SpikeDiscoveredPeripheral,
  TauriBleCentral,
  type TimedNotification,
} from './ble/tauri-ble-central.ts';
import {
  decodeControlPointResponse,
  encodeRequestControl,
  encodeSetTargetPower,
  FTMS_CONTROL_POINT_UUID,
} from './decoders/ftms-control-point.ts';
import {
  HEART_RATE_MEASUREMENT_UUID,
  HEART_RATE_SERVICE_UUID,
  parseHeartRateMeasurement,
} from './decoders/heart-rate.ts';
import {
  decodeZwiftRidePacket,
  RIDE_ON_HANDSHAKE,
  ZWIFT_RIDE_ADVERTISED_UUID,
  ZWIFT_RIDE_CONTROL_POINT_UUID,
  ZWIFT_RIDE_MEASUREMENT_UUID,
  ZWIFT_RIDE_RESPONSE_UUID,
  ZWIFT_RIDE_SERVICE_UUID,
} from './decoders/zwift-ride.ts';
import { calibrateClockOffset } from './clock-offset.ts';
import { DeviceStats, LatencyStats } from './device-stats.ts';
import { PacketLog, toHex } from './packet-log.ts';
import { type FtmsPluginProbe, startFtmsPluginProbe } from './probe/ftms-plugin-probe.ts';
import { runSelftest } from './selftest.ts';

type DeviceKind = 'ftms' | 'hr' | 'zwift';

const SCAN_SERVICES: Record<DeviceKind, string[]> = {
  ftms: [FTMS_SERVICE_UUID],
  hr: [HEART_RATE_SERVICE_UUID],
  zwift: [ZWIFT_RIDE_ADVERTISED_UUID, ZWIFT_RIDE_SERVICE_UUID],
};

interface RememberedDevice {
  readonly peripheralId: string;
  readonly name: string;
  readonly kind: DeviceKind;
}

interface DeviceSession {
  readonly remembered: RememberedDevice;
  readonly stats: DeviceStats;
  connection?: SpikeBleConnection;
  value: string;
  detail: string;
  lostAt?: string;
  wanted: boolean;
  reconnectAbort?: AbortController;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ipc = createTauriIpc();
const central = new TauriBleCentral(ipc);
const log = new PacketLog(ipc);
const latency = new LatencyStats();
const sessions = new Map<string, DeviceSession>();
const found = new Map<string, { peripheral: SpikeDiscoveredPeripheral; kind: DeviceKind }>();
let scanAbort: AbortController | undefined;
/** Rust wall clock − JS wall clock, re-estimated every minute (see clock-offset.ts). */
let clockOffsetMs = 0;
let wakeLock: { release(): Promise<void> } | undefined;

function status(text: string): void {
  $('status').textContent = text;
  log.line('APP', 'STATUS', text);
}

function loadRemembered(): RememberedDevice[] {
  try {
    return JSON.parse(localStorage.getItem('ridrs-spike-remembered') ?? '[]') as RememberedDevice[];
  } catch {
    return [];
  }
}

function remember(device: RememberedDevice): void {
  const list = loadRemembered().filter((d) => d.peripheralId !== device.peripheralId);
  list.push(device);
  try {
    localStorage.setItem('ridrs-spike-remembered', JSON.stringify(list));
  } catch {
    // Storage unavailable: reconnect-by-id then only works within this session.
  }
}

async function updateKeepAwake(): Promise<void> {
  const anyConnected = [...sessions.values()].some((s) => s.connection);
  const mode = await ipc.invoke<string>('keep_awake', { enabled: anyConnected }).catch((e) => `error: ${e}`);
  if (mode === 'unsupported') {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
    if (anyConnected && !wakeLock && nav.wakeLock) {
      wakeLock = await nav.wakeLock.request('screen').catch(() => undefined);
    } else if (!anyConnected && wakeLock) {
      await wakeLock.release();
      wakeLock = undefined;
    }
    $('env').dataset.keepAwake = nav.wakeLock ? (wakeLock ? 'wake-lock-api' : 'wake-lock-api idle') : 'none available';
  } else {
    $('env').dataset.keepAwake = mode;
  }
  renderEnv();
}

function renderEnv(): void {
  $('env').textContent = `${navigator.userAgent} | keep-awake: ${$('env').dataset.keepAwake ?? 'off'}`;
}

function onNotification(session: DeviceSession, label: string, n: TimedNotification, decode: (data: Uint8Array) => string): void {
  session.stats.record(n.rustMonotonicUs);
  latency.add(n.jsWallMs + clockOffsetMs - n.rustWallMs);
  let decoded: string;
  try {
    decoded = decode(n.data);
  } catch (error) {
    decoded = `decode error: ${error instanceof Error ? error.message : String(error)}`;
  }
  log.packet(label, n.data, n.rustWallMs, decoded);
}

async function setupFtms(session: DeviceSession, connection: SpikeBleConnection, label: string): Promise<void> {
  await connection.subscribeTimed(
    { serviceUuid: FTMS_SERVICE_UUID, characteristicUuid: INDOOR_BIKE_DATA_CHARACTERISTIC_UUID },
    (n) =>
      onNotification(session, label, n, (data) => {
        const parsed = parseFtmsIndoorBikeData(data);
        if (!parsed.ok) {
          return `malformed: ${parsed.reason}`;
        }
        session.value = `${parsed.data.powerWatts ?? '–'} W · ${parsed.data.cadenceRpm ?? '–'} rpm`;
        return `power=${parsed.data.powerWatts} cadence=${parsed.data.cadenceRpm}`;
      }),
  );
  // Control point responses arrive as indications on the same characteristic we write to.
  await connection.subscribeTimed({ serviceUuid: FTMS_SERVICE_UUID, characteristicUuid: FTMS_CONTROL_POINT_UUID }, (n) => {
    const response = decodeControlPointResponse(n.data);
    session.detail = response
      ? `CP response to 0x${response.requestOpCode.toString(16).padStart(2, '0')}: ${response.result} (0x${response.resultCode.toString(16)})`
      : `CP indication hex=[${toHex(n.data)}]`;
    log.line(label, 'INDICATE', session.detail, n.rustWallMs);
  });
}

async function setupHr(session: DeviceSession, connection: SpikeBleConnection, label: string): Promise<void> {
  await connection.subscribeTimed({ serviceUuid: HEART_RATE_SERVICE_UUID, characteristicUuid: HEART_RATE_MEASUREMENT_UUID }, (n) =>
    onNotification(session, label, n, (data) => {
      const hr = parseHeartRateMeasurement(data);
      session.value = `${hr.bpm} bpm`;
      return `bpm=${hr.bpm} rr=${hr.rrIntervalsMs.join(',')}`;
    }),
  );
}

async function setupZwift(session: DeviceSession, connection: SpikeBleConnection, label: string): Promise<void> {
  const decode = (data: Uint8Array) => {
    const packet = decodeZwiftRidePacket(data);
    if (packet.type === 'keypad') {
      session.value = packet.pressed.length > 0 ? `pressed: ${packet.pressed.join(', ')}` : 'no button pressed';
    } else if (packet.type === 'battery') {
      session.detail = `battery ${packet.percent}%`;
    }
    return JSON.stringify(packet);
  };
  const target = { serviceUuid: ZWIFT_RIDE_SERVICE_UUID, characteristicUuid: ZWIFT_RIDE_MEASUREMENT_UUID };
  await connection.subscribeTimed(target, (n) => onNotification(session, label, n, decode));
  await connection
    .subscribeTimed({ serviceUuid: ZWIFT_RIDE_SERVICE_UUID, characteristicUuid: ZWIFT_RIDE_RESPONSE_UUID }, (n) =>
      onNotification(session, `${label}:RSP`, n, decode),
    )
    .catch((error) => log.line(label, 'GATT', `response characteristic unavailable: ${error}`));
  await connection.write(
    { serviceUuid: ZWIFT_RIDE_SERVICE_UUID, characteristicUuid: ZWIFT_RIDE_CONTROL_POINT_UUID },
    RIDE_ON_HANDSHAKE,
    { withResponse: false },
  );
  log.line(label, 'GATT', 'sent RideOn handshake');
}

async function connectSession(session: DeviceSession, signal?: AbortSignal): Promise<void> {
  const { peripheralId, kind, name } = session.remembered;
  const label = `${kind.toUpperCase()}:${name}`;
  session.stats.state = 'connecting';
  render();
  const started = performance.now();
  const connection = await central.connect(peripheralId, { signal });
  try {
    if (kind === 'ftms') await setupFtms(session, connection, label);
    if (kind === 'hr') await setupHr(session, connection, label);
    if (kind === 'zwift') await setupZwift(session, connection, label);
  } catch (error) {
    await connection.disconnect().catch(() => undefined);
    throw error;
  }
  session.connection = connection;
  session.stats.state = 'connected';
  session.stats.resetGapTracking();
  log.line(label, 'GATT', `connected (id=${peripheralId}) in ${(performance.now() - started).toFixed(0)} ms`);
  connection.onDisconnected(() => {
    session.connection = undefined;
    session.lostAt = new Date().toISOString();
    session.stats.state = 'connection lost';
    log.line(label, 'GATT', 'connection-lost');
    render();
    void updateKeepAwake();
    if (session.wanted) {
      void reconnect(session);
    }
  });
  void updateKeepAwake();
  render();
}

/** Reconnect by remembered id, without a new scan (check 9). Policy lives in TS, as in Phase 2. */
async function reconnect(session: DeviceSession): Promise<void> {
  session.reconnectAbort?.abort();
  const controller = new AbortController();
  session.reconnectAbort = controller;
  session.stats.state = 'reconnecting';
  render();
  await pRetry(
    async () => {
      await connectSession(session, controller.signal);
      session.stats.reconnects += 1;
    },
    { retries: Number.POSITIVE_INFINITY, minTimeout: 1000, maxTimeout: 5000, factor: 1.5, signal: controller.signal },
  ).catch(() => undefined);
}

function getSession(device: RememberedDevice): DeviceSession {
  let session = sessions.get(device.peripheralId);
  if (!session) {
    session = { remembered: device, stats: new DeviceStats(), value: '–', detail: '', wanted: true };
    sessions.set(device.peripheralId, session);
  }
  return session;
}

async function connectDevice(device: RememberedDevice): Promise<void> {
  remember(device);
  const session = getSession(device);
  session.wanted = true;
  try {
    await connectSession(session);
  } catch (error) {
    session.stats.state = `connect failed: ${error}`;
    render();
  }
}

async function disconnectDevice(session: DeviceSession): Promise<void> {
  session.wanted = false;
  session.reconnectAbort?.abort();
  await session.connection?.disconnect().catch((e) => status(`disconnect: ${e}`));
  session.connection = undefined;
  session.stats.state = 'disconnected';
  void updateKeepAwake();
  render();
}

async function controlPoint(session: DeviceSession, data: Uint8Array): Promise<void> {
  if (!session.connection) return;
  try {
    await session.connection.write({ serviceUuid: FTMS_SERVICE_UUID, characteristicUuid: FTMS_CONTROL_POINT_UUID }, data, {
      withResponse: true,
    });
    log.line(`FTMS:${session.remembered.name}`, 'WRITE', `hex=[${toHex(data)}]`);
  } catch (error) {
    session.detail = `CP write failed: ${error}`;
  }
  render();
}

async function scan(kind: DeviceKind): Promise<void> {
  scanAbort?.abort();
  const controller = new AbortController();
  scanAbort = controller;
  status(`scanning for ${kind}…`);
  try {
    for await (const peripheral of central.scan({ serviceUuids: SCAN_SERVICES[kind], signal: controller.signal })) {
      found.set(peripheral.peripheralId, { peripheral, kind });
      log.line('SCAN', kind.toUpperCase(), `${peripheral.name} id=${peripheral.peripheralId} rssi=${peripheral.rssi} services=${peripheral.serviceUuids.join(',')}`);
      render();
    }
  } catch (error) {
    status(`scan failed: ${error}`);
    return;
  }
  status('scan stopped');
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

function render(): void {
  const foundEl = $('found');
  foundEl.replaceChildren(
    ...[...found.values()].map(({ peripheral, kind }) => {
      const row = document.createElement('div');
      row.className = 'device';
      row.textContent = `${kind}: ${peripheral.name} (rssi ${peripheral.rssi ?? '?'}) `;
      row.append(button('Connect', () => void connectDevice({ peripheralId: peripheral.peripheralId, name: peripheral.name, kind })));
      const id = document.createElement('div');
      id.className = 'muted';
      id.textContent = peripheral.peripheralId;
      row.append(id);
      return row;
    }),
  );

  $('remembered').replaceChildren(
    ...loadRemembered().map((device) => {
      const row = document.createElement('div');
      row.textContent = `${device.kind}: ${device.name} `;
      row.append(button('Connect by id', () => void connectDevice(device)));
      const id = document.createElement('div');
      id.className = 'muted';
      id.textContent = device.peripheralId;
      row.append(id);
      return row;
    }),
  );

  $('devices').replaceChildren(
    ...[...sessions.values()].map((session) => {
      const { stats, remembered } = session;
      const row = document.createElement('div');
      row.className = 'device';
      const value = document.createElement('div');
      value.className = 'value';
      value.textContent = session.value;
      const info = document.createElement('div');
      info.className = 'muted';
      info.textContent = `${remembered.kind} ${remembered.name} · ${stats.state} · ${stats.rate.toFixed(2)} notif/s · ${stats.notifications} total · gaps>1s: ${stats.gapsOverOneSecond} (max ${stats.maxGapMs.toFixed(0)} ms) · reconnects: ${stats.reconnects}${session.lostAt ? ` · last loss ${session.lostAt}` : ''}`;
      const detail = document.createElement('div');
      detail.className = 'muted';
      detail.textContent = session.detail;
      row.append(value, info, detail, button('Disconnect', () => void disconnectDevice(session)));
      if (remembered.kind === 'ftms') {
        row.append(
          button('Request control (0x00)', () => void controlPoint(session, encodeRequestControl())),
          button('Set target power 150 W (0x05)', () => void controlPoint(session, encodeSetTargetPower(150))),
        );
      }
      return row;
    }),
  );

  const p50 = latency.percentile(50);
  const p95 = latency.percentile(95);
  $('latency').textContent = `IPC latency Rust receive → JS handler: median ${p50?.toFixed(2) ?? '–'} ms, p95 ${p95?.toFixed(2) ?? '–'} ms (n=${latency.count})`;
}

// JS timer survival probe for check 13: a 1 s interval records its own worst lateness.
let lastTick = performance.now();
let worstTimerGapMs = 0;
setInterval(() => {
  const now = performance.now();
  worstTimerGapMs = Math.max(worstTimerGapMs, now - lastTick);
  lastTick = now;
  $('timers').textContent = `JS 1 s timer worst interval: ${worstTimerGapMs.toFixed(0)} ms · visibility: ${document.visibilityState}`;
  render();
}, 1000);
document.addEventListener('visibilitychange', () => log.line('APP', 'VISIBILITY', document.visibilityState));

let probe: FtmsPluginProbe | undefined;
const probeLog = (line: string) => {
  const el = $('probe-log');
  el.textContent = `${new Date().toISOString().slice(11, 23)} ${line}\n${el.textContent ?? ''}`.slice(0, 20_000);
};
$('probe-stage').textContent =
  'Stage 1 ✅ (contracts + parseFtmsIndoorBikeData bundled and used above). Stage 2: run the real plugin below.';
$('probe-start').addEventListener('click', async () => {
  await probe?.stop();
  try {
    probe = await startFtmsPluginProbe(central, (event) => probeLog(`${event.type} ${JSON.stringify(event.payload)}`), probeLog);
    probeLog('device-ftms-trainer started');
  } catch (error) {
    probeLog(`stage 2 failed: ${error}`);
  }
});
$('probe-stop').addEventListener('click', async () => {
  await probe?.stop();
  probe = undefined;
  probeLog('device-ftms-trainer stopped');
});

for (const el of document.querySelectorAll<HTMLButtonElement>('[data-scan]')) {
  el.addEventListener('click', () => void scan(el.dataset.scan as DeviceKind));
}
$('stop-scan').addEventListener('click', () => scanAbort?.abort());
$('perm').addEventListener('click', async () => {
  status(`permissions granted: ${await central.checkPermissions(true).catch((e) => `error: ${e}`)}`);
});
$('export').addEventListener('click', async () => {
  await log.flush();
  status(`exported to ${await ipc.invoke<string>('log_export').catch((e) => `error: ${e}`)}`);
});

const recalibrate = () =>
  calibrateClockOffset(ipc, 50)
    .then(({ offsetMs }) => {
      clockOffsetMs = offsetMs;
    })
    .catch(() => undefined);
void recalibrate();
setInterval(() => void recalibrate(), 60_000);

log.start();
renderEnv();
render();
ipc
  .invoke<string>('log_location')
  .then((path) => status(`packet log: ${path}`))
  .catch((e) => status(`not running inside Tauri? ${e}`));
ipc
  .invoke<boolean>('selftest_requested')
  .then((requested) => (requested ? runSelftest(ipc, central, log) : undefined))
  .catch((e) => status(`selftest failed: ${e}`));
