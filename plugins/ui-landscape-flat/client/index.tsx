// SPDX-License-Identifier: AGPL-3.0-or-later

import { activityStateChangedEvent } from '@ridrs/contracts';
import { createPhysicsPresentation, type PresentedPhysics } from '@ridrs/presentation';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { laneDashes } from './lane-markings.ts';

function dashesPath(position: number): string {
  return laneDashes(position)
    .map((quad) => `M${quad.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join('L')}Z`)
    .join('');
}

/**
 * Moves the lane markings by the presented distance, every frame of the shell's render clock.
 * The presentation interpolates the physics' own step states; the landscape never smooths,
 * predicts or integrates anything itself.
 */
function useMovingRoad(ctx: UiContext) {
  const svg = useRef<SVGSVGElement>(null);
  const markings = useRef<SVGGElement>(null);
  const dashes = useRef<SVGPathElement>(null);

  useEffect(() => {
    const presentation = createPhysicsPresentation(ctx.events);
    let position = 0;
    const draw = (shown: PresentedPhysics) => {
      if (shown.status === 'available' && shown.distance !== position) {
        position = shown.distance;
        dashes.current?.setAttribute('d', dashesPath(position));
        markings.current?.setAttribute('data-position', position.toFixed(3));
      }
      svg.current?.setAttribute(
        'data-distance',
        shown.status === 'available' ? shown.distance.toFixed(2) : '',
      );
      svg.current?.setAttribute('data-basis', shown.status === 'available' ? shown.basis : 'none');
    };
    dashes.current?.setAttribute('d', dashesPath(position));
    markings.current?.setAttribute('data-position', position.toFixed(3));
    const stopFrames = ctx.frames.onFrame((frame) => draw(presentation.at(frame.time)));
    // For the manual check: how many frames had an exact, interpolated or held state.
    const stopWatching = ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if (payload.state === 'finished') {
        ctx.logger.info(`Landscape presentation at ride finish: ${JSON.stringify(presentation.stats())}`);
      }
    });
    return () => {
      stopFrames();
      stopWatching();
      presentation.dispose();
    };
  }, [ctx]);

  return { svg, markings, dashes };
}

/** A deliberately flat backdrop: sky, ground and a road to the horizon. */
function FlatLandscapeView({ ctx }: { readonly ctx: UiContext }) {
  const { svg, markings, dashes } = useMovingRoad(ctx);
  return (
    <svg
      ref={svg}
      data-testid="landscape-flat"
      data-distance=""
      data-basis="none"
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
