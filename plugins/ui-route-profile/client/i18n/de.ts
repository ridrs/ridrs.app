// SPDX-License-Identifier: AGPL-3.0-or-later

import { localizeNumber } from '@ridrs/ui-sdk';
import type { Messages } from './en.ts';

export const de: Messages = {
  profileOf: (title: string) => `Höhenprofil von ${title}`,
  gradients: 'Steigungen',
  km: (metres: number) => localizeNumber((metres / 1000).toFixed(1), 'de'),
  kmAt: (km: string) => `km ${km}`,
  metres: (metres: number) => `${Math.round(metres)} m`,
  category: (category: string) => (category === 'HC' ? 'HC' : `Kat. ${category}`),
  grades: ['unter 2 %', '2–4 %', '4–6 %', '6–8 %', '8–10 %', '10 % und mehr'],
};
