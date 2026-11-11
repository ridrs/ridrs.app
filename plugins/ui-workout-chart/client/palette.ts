// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The zone colours (structured-workouts.md, section 6): a ramp of ten, cool to hot, for as many
 * zones as intervals.icu allows. Neighbouring colours differ in hue and in lightness, so they
 * stay apart for the common kinds of colour blindness (checked in `palette.test.ts`); the
 * tooltip names the zone besides its colour. Dark and light differ in lightness only.
 */
export const DARK_ZONES = [
  '#0a3aff',
  '#59a6cf',
  '#0ffae3',
  '#99db94',
  '#f5ff3d',
  '#d0a771',
  '#f68c14',
  '#fe2966',
  '#ff70e0',
  '#8b49fa',
] as const;

export const LIGHT_ZONES = [
  '#072ab8',
  '#407895',
  '#0bb4a3',
  '#6e9e6b',
  '#b0b82c',
  '#967851',
  '#b1650e',
  '#b71e49',
  '#b851a1',
  '#6435b4',
] as const;

/** The palette slot of a 1-based zone, spreading `count` zones over the ten slots. */
export function paletteSlot(zone: number, count: number): number {
  const slots = DARK_ZONES.length;
  const total = Math.min(Math.max(Math.round(count), 1), slots);
  const index = Math.min(Math.max(Math.round(zone), 1), Math.max(count, 1)) - 1;
  if (count > slots) return Math.min(index, slots - 1);
  return total === 1 ? 0 : Math.round((index * (slots - 1)) / (total - 1));
}

/** The CSS custom properties of both themes: `--wc-z1` … `--wc-z10`. */
export const PALETTE_CSS = `
:root { ${DARK_ZONES.map((c, i) => `--wc-z${i + 1}: ${c};`).join(' ')}
  --wc-neutral: #5d7088; --wc-line: #8b9db2; --wc-text: #f2f5fa; --wc-muted: #93a1b8;
  --wc-surface: #131c2e; --wc-focus: #ccff00; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {
  ${LIGHT_ZONES.map((c, i) => `--wc-z${i + 1}: ${c};`).join(' ')}
  --wc-neutral: #8a9bb0; --wc-line: #5c6b80; --wc-text: #101828; --wc-muted: #52607a;
  --wc-surface: #ffffff; --wc-focus: #0a58ff; } }
:root[data-theme="light"] { ${LIGHT_ZONES.map((c, i) => `--wc-z${i + 1}: ${c};`).join(' ')}
  --wc-neutral: #8a9bb0; --wc-line: #5c6b80; --wc-text: #101828; --wc-muted: #52607a;
  --wc-surface: #ffffff; --wc-focus: #0a58ff; }
`;

/** The fill of a zone, as a CSS colour; neutral without a zone. */
export function zoneColour(zone: number | undefined, count: number): string {
  return zone === undefined ? 'var(--wc-neutral)' : `var(--wc-z${paletteSlot(zone, count) + 1})`;
}
