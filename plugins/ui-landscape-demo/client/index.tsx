// SPDX-License-Identifier: AGPL-3.0-or-later

import { activityStateChangedEvent, type TerrainSurface, uiTerrainObservedEvent } from '@ridrs/contracts';
import { createPhysicsPresentation, type PresentedPhysics } from '@ridrs/presentation';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { DEMO_LANDSCAPE, type LandscapeModel, surfaceAt } from './landscape-model.ts';
import { laneDashes, type Quad } from './lane-markings.ts';
import { roadSections } from './road-sections.ts';
import { TerrainPublisher } from './terrain-publisher.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const SURFACE_COLOURS: Readonly<Record<TerrainSurface, string>> = Object.freeze({
  asphalt: '#555b61',
  gravel: '#a8916b',
});

const pathOf = (quads: readonly Quad[]) =>
  quads.map((quad) => `M${quad.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join('L')}Z`).join('');

/** Replaces the road sections with those at `position`, each tagged with its surface for tests. */
function drawRoad(group: SVGGElement, model: LandscapeModel, position: number): void {
  const paths = roadSections(model, position).map((section) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathOf([section.quad]));
    path.setAttribute('fill', SURFACE_COLOURS[section.surface]);
    path.setAttribute('data-surface', section.surface);
    path.setAttribute('data-from', section.from.toFixed(2));
    path.setAttribute('data-to', section.to.toFixed(2));
    return path;
  });
  group.replaceChildren(...paths);
}

/**
 * The landscape is the world's sensor (ADR 0044): it draws the road from its model at the
 * presented distance, every frame of the shell's render clock, and tells the host what it shows
 * ahead (`ui.terrain-observed`). The presentation interpolates the physics' own step states; the
 * landscape never smooths, predicts or integrates anything itself.
 */
function useLandscape(ctx: UiContext, model: LandscapeModel) {
  const svg = useRef<SVGSVGElement>(null);
  const road = useRef<SVGGElement>(null);
  const markings = useRef<SVGGElement>(null);
  const dashes = useRef<SVGPathElement>(null);

  useEffect(() => {
    const presentation = createPhysicsPresentation(ctx.events);
    const publisher = new TerrainPublisher(model, ({ samples, ...window }) =>
      ctx.events.publish(uiTerrainObservedEvent, { ...window, samples: [...samples] }),
    );
    let position = 0;
    const moveTo = (distance: number) => {
      position = distance;
      if (road.current) {
        drawRoad(road.current, model, position);
      }
      dashes.current?.setAttribute('d', pathOf(laneDashes(position)));
      markings.current?.setAttribute('data-position', position.toFixed(3));
      svg.current?.setAttribute('data-surface', surfaceAt(model.surface, position));
    };
    const draw = (shown: PresentedPhysics) => {
      if (shown.status === 'available' && shown.distance !== position) {
        moveTo(shown.distance);
      }
      svg.current?.setAttribute(
        'data-distance',
        shown.status === 'available' ? shown.distance.toFixed(2) : '',
      );
      svg.current?.setAttribute('data-basis', shown.status === 'available' ? shown.basis : 'none');
    };
    moveTo(position);
    const stopWatching = ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      publisher.rideState(payload);
      // For the manual check: how many frames had an exact, interpolated or held state.
      if (payload.state === 'finished') {
        ctx.logger.info(`Landscape presentation at ride finish: ${JSON.stringify(presentation.stats())}`);
      }
    });
    publisher.mount();
    const stopFrames = ctx.frames.onFrame((frame) => {
      const shown = presentation.at(frame.time);
      draw(shown);
      publisher.frame(shown);
    });
    return () => {
      stopFrames();
      stopWatching();
      presentation.dispose();
    };
  }, [ctx, model]);

  return { svg, road, markings, dashes };
}

function LandscapeView({ ctx, model }: { readonly ctx: UiContext; readonly model: LandscapeModel }) {
  const { svg, road, markings, dashes } = useLandscape(ctx, model);
  return (
    <svg
      ref={svg}
      data-testid="landscape"
      data-distance=""
      data-basis="none"
      data-surface=""
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      role="img"
      aria-label="Landscape"
    >
      <defs>
        <linearGradient id="ridrs-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5aa9e6" />
          <stop offset="1" stopColor="#cde7f7" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="100" height="55" fill="url(#ridrs-sky)" />
      <rect x="0" y="55" width="100" height="45" fill="#6a9f4b" />
      <g ref={road} data-testid="road" />
      <g ref={markings} data-testid="lane-markings">
        <path ref={dashes} fill="#f2f2f2" />
      </g>
    </svg>
  );
}

/** A landscape component for `model`: the demo landscape, or a fixture's short one. */
export function landscapeComponent(model: LandscapeModel): UiComponent {
  return (container, ctx) => {
    const root = createRoot(container);
    root.render(<LandscapeView ctx={ctx} model={model} />);
    return () => root.unmount();
  };
}

export const DemoLandscape: UiComponent = landscapeComponent(DEMO_LANDSCAPE);
