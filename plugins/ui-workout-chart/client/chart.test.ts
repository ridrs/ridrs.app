// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout, WorkoutStep } from '@ridrs/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cachedLayout, Chart, type ChartInput } from './chart.tsx';
import { messages } from './i18n/index.ts';

const percent = (id: string, seconds: number, low: number, high = low, end?: number): WorkoutStep => ({
  kind: 'interval',
  id,
  duration: { kind: 'time', seconds },
  effort: {
    kind: 'target',
    primary: {
      unit: 'percent-ftp',
      start: { low, high },
      ...(end === undefined ? {} : { end: { low: end, high: end } }),
    },
  },
});

const sweetSpot: Workout = {
  format: 'ridrs-workout',
  version: 1,
  id: 'ss',
  name: 'Sweet Spot 3x12',
  sport: 'ride',
  source: { kind: 'user' },
  steps: [
    { ...percent('warm', 720, 50, 50, 75), intensity: 'warm-up' } as WorkoutStep,
    {
      kind: 'repeat',
      id: 'main',
      until: { kind: 'count', reps: 3 },
      steps: [percent('on', 720, 90), percent('off', 240, 55)],
    },
    { ...percent('cool', 300, 60, 60, 40), intensity: 'cool-down' } as WorkoutStep,
  ],
};

const html = (input: ChartInput, language: 'en' | 'de' = 'en') =>
  renderToStaticMarkup(createElement(Chart, { input, text: messages[language], onStepFocused: () => {} }));

describe('the micro chart', () => {
  const markup = html({ workout: sweetSpot, athlete: { ftp: 250 }, variant: 'micro' });

  it('is a described picture that is not focusable', () => {
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="65 minutes, 3 intervals of 12 minutes at 90 %"');
    expect(markup).not.toContain('tabindex');
  });

  it('draws a silhouette without text, axes or FTP line', () => {
    expect(markup.match(/data-shape/g)).toHaveLength(8);
    expect(markup).not.toContain('<text');
    expect(markup).not.toContain('workout-chart-ftp-line');
  });
});

describe('the mini chart', () => {
  it('has the dashed FTP line and the duration and load below', () => {
    const markup = html({ workout: sweetSpot, athlete: { ftp: 250 }, variant: 'mini' });
    expect(markup).toContain('workout-chart-ftp-line');
    expect(markup).toContain('65 min');
    expect(markup).toMatch(/TSS \d+/);
    expect(markup).not.toContain('tabindex');
  });

  it('is neutral with a discreet hint without an FTP', () => {
    const markup = html({ workout: sweetSpot, variant: 'mini' });
    expect(markup).toContain('data-zoned="false"');
    expect(markup).toContain('var(--wc-neutral)');
    expect(markup).toContain('Set your FTP to see the zones');
    expect(html({ workout: sweetSpot, variant: 'mini' }, 'de')).toContain('FTP eintragen');
  });

  it('colours by zone with an FTP', () => {
    const markup = html({ workout: sweetSpot, athlete: { ftp: 250 }, variant: 'mini' });
    expect(markup).toContain('data-zoned="true"');
    expect(markup).not.toContain('var(--wc-neutral)');
    expect(markup).not.toContain('Set your FTP');
  });

  it('hatches a free ride', () => {
    const free: Workout = {
      ...sweetSpot,
      steps: [{ kind: 'interval', id: 'f', duration: { kind: 'time', seconds: 600 }, effort: { kind: 'free' } }],
    };
    expect(html({ workout: free, athlete: { ftp: 250 }, variant: 'mini' })).toContain('data-marker="free"');
  });
});

describe('the full chart', () => {
  const markup = html({ workout: sweetSpot, athlete: { ftp: 250 }, variant: 'full' });

  it('makes every step focusable by roving tab index, the first one the entry', () => {
    expect(markup.match(/data-testid="workout-chart-step"/g)).toHaveLength(8);
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(7);
  });

  it('has axes, a bracket "3×", a zone bar and the FTP line', () => {
    expect(markup).toContain('workout-chart-bracket');
    expect(markup).toContain('>3×<');
    expect(markup).toContain('workout-chart-zone-bar');
    expect(markup).toContain('100 %');
    expect(markup).toContain('250 W');
    expect(markup).toContain('workout-chart-ftp-line');
  });

  it('names each step by its words for a screen reader', () => {
    expect(markup).toContain('aria-label="Warm-up, 12 min, 50–75 % FTP · 125–188 W"');
  });

  it('draws edit and hud as full until their phases', () => {
    expect(html({ workout: sweetSpot, variant: 'hud' })).toContain('data-variant="full"');
  });
});

describe('the edit chart', () => {
  const editable = (selectedStep?: string, changes = true) =>
    renderToStaticMarkup(
      createElement(Chart, {
        input: {
          workout: sweetSpot,
          athlete: { ftp: 250 },
          variant: 'edit',
          ...(selectedStep ? { selectedStep } : {}),
        },
        text: messages.en,
        onStepFocused: () => {},
        ...(changes ? { onStepChanged: () => {} } : {}),
      }),
    );

  it('is drawn as its own variant, like the full chart with axes and brackets', () => {
    const markup = editable();
    expect(markup).toContain('data-variant="edit"');
    expect(markup).toContain('workout-chart-bracket');
    expect(markup).toContain('workout-chart-zone-bar');
  });

  it('shows handles on the selected step only', () => {
    expect(editable()).not.toContain('workout-chart-handle');
    const markup = editable('warm');
    // A ramp: its end by time and the top at both ends.
    expect(markup.match(/data-handle="duration"/g)).toHaveLength(1);
    expect(markup).toContain('data-handle="power-start"');
    expect(markup).toContain('data-handle="power-end"');
  });

  it('shows a handle for each round of a repeated step', () => {
    expect(editable('on').match(/data-handle="duration"/g)).toHaveLength(3);
  });

  it('shows none when nobody listens for changes', () => {
    expect(editable('warm', false)).not.toContain('workout-chart-handle');
  });
});

describe('the layout cache', () => {
  it('answers equal content with one layout, whichever object carries it', () => {
    const copy = JSON.parse(JSON.stringify(sweetSpot)) as Workout;
    expect(cachedLayout({ workout: copy, athlete: { ftp: 250 } }, 'micro')).toBe(
      cachedLayout({ workout: sweetSpot, athlete: { ftp: 250 } }, 'micro'),
    );
  });
});
