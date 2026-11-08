// SPDX-License-Identifier: AGPL-3.0-or-later

/** The trainer debug HUD's texts in English (ADR 0072): the shape of every language. */
export const en = {
  title: 'Trainer debug',
  mode: 'Mode',
  command: 'Command',
  gear: 'Gear',
  gradient: 'Gradient',
  target: (watts: number) => `target ${watts} W`,
  grade: (percent: string) => `grade ${percent}`,
  wind: (speed: string) => `wind ${speed} m/s`,
  ratio: (ratio: string) => `ratio ${ratio}`,
  roadToTrainer: (road: string, trainer: string) => `road ${road} → trainer ${trainer}`,
};

export type Messages = typeof en;
