// SPDX-License-Identifier: AGPL-3.0-or-later

/** The devices' texts in English (ADR 0072): the shape of every language. */
export const en = {
  /** What the heart rate monitor's details say in place of what it is for: one, picked on open. */
  thoughts: [
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
  ] as readonly string[],
  /** What the rider sees per kind of row. */
  kinds: {
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
  },
  /** A held button's name for screen readers. */
  buttons: {
    left: 'D-pad left',
    up: 'D-pad up',
    right: 'D-pad right',
    down: 'D-pad down',
    a: 'A',
    b: 'B',
    y: 'Y',
    z: 'Z',
    'shift-up-left': 'Left shift up',
    'shift-down-left': 'Left shift down',
    'power-up-left': 'Left power-up',
    'on-off-left': 'Left on/off',
    'shift-up-right': 'Right shift up',
    'shift-down-right': 'Right shift down',
    'power-up-right': 'Right power-up',
    'on-off-right': 'Right on/off',
  },
  /** A device's connection state, and what the rider can do about it. */
  states: {
    none: { status: 'Not set up' },
    searching: { status: 'Searching…', tip: 'Wake the device and keep it close.' },
    connecting: { status: 'Connecting…' },
    connected: { status: 'Connected' },
    reconnecting: { status: 'Reconnecting…' },
    disconnected: { status: 'Disconnected' },
  } as Readonly<Record<string, { readonly status: string; readonly tip?: string }>>,
  watts: (watts: number) => `${watts} W`,
  bpm: (bpm: number) => `${bpm} bpm`,
  allConnected: 'Everything is connected.',
  connecting: 'Connecting your devices. You can ride without waiting.',
  withoutDevices: 'You can ride without devices.',
  companion: {
    title: 'Companion App',
    detail: 'Phone with the ridrs companion',
    about: 'Brings the phone’s Bluetooth devices over Wi-Fi.',
  },
  /** The companion's connection state, and what the rider can do about it. */
  bridgeStates: {
    unpaired: { status: 'Not connected' },
    connecting: { status: 'Connecting…' },
    connected: { status: 'Connected' },
    reconnecting: { status: 'Reconnecting…' },
    unreachable: { status: 'Not reachable' },
    disconnected: { status: 'Disconnected' },
    rejected: { status: 'Pairing failed', tip: 'Check the code on the phone.' },
  } as Readonly<Record<string, { readonly status: string; readonly tip?: string }>>,
  /** What the rider can check when the companion cannot be reached, by the reason. */
  unreachableTips: {
    refused: 'Open the companion app and keep the screen on.',
    network: 'Use the same Wi-Fi; on a Mac, allow Local Network access.',
    timeout: 'Use the same Wi-Fi and open the companion app.',
    error: 'Open the companion app and keep the screen on.',
  } as Readonly<Record<string, string>>,
  /** Why the companion is in its state, by the bridge's reason. */
  bridgeReasons: {
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
  } as Readonly<Record<string, string>>,
  devices: 'Devices',
  setUp: 'Set up your devices',
  allDevices: 'All devices',
  titleStart: 'Connect Your',
  titleEnd: 'Devices',
  back: 'Back',
  searching: 'Searching…',
  notSearching: 'Not searching',
  done: 'Done',
  continue: 'Continue',
  moreFound: (count: number) => `${count} more found`,
  found: (count: number) => `${count} found`,
  tip: 'Tip',
  /** A link's name by its icon. */
  links: { local: 'Direct', companion: 'Companion' },
  /** How Switch to names a link. */
  over: { local: 'Bluetooth', companion: 'companion' },
  /** How every Connect names the link it uses. */
  connectWith: { local: 'with Bluetooth', companion: 'with companion' },
  connectDevice: (name: string, how: string) => `Connect ${name} ${how}`,
  connectHow: (how: string) => `Connect ${how}`,
  orConnect: (how: string) => `or connect ${how}`,
  switchTo: (link: string) => `Switch to ${link}`,
  signal: (bars: number) => `Signal ${bars} of 4`,
  battery: (level: number) => `Battery ${level} %`,
  control: 'Control',
  /** How ridrs controls the trainer, in a word or two (ADR 0056). */
  controlValues: {
    erg: (watts: string) => `ERG ${watts} W`,
    simulation: 'simulation',
    ready: 'ready',
    requested: 'requested',
    refused: 'refused',
    lost: 'lost',
  },
  remove: 'Remove',
  devicesFound: 'Devices found',
  reason: 'Reason',
  tryAgain: 'Try again',
  connect: 'Connect',
};

export type Messages = typeof en;
