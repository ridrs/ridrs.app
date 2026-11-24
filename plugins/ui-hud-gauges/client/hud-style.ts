// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CSSProperties } from 'react';

/**
 * Flat, lean frosted glass sheet shared by the upper HUD panels (`ride-facts` and `route-box`),
 * matching `ui-widget-workout`: one 12 px translucent surface with a single hairline edge and no
 * nested boxes or inner bevels.
 */
export const HUD_PANEL_GLASS: CSSProperties = {
  borderRadius: 'var(--ridrs-radius)',
  backgroundColor: 'rgb(8 13 22 / .72)',
  backdropFilter: 'blur(16px) saturate(140%)',
  WebkitBackdropFilter: 'blur(16px) saturate(140%)',
  boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / .1), 0 12px 28px -8px rgb(0 0 0 / .45)',
  color: 'var(--ridrs-text)',
  fontFamily: 'var(--ridrs-font-text)',
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
