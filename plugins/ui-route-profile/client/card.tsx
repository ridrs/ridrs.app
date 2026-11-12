// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RouteOffer } from '@ridrs/contracts';
import { useEffect, useRef } from 'react';
import type { Messages } from './i18n/index.ts';

/**
 * How high a card's profile rises, as a share of the card: by the route's rise from its lowest to
 * its highest point alone, 30 % for 1000 m and by the square root of that below, so 500 m still
 * rise 21 % and a flat route stays visible. It stops at the top of its area, 42 % of the card
 * (`.pv-teaser-backdrop` in ui-preview), from about 1960 m.
 */
const FULL_RISE = 1000;
const FULL_RISE_SHARE = 0.3;
const BACKDROP_SHARE = 0.42;
const riseShare = (rise: number) => Math.min(FULL_RISE_SHARE * Math.sqrt(Math.max(rise, 0) / FULL_RISE), BACKDROP_SHARE);

/**
 * How far above the card's lower edge the profile's lowest point sits, in the 32 units of its
 * area (about 7 px on a card): clear of the card's rounded corners, so a route that starts at its
 * lowest point still shows its first metres. The fill below still reaches the edge.
 */
const PROFILE_LIFT = 2.5;

/** How long the glowing dot takes to ride a card's profile from start to end. */
const TRACE_MS = 1600;

const TRACE_DOT = {
  position: 'absolute',
  width: 7,
  height: 7,
  margin: '-3.5px 0 0 -3.5px',
  borderRadius: '50%',
  background: '#fff',
  boxShadow: '0 0 6px 2px var(--ridrs-accent, #b8f53b), 0 0 16px 5px rgb(184 245 59 / .55)',
  opacity: 0,
  pointerEvents: 'none',
  // Keeps the dot on its own layer at all times. Otherwise the browser layers it (and the title
  // over it) only while it rides, and redraws the title a pixel off once the ride ends.
  willChange: 'opacity, left, top',
} as const;

/**
 * Rides a glowing dot once along the profile, from start to end, when the pointer enters the card
 * (or the keyboard focuses it); it is gone at once when the pointer or the focus leaves. The
 * profile is stretched to the card, so the dot moves over the points in percent of the box instead
 * of inside the SVG, where it would be stretched too.
 */
function useTrace(points: readonly (readonly [number, number])[]) {
  const box = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the points follow the offer, which keys the card.
  useEffect(() => {
    const card = box.current?.closest('.pv-teaser');
    const element = dot.current;
    if (!card || !element || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    let running: Animation | undefined;
    const ride = () => {
      if (running?.playState === 'running') return;
      running = element.animate?.(
        points.map(([x, y], i) => ({
          left: `${x}%`,
          top: `${(y / 32) * 100}%`,
          opacity: i === 0 || i === points.length - 1 ? 0 : 1,
        })),
        { duration: TRACE_MS, easing: 'ease-in-out' },
      );
    };
    const stop = () => running?.cancel();
    card.addEventListener('mouseenter', ride);
    card.addEventListener('focusin', ride);
    card.addEventListener('mouseleave', stop);
    card.addEventListener('focusout', stop);
    return () => {
      card.removeEventListener('mouseenter', ride);
      card.removeEventListener('focusin', ride);
      card.removeEventListener('mouseleave', stop);
      card.removeEventListener('focusout', stop);
      stop();
    };
  }, []);
  return { box, dot };
}

/**
 * The route's elevations as a hill: a filled area from start to end under a line, from its lowest
 * point up. On a card it rises behind the title, and a glowing dot rides it once on hover.
 */
export function CardProfile({
  offer,
  text,
}: {
  /** An offer, or what a preview knows of a route that is none yet (ADR 0093). */
  readonly offer: Pick<RouteOffer, 'id' | 'title' | 'sparkline'>;
  readonly text: Messages;
}) {
  const elevations = offer.sparkline ?? [];
  const low = Math.min(...elevations);
  const rise = Math.max(...elevations) - low;
  // The hill's height in the 32 units of the profile's area, which is the card's lowest 42 %. The
  // lift only moves it up, so the height still follows the rise alone, up to the area's top.
  const hill = Math.min((riseShare(rise) / BACKDROP_SHARE) * 32, 32 - PROFILE_LIFT);
  const points = elevations.map(
    (elevation, i) =>
      [(i / (elevations.length - 1)) * 100, 32 - PROFILE_LIFT - (rise > 0 ? ((elevation - low) / rise) * hill : 0)] as const,
  );
  const { box, dot } = useTrace(points);
  if (points.length < 2) {
    return null;
  }
  const line = points.map(([x, y]) => `${x},${y}`).join(' ');
  const fill = `area-${offer.id.replace(/[^A-Za-z0-9-]/g, '-')}`;
  const svg = (
    <svg
      role="img"
      aria-label={text.profileOf(offer.title)}
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      style={{ width: '100%', height: '100%', color: 'var(--ridrs-accent, #b8f53b)' }}
    >
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity={0.35} />
          <stop offset="1" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={`0,32 ${line} 100,32`} fill={`url(#${fill})`} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.85}
        strokeWidth={1.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
  return (
    <div ref={box} style={{ position: 'relative', width: '100%', height: '100%' }}>
      {svg}
      <span ref={dot} style={TRACE_DOT} />
    </div>
  );
}
