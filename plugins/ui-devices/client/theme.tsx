// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BleRoute } from '@ridrs/contracts';
import type { RowKind } from './devices.ts';

/**
 * The look of docs/ux-draft: dark panels, cyan for "busy", lime for "ok", amber for "warn".
 * Animations and pseudo elements need a style sheet; class names carry the plugin's prefix.
 */
const CSS = `
.rd-row:hover, .rd-back:hover, .rd-continue:hover { border-color: #27c8ff !important; }
.rd-line:hover { background: #27c8ff14 !important; }
.rd-row:focus-visible, .rd-back:focus-visible,
.rd-continue:focus-visible { outline: 2px solid #8dff2a; outline-offset: 2px; }
.rd-spin { display: inline-block; flex: none; vertical-align: middle;
  width: 16px; height: 16px; border-radius: 50%; border: 2px solid #27c8ff40;
  border-top-color: #27c8ff; animation: rd-spin 1s linear infinite; }
@keyframes rd-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .rd-spin { animation: none; } }
`;

export function DeviceStyles() {
  return <style>{CSS}</style>;
}

export const COLORS = {
  panel: '#0a1520',
  line: '#1f3447',
  cyan: '#27c8ff',
  lime: '#8dff2a',
  amber: '#ffb62e',
  muted: '#8b9db2',
  red: '#ff4d5e',
} as const;

/**
 * The icons in `assets/icons` come unchanged from Lucide (ISC, see the folder's LICENSE). They
 * are painted as a mask, so they take the text colour like the drawn icons below.
 */
const TRASH = new URL('./assets/icons/trash-2.svg', import.meta.url).href;

/** The bin of Remove, sized to sit before the button's word. */
export function TrashIcon() {
  const mask = `url("${TRASH}") center / contain no-repeat`;
  return (
    <span
      aria-hidden
      data-icon="trash"
      style={{
        display: 'inline-block',
        flex: 'none',
        width: 18,
        height: 18,
        background: 'currentColor',
        WebkitMask: mask,
        mask,
      }}
    />
  );
}

const svg = {
  'aria-hidden': true,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function KindIcon({ kind }: { readonly kind: RowKind }) {
  switch (kind) {
    case 'power':
      return (
        <svg {...svg} width="30" height="30" viewBox="0 0 24 24">
          <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
        </svg>
      );
    case 'trainer':
      return (
        <svg {...svg} width="30" height="30" viewBox="0 0 24 24">
          <circle cx="14" cy="9" r="6" />
          <circle cx="14" cy="9" r="1.5" />
          <path d="M10 13.5 4 21h12" />
        </svg>
      );
    case 'heart-rate':
      return (
        <svg {...svg} width="30" height="30" viewBox="0 0 24 24">
          <path d="M12 20s-8-5-8-11a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 6-8 11-8 11z" />
        </svg>
      );
    case 'controller':
      return (
        <svg {...svg} width="30" height="30" viewBox="0 0 24 24">
          <path d="M6 8h12a4 4 0 0 1 4 4v1a4 4 0 0 1-7 2.6L14 14h-4l-1 1.6A4 4 0 0 1 2 13v-1a4 4 0 0 1 4-4z" />
          <path d="M7 10.5v3M5.5 12h3M16 11h.01M18 13h.01" />
        </svg>
      );
  }
}

/**
 * A phone: a wide body with a screen, a speaker slot at the top and a dot at the bottom. A plain
 * rounded bar with one line reads as a battery.
 */
function PhoneShape() {
  return (
    <>
      <rect x="5.5" y="2" width="13" height="20" rx="3" />
      <rect x="7.5" y="5.5" width="9" height="11.5" rx="0.5" strokeWidth={1.2} />
      <path d="M10.5 3.8h3" />
      <circle cx="12" cy="19.4" r="0.6" fill="currentColor" />
    </>
  );
}

/** The companion phone's row. */
export function PhoneIcon() {
  return (
    <svg {...svg} width="30" height="30" viewBox="0 0 24 24">
      <PhoneShape />
    </svg>
  );
}

/** The link a device found is seen over, sized to sit next to the signal bars. */
export function LinkIcon({ route, label }: { readonly route: BleRoute; readonly label: string }) {
  return (
    <svg
      {...svg}
      aria-hidden={undefined}
      role="img"
      aria-label={label}
      data-testid="found-link"
      strokeWidth={2}
      width="16"
      height="16"
      viewBox="0 0 24 24"
    >
      <title>{label}</title>
      {route === 'local' ? (
        // The Bluetooth rune.
        <path d="m7 7 10 10-5 5V2l5 5L7 17" />
      ) : (
        <PhoneShape />
      )}
    </svg>
  );
}

/** An arrow pointing up, turned by `rotate` degrees; sized to sit in a status badge. */
export function ArrowIcon({ rotate }: { readonly rotate: number }) {
  return (
    <svg
      {...svg}
      strokeWidth={3}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <path d="M12 20V4M5 11l7-7 7 7" />
    </svg>
  );
}

/**
 * The power-up bolt, sized like `ArrowIcon`: the ⚡ character renders as a colour emoji on most
 * systems and would not match the other badges.
 */
export function BoltIcon() {
  return (
    <svg {...svg} fill="currentColor" strokeWidth={1.5} width="14" height="14" viewBox="0 0 24 24">
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </svg>
  );
}

/** The small icons of the details grid. */
export type FactKind = 'status';

export function FactIcon({ icon }: { readonly icon: FactKind }) {
  const paths: Record<FactKind, string> = {
    status: 'M3 12h4l3-7 4 14 3-7h4',
  };
  return (
    <svg {...svg} strokeWidth={1.8} width="18" height="18" viewBox="0 0 24 24">
      <path d={paths[icon]} />
    </svg>
  );
}

/** The bulb of the tip box. */
export function BulbIcon() {
  return (
    <svg {...svg} strokeWidth={1.8} width="26" height="26" viewBox="0 0 24 24">
      <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
    </svg>
  );
}

export function BikeIcon() {
  return (
    <svg {...svg} strokeWidth={2.6} width="88" height="56" viewBox="0 0 88 56">
      <circle cx="18" cy="38" r="14" />
      <circle cx="70" cy="38" r="14" />
      <path d="M18 38 30 16h22l18 22M30 16l14 22H18M26 10h10M52 16l-3-7h8" />
    </svg>
  );
}
