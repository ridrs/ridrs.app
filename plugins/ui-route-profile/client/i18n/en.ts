// SPDX-License-Identifier: AGPL-3.0-or-later

/** The route profile's texts in English (ADR 0072): the shape of every language. */
export const en = {
  profileOf: (title: string) => `Elevation profile of ${title}`,
  gradients: 'Gradients',
  /** m along the route as the rider reads it: `14.3`. */
  km: (metres: number) => (metres / 1000).toFixed(1),
  kmAt: (km: string) => `km ${km}`,
  metres: (metres: number) => `${Math.round(metres)} m`,
  /** A categorised climb's name: `HC` or `Cat 1` to `Cat 4` (ADR 0070). */
  category: (category: string) => (category === 'HC' ? 'HC' : `Cat ${category}`),
  /** The gradient bands of the profile, flattest first (`GRADES`). */
  grades: ['below 2 %', '2–4 %', '4–6 %', '6–8 %', '8–10 %', '10 % and more'] as readonly string[],
};

export type Messages = typeof en;
