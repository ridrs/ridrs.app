// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BleRoute,
  BridgeState,
  ControllerButton,
  DeviceCandidate,
  DeviceConnectionState,
  DeviceKind,
  DeviceStatus,
} from '@ridrs/contracts';
import type { Messages } from './i18n/index.ts';

/** Colour and symbol of a state; the text always goes with it, colour is never the only signal. */
export type Tone = 'ok' | 'busy' | 'warn' | 'none';

/** What the rider sees per kind. Power is a kind of its own, even while the trainer measures it. */
export type RowKind = 'power' | DeviceKind;

export interface DeviceRow {
  readonly kind: RowKind;
  /** The kind of device behind the row: the power row shows the trainer. */
  readonly deviceKind: DeviceKind;
  /** The device the row shows; empty while none is known. */
  readonly deviceId: string;
  readonly deviceName: string;
  /** The link that carries the device, once one did. */
  readonly route?: BleRoute;
  /** Every device of the kind found; the one shown is among them. */
  readonly candidates: readonly DeviceCandidate[];
  /** The links over which ridrs looks for devices of the kind now; empty: it looks for none. */
  readonly scanning: readonly BleRoute[];
  /**
   * How many more devices of the kind were found, a device seen over both links once: the row
   * says so, the details list them.
   */
  readonly more: number;
  /**
   * While the kind searches without a device: how many devices of the kind were found, a
   * forgotten one too, a device seen over both links once. It takes the place of `more`.
   */
  readonly found: number;
  /** Long name for the setup rows. */
  readonly title: string;
  /** Short name for the indicator dots. */
  readonly label: string;
  /** The device, else the one connected last, else what kind of device would fit. */
  readonly detail: string;
  /** The kind of device behind the row, by its long name: the power row names the trainer. */
  readonly type: string;
  /** What the device is for, in one sentence. */
  readonly about: string;
  /** What the rider can do about the state, when there is something to do. */
  readonly tip?: string;
  /** The connection state; `none` when no device plugin reported this kind. */
  readonly state: DeviceConnectionState | 'none';
  readonly status: string;
  readonly tone: Tone;
  /** The battery level of the device in percent, once it told it. */
  readonly battery?: number;
  /** Buttons held down on the connected controller: they take the place of the check. */
  readonly held?: readonly ControllerButton[];
}

/** The latest value of each kind, with the device that delivered it. */
export interface Readings {
  readonly power?: { readonly deviceId: string; readonly watts: number };
  readonly heartRate?: { readonly deviceId: string; readonly bpm: number };
  /** Per controller: a pair is two devices, the row stands for both. */
  readonly buttons?: Readonly<Record<string, readonly ControllerButton[]>>;
}

/** How a held button shows in the badge; its name for screen readers is in `Messages.buttons`. */
export const BUTTON_FACES: Record<ControllerButton, { readonly symbol: string }> = {
  left: { symbol: '←' },
  up: { symbol: '↑' },
  right: { symbol: '→' },
  down: { symbol: '↓' },
  a: { symbol: 'A' },
  b: { symbol: 'B' },
  y: { symbol: 'Y' },
  z: { symbol: 'Z' },
  'shift-up-left': { symbol: '+' },
  'shift-down-left': { symbol: '−' },
  'power-up-left': { symbol: '⚡' },
  'on-off-left': { symbol: '⏻' },
  'shift-up-right': { symbol: '+' },
  'shift-down-right': { symbol: '−' },
  'power-up-right': { symbol: '⚡' },
  'on-off-right': { symbol: '⏻' },
};

/** The tone of a state; its words, and a tip where the rider can do something, are in `Messages.states`. */
const TONES: Record<DeviceRow['state'], Tone> = {
  none: 'none',
  searching: 'busy',
  connecting: 'busy',
  connected: 'ok',
  // "Reconnecting…" says it all: no tip.
  reconnecting: 'busy',
  disconnected: 'warn',
};

/** A state's status, tone and tip in the rider's language. */
function stateOf(state: DeviceRow['state'], text: Messages): Pick<DeviceRow, 'status' | 'tone' | 'tip'> {
  const words = text.states[state] ?? { status: state };
  return { status: words.status, tone: TONES[state], ...(words.tip ? { tip: words.tip } : {}) };
}

type Proof = Pick<DeviceRow, 'held'> & { readonly status?: string };

/**
 * Only a reading of the device in the row, and only while it is connected, proves the row: the
 * watts and the heart rate replace "Connected", held buttons replace the check.
 */
function proofOf(
  kind: RowKind,
  device: DeviceStatus | undefined,
  readings: Readings,
  text: Messages,
): Proof {
  if (device?.state !== 'connected') {
    return {};
  }
  const own = <T extends { readonly deviceId: string }>(reading: T | undefined) =>
    reading?.deviceId === device.deviceId ? reading : undefined;
  switch (kind) {
    case 'power': {
      const power = own(readings.power);
      return power ? { status: text.watts(Math.round(power.watts)) } : {};
    }
    case 'heart-rate': {
      const bpm = own(readings.heartRate)?.bpm;
      return bpm ? { status: text.bpm(Math.round(bpm)) } : {};
    }
    case 'controller': {
      const all = new Set(Object.values(readings.buttons ?? {}).flat());
      const held = (Object.keys(BUTTON_FACES) as ControllerButton[]).filter((b) => all.has(b));
      return held.length > 0 ? { held } : {};
    }
    case 'trainer':
      return {};
  }
}

function row(
  kind: RowKind,
  device: DeviceStatus | undefined,
  readings: Readings,
  text: Messages,
): DeviceRow {
  const state = device?.state ?? 'none';
  const deviceKind: DeviceKind = kind === 'power' ? 'trainer' : kind;
  const candidates = device?.candidates ?? [];
  // The power row shows the trainer: its counts stay in the trainer's row.
  const own = kind === deviceKind;
  const searching = state === 'searching' && !device?.deviceId;
  return {
    kind,
    deviceKind,
    deviceId: device?.deviceId ?? '',
    deviceName: device?.deviceName ?? '',
    ...(device?.route ? { route: device.route } : {}),
    ...(device?.battery === undefined ? {} : { battery: device.battery }),
    candidates,
    scanning: device?.scanning ?? [],
    // A device seen over both links counts once.
    more:
      own && !searching
        ? byDevice(candidates).filter((g) => !g.some((c) => c.deviceId === device?.deviceId))
            .length
        : 0,
    found: own && searching ? byDevice(candidates).length : 0,
    title: text.kinds[kind].title,
    label: text.kinds[kind].label,
    detail: device?.deviceName || device?.lastDeviceName || text.kinds[kind].examples,
    type: text.kinds[deviceKind].title,
    about: text.kinds[kind].about,
    state,
    ...stateOf(state, text),
    ...proofOf(kind, device, readings, text),
  };
}

/**
 * The devices the setup shows: every kind, but a controller only once one was found (it has a
 * device id). A controller is optional gear, so searching for one is no news.
 */
function shown(devices: readonly DeviceStatus[]): DeviceStatus[] {
  return devices.filter((d) => d.kind !== 'controller' || d.deviceId !== '');
}

/**
 * Rows in the order of the draft: power, trainer, heart rate, then a controller once found. The
 * trainer measures power too and is the only power source so far, so the power row shows it.
 */
export function describeDevices(
  devices: readonly DeviceStatus[],
  readings: Readings,
  text: Messages,
): DeviceRow[] {
  const trainer = devices.find((d) => d.kind === 'trainer');
  const controller = shown(devices).find((d) => d.kind === 'controller');
  return [
    row('power', trainer, readings, text),
    row('trainer', trainer, readings, text),
    row('heart-rate', devices.find((d) => d.kind === 'heart-rate'), readings, text),
    ...(controller ? [row('controller', controller, readings, text)] : []),
  ];
}

/**
 * The devices found over the links ridrs can use now: those of the companion only while it is
 * connected, so nothing is offered with the companion before the phone is there.
 */
export function overLinksInReach(
  devices: readonly DeviceStatus[],
  companion: BridgeState | undefined,
): DeviceStatus[] {
  if (companion === 'connected') {
    return [...devices];
  }
  return devices.map((device) =>
    device.candidates
      ? {
          ...device,
          candidates: device.candidates.filter((c) =>
            c.routes.some((route) => route !== 'companion'),
          ),
        }
      : device,
  );
}

/** The link a device found is seen over: since ADR 0046 each is found over one link. */
export function linkOf(candidate: DeviceCandidate): BleRoute {
  return candidate.routes[0] ?? 'local';
}

/**
 * The devices found, the strongest signal first: in a room full of trainers the one next to the
 * rider leads. Devices without a signal follow in the order found.
 */
export function bySignal(candidates: readonly DeviceCandidate[]): DeviceCandidate[] {
  return [...candidates].sort(
    (a, b) => (b.rssi ?? Number.NEGATIVE_INFINITY) - (a.rssi ?? Number.NEGATIVE_INFINITY),
  );
}

/**
 * The devices found in the order already shown, by id; devices not shown yet follow, the
 * strongest signal first. Signals change all the time: rows that move would be hard to hit.
 */
export function inShownOrder(
  shown: readonly string[],
  candidates: readonly DeviceCandidate[],
): DeviceCandidate[] {
  const place = (c: DeviceCandidate) => {
    const at = shown.indexOf(c.deviceId);
    return at === -1 ? Number.POSITIVE_INFINITY : at;
  };
  const known = candidates.filter((c) => shown.includes(c.deviceId));
  const added = candidates.filter((c) => !shown.includes(c.deviceId));
  return [...known.sort((a, b) => place(a) - place(b)), ...bySignal(added)];
}

/**
 * The devices found, one group per device: a device seen over both links is found once per link,
 * and the device plugin names the other one `sameDeviceAs`. A group stands where its first link
 * does, its links in that order.
 */
export function byDevice(candidates: readonly DeviceCandidate[]): DeviceCandidate[][] {
  const groups = new Map<string, DeviceCandidate[]>();
  for (const candidate of candidates) {
    const twin = candidate.sameDeviceAs;
    const key = twin !== undefined && groups.has(twin) ? twin : candidate.deviceId;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return [...groups.values()];
}

/** Bars out of four for a signal in dBm, as phones show them. */
export function signalBars(rssi: number): number {
  return rssi >= -60 ? 4 : rssi >= -70 ? 3 : rssi >= -80 ? 2 : 1;
}

/** What the setup says under its title. */
export function summarize(all: readonly DeviceStatus[], text: Messages): {
  readonly text: string;
  readonly settled: boolean;
} {
  const devices = shown(all);
  if (devices.length > 0 && devices.every((d) => d.state === 'connected')) {
    return { text: text.allConnected, settled: true };
  }
  if (devices.some((d) => d.state !== 'connected' && d.state !== 'disconnected')) {
    return { text: text.connecting, settled: false };
  }
  return { text: text.withoutDevices, settled: false };
}

/** The companion phone's row: its own kind of row, from the bridge state. */
export interface CompanionRow {
  readonly title: string;
  readonly detail: string;
  readonly state: BridgeState;
  readonly companionName?: string;
  readonly status: string;
  readonly tone: Tone;
  /** Why it is in that state, for the details ("by ridrs", "wrong code", …). */
  readonly reason?: string;
  /** What the companion is for, in one sentence. */
  readonly about: string;
  /** What the rider can do about the state, when there is something to do. */
  readonly tip?: string;
}

/** The tone of the companion's state; its words and tips are in `Messages.bridgeStates`. */
const BRIDGE_TONES: Record<BridgeState, Tone> = {
  unpaired: 'none',
  connecting: 'busy',
  connected: 'ok',
  // "Reconnecting…" says it all: no tip.
  reconnecting: 'busy',
  unreachable: 'warn',
  disconnected: 'warn',
  rejected: 'warn',
};

export interface BridgeStatus {
  readonly state: BridgeState;
  readonly companionName?: string;
  readonly reason?: string;
}

export function describeCompanion(bridge: BridgeStatus, text: Messages): CompanionRow {
  const words = text.bridgeStates[bridge.state] ?? { status: bridge.state };
  const tips = text.unreachableTips;
  return {
    title: text.companion.title,
    detail: bridge.companionName ?? text.companion.detail,
    state: bridge.state,
    ...(bridge.companionName ? { companionName: bridge.companionName } : {}),
    about: text.companion.about,
    status: words.status,
    tone: BRIDGE_TONES[bridge.state],
    ...(words.tip ? { tip: words.tip } : {}),
    ...(bridge.state === 'unreachable' ? { tip: tips[bridge.reason ?? 'error'] ?? tips.error } : {}),
    ...(bridge.reason ? { reason: text.bridgeReasons[bridge.reason] ?? bridge.reason } : {}),
  };
}
