// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CSSProperties } from 'react';

/**
 * Shared cockpit surface language for the upper HUD panels (`ride-facts` and `route-box`), matching
 * the frosted dark glass of the bottom telemetry gauges (`gauge.tsx`) and `ui-widget-workout`.
 */
export const HUD_PANEL_GLASS: CSSProperties = {
  borderRadius: 'var(--ridrs-radius-lg)',
  backgroundColor: 'rgb(10 16 28 / .68)',
  backgroundImage:
    'linear-gradient(180deg, rgb(28 44 72 / .34) 0%, rgb(11 18 32 / .18) 44%, rgb(5 9 18 / .38) 100%)',
  backdropFilter: 'blur(16px) saturate(145%)',
  WebkitBackdropFilter: 'blur(16px) saturate(145%)',
  boxShadow:
    '0 18px 42px -10px rgb(0 0 0 / .58), inset 0 1px 0 rgb(255 255 255 / .2), inset 0 0 0 1px rgb(255 255 255 / .12)',
  color: 'var(--ridrs-text)',
  fontFamily: 'var(--ridrs-font-text)',
};

/** Recessed dark well inside a HUD glass panel for charts, elevation profiles and maps. */
export const HUD_CHART_WELL: CSSProperties = {
  borderRadius: 'var(--ridrs-radius-sm)',
  backgroundColor: 'rgb(5 9 18 / .54)',
  boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / .08), inset 0 2px 6px rgb(0 0 0 / .35)',
};

/** Standard 11 px mono micro-label used uniformly across every HUD metric and header. */
export const HUD_LABEL: CSSProperties = {
  fontFamily: 'var(--ridrs-font-mono)',
  fontSize: 'var(--ridrs-size-label)',
  fontWeight: 500,
  lineHeight: 1.15,
  letterSpacing: '.1em',
  textTransform: 'uppercase',
  color: 'var(--ridrs-info)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

/** Standard muted unit beside a HUD figure (`km`, `km/h`, `W`, `rpm`, `%`, `m`). */
export const HUD_UNIT: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1,
  color: 'var(--ridrs-text-muted)',
};
