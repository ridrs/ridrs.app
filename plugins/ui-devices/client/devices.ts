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

/** What the heart rate monitor's details say in place of what it is for: one, picked on open. */
export const HEART_RATE_THOUGHTS: readonly string[] = [
  'Your heart is a muscle, not a machine. Train it consistently, challenge it progressively, and give it time to adapt.',
  "A stronger heart doesn't always beat faster. One of the beautiful signs of endurance adaptation is delivering more blood with fewer beats.",
  "Don't chase your heart rate. Understand it. Power tells you what you produce; heart rate tells you how your body responds.",
  'The heart remembers consistency. One heroic ride changes little. Hundreds of ordinary rides change everything.',
  'Easy rides build a strong heart, too. The discipline to ride slowly is often more valuable than the courage to ride hard.',
  'Heart rate is a conversation, not a command. Heat, fatigue, stress, hydration and sleep all influence what your heart tells you.',
  'A drifting heart rate is a message. When the same power requires more effort over time, your body is telling you something about its current limits.',
  'Recovery is when the heart gets stronger. Training provides the stimulus; adaptation happens afterward.',
  "Your heart has no interest in your FTP. It doesn't care about segments, rankings or personal records. It cares about staying healthy enough to keep going.",
  "The ultimate goal is not a lower heart rate. It's a longer life in motion. The best training is the training that allows you to keep riding, exploring and enjoying the road for decades.",
  'Train your legs to climb mountains. Train your heart to enjoy the journey.',
];

const KINDS: Record<RowKind, { title: string; label: string; examples: string; about: string }> =
  {
    power: {
      title: 'Power Meter',
      label: 'Power',
      examples: 'e.g. Assioma, Favero, Stages',
      about: 'Your power, measured by the trainer for now.',
    },
    trainer: {
      title: 'Smart Trainer',
      label: 'Trainer',
      examples: 'e.g. Wahoo, Tacx, Elite',
      about: 'Power, cadence and speed; sets the climb resistance.',
    },
    'heart-rate': {
      title: 'Heart Rate Monitor',
      label: 'Heart rate',
      examples: 'e.g. Polar, Garmin, Apple Watch',
      about: 'Your heart rate.',
    },
    controller: {
      title: 'Controller',
      label: 'Controller',
      examples: 'e.g. Zwift Ride',
      about: 'Its buttons steer ridrs.',
    },
  };

/** How a held button shows in the badge, and its name for screen readers. */
export const BUTTON_FACES: Record<ControllerButton, { readonly symbol: string; readonly name: string }> =
  {
    left: { symbol: '←', name: 'D-pad left' },
    up: { symbol: '↑', name: 'D-pad up' },
    right: { symbol: '→', name: 'D-pad right' },
    down: { symbol: '↓', name: 'D-pad down' },
    a: { symbol: 'A', name: 'A' },
    b: { symbol: 'B', name: 'B' },
    y: { symbol: 'Y', name: 'Y' },
    z: { symbol: 'Z', name: 'Z' },
    'shift-up-left': { symbol: '+', name: 'Left shift up' },
    'shift-down-left': { symbol: '−', name: 'Left shift down' },
    'power-up-left': { symbol: '⚡', name: 'Left power-up' },
    'on-off-left': { symbol: '⏻', name: 'Left on/off' },
    'shift-up-right': { symbol: '+', name: 'Right shift up' },
    'shift-down-right': { symbol: '−', name: 'Right shift down' },
    'power-up-right': { symbol: '⚡', name: 'Right power-up' },
    'on-off-right': { symbol: '⏻', name: 'Right on/off' },
  };

const STATES: Record<DeviceRow['state'], { status: string; tone: Tone; tip?: string }> = {
  none: { status: 'Not set up', tone: 'none' },
  searching: {
    status: 'Searching…',
    tone: 'busy',
    tip: 'Wake the device and keep it close.',
  },
  connecting: { status: 'Connecting…', tone: 'busy' },
  connected: { status: 'Connected', tone: 'ok' },
  // "Reconnecting…" says it all: no tip.
  reconnecting: { status: 'Reconnecting…', tone: 'busy' },
  disconnected: { status: 'Disconnected', tone: 'warn' },
};

type Proof = Pick<DeviceRow, 'held'> & { readonly status?: string };

/**
 * Only a reading of the device in the row, and only while it is connected, proves the row: the
 * watts and the heart rate replace "Connected", held buttons replace the check.
 */
function proofOf(kind: RowKind, device: DeviceStatus | undefined, readings: Readings): Proof {
  if (device?.state !== 'connected') {
    return {};
  }
  const own = <T extends { readonly deviceId: string }>(reading: T | undefined) =>
    reading?.deviceId === device.deviceId ? reading : undefined;
  switch (kind) {
    case 'power': {
      const power = own(readings.power);
      return power ? { status: `${Math.round(power.watts)} W` } : {};
    }
    case 'heart-rate': {
      const bpm = own(readings.heartRate)?.bpm;
      return bpm ? { status: `${Math.round(bpm)} bpm` } : {};
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

function row(kind: RowKind, device: DeviceStatus | undefined, readings: Readings): DeviceRow {
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
    title: KINDS[kind].title,
    label: KINDS[kind].label,
    detail: device?.deviceName || device?.lastDeviceName || KINDS[kind].examples,
    type: KINDS[deviceKind].title,
    about: KINDS[kind].about,
    state,
    ...STATES[state],
    ...proofOf(kind, device, readings),
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
  readings: Readings = {},
): DeviceRow[] {
  const trainer = devices.find((d) => d.kind === 'trainer');
  const controller = shown(devices).find((d) => d.kind === 'controller');
  return [
    row('power', trainer, readings),
    row('trainer', trainer, readings),
    row('heart-rate', devices.find((d) => d.kind === 'heart-rate'), readings),
    ...(controller ? [row('controller', controller, readings)] : []),
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
export function summarize(all: readonly DeviceStatus[]): {
  readonly text: string;
  readonly settled: boolean;
} {
  const devices = shown(all);
  if (devices.length > 0 && devices.every((d) => d.state === 'connected')) {
    return { text: 'Everything is connected.', settled: true };
  }
  if (devices.some((d) => d.state !== 'connected' && d.state !== 'disconnected')) {
    return { text: 'Connecting your devices. You can ride without waiting.', settled: false };
  }
  return { text: 'You can ride without devices.', settled: false };
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

const BRIDGE_STATES: Record<BridgeState, { status: string; tone: Tone; tip?: string }> = {
  unpaired: { status: 'Not connected', tone: 'none' },
  connecting: { status: 'Connecting…', tone: 'busy' },
  connected: { status: 'Connected', tone: 'ok' },
  // "Reconnecting…" says it all: no tip.
  reconnecting: { status: 'Reconnecting…', tone: 'busy' },
  unreachable: { status: 'Not reachable', tone: 'warn' },
  disconnected: { status: 'Disconnected', tone: 'warn' },
  rejected: { status: 'Pairing failed', tone: 'warn', tip: 'Check the code on the phone.' },
};

/** What the rider can check when the companion cannot be reached, by the reason. */
const UNREACHABLE_TIPS: Record<string, string> = {
  refused: 'Open the companion app and keep the screen on.',
  network: 'Use the same Wi-Fi; on a Mac, allow Local Network access.',
  timeout: 'Use the same Wi-Fi and open the companion app.',
  error: 'Open the companion app and keep the screen on.',
};

export const BRIDGE_REASONS: Record<string, string> = {
  'bad-code': 'wrong code',
  'bad-token': 'pairing was revoked',
  locked: 'too many wrong codes, wait a minute',
  incompatible: 'app versions do not match',
  busy: 'the companion is in use by another ridrs',
  unreachable: 'companion not reachable',
  'by-ridrs': 'by ridrs',
  'by-companion': 'on the phone',
  refused: 'the companion app is not open on the phone',
  network: 'not in this network',
  timeout: 'no answer',
  error: 'connection failed',
};

export interface BridgeStatus {
  readonly state: BridgeState;
  readonly companionName?: string;
  readonly reason?: string;
}

export function describeCompanion(bridge: BridgeStatus): CompanionRow {
  return {
    title: 'Companion App',
    detail: bridge.companionName ?? 'Phone with the ridrs companion',
    state: bridge.state,
    ...(bridge.companionName ? { companionName: bridge.companionName } : {}),
    about: 'Brings the phone’s Bluetooth devices over Wi-Fi.',
    ...BRIDGE_STATES[bridge.state],
    ...(bridge.state === 'unreachable'
      ? { tip: UNREACHABLE_TIPS[bridge.reason ?? 'error'] ?? UNREACHABLE_TIPS.error }
      : {}),
    ...(bridge.reason ? { reason: BRIDGE_REASONS[bridge.reason] ?? bridge.reason } : {}),
  };
}
