// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The trainer debug HUD's texts in German (ADR 0072). */
export const de: Messages = {
  title: 'Trainer-Debug',
  mode: 'Modus',
  command: 'Befehl',
  gear: 'Gang',
  gradient: 'Steigung',
  target: (watts: number) => `Ziel ${watts} W`,
  grade: (percent: string) => `Steigung ${percent}`,
  wind: (speed: string) => `Wind ${speed} m/s`,
  ratio: (ratio: string) => `Übersetzung ${ratio}`,
  roadToTrainer: (road: string, trainer: string) => `Straße ${road} → Trainer ${trainer}`,
};
