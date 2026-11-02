// SPDX-License-Identifier: AGPL-3.0-or-later

import { physicsStateEvent } from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { laneDashes } from './lane-markings.ts';

/** A frame later than this (a hidden or stalled window) moves the road by this much at most. */
const MAX_FRAME_SECONDS = 0.1;

function dashesPath(position: number): string {
  return laneDashes(position)
    .map((quad) => `M${quad.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join('L')}Z`)
    .join('');
}

/**
 * Moves the lane markings at the virtual rider's speed. Speed comes from `physics.state` (4 Hz);
 * the road position is advanced every animation frame, so the markings move smoothly between
 * states. It is presentation only: the physics' distance stays the authoritative one.
 */
function useMovingRoad(ctx: UiContext) {
  const markings = useRef<SVGGElement>(null);
  const dashes = useRef<SVGPathElement>(null);

  useEffect(() => {
    let speed = 0;
    let position = 0;
    let last: number | undefined;
    let frame = 0;
    const draw = () => {
      dashes.current?.setAttribute('d', dashesPath(position));
      markings.current?.setAttribute('data-position', position.toFixed(3));
    };
    const tick = (now: number) => {
      const seconds = last === undefined ? 0 : Math.min((now - last) / 1000, MAX_FRAME_SECONDS);
      last = now;
      if (speed > 0) {
        position += speed * seconds;
        draw();
      }
      frame = requestAnimationFrame(tick);
    };
    draw();
    frame = requestAnimationFrame(tick);
    const unsubscribe = ctx.events.subscribe(physicsStateEvent, ({ payload }) => {
      speed = payload.speed;
    });
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [ctx]);

  return { markings, dashes };
}

/** A deliberately flat backdrop: sky, ground and a road to the horizon. */
function FlatLandscapeView({ ctx }: { readonly ctx: UiContext }) {
  const { markings, dashes } = useMovingRoad(ctx);
  return (
    <svg
      data-testid="landscape-flat"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      role="img"
      aria-label="Flat landscape"
    >
      <defs>
        <linearGradient id="ridrs-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5aa9e6" />
          <stop offset="1" stopColor="#cde7f7" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="100" height="55" fill="url(#ridrs-sky)" />
      <rect x="0" y="55" width="100" height="45" fill="#6a9f4b" />
      <polygon points="47,55 53,55 80,100 20,100" fill="#555b61" />
      <g ref={markings} data-testid="lane-markings">
        <path ref={dashes} fill="#f2f2f2" />
      </g>
    </svg>
  );
}

export const FlatLandscape: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<FlatLandscapeView ctx={ctx} />);
  return () => root.unmount();
};
