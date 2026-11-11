// SPDX-License-Identifier: AGPL-3.0-or-later

// Hand-written client module (no build): a screen (opened from the menu) that draws the `full` variant of
// `ui.workout-chart` for a sweet spot workout (65 minutes, 3 × 12 minutes at 90 %), with its own
// fallback text, and buttons that take the athlete's FTP away and give it back.
import { workoutChartCapability } from '@ridrs/contracts';

const interval = (id, intensity, seconds, percent) => ({
  kind: 'interval',
  id,
  intensity,
  duration: { kind: 'time', seconds },
  effort: {
    kind: 'target',
    primary: { unit: 'percent-ftp', start: { low: percent, high: percent } },
  },
});

const workout = {
  format: 'ridrs-workout',
  version: 1,
  id: 'sweet-spot',
  name: 'Sweet Spot 3x12',
  sport: 'ride',
  source: { kind: 'user' },
  steps: [
    {
      kind: 'interval',
      id: 'warm',
      intensity: 'warm-up',
      duration: { kind: 'time', seconds: 720 },
      effort: {
        kind: 'target',
        primary: { unit: 'percent-ftp', start: { low: 50, high: 50 }, end: { low: 75, high: 75 } },
      },
    },
    {
      kind: 'repeat',
      id: 'main',
      until: { kind: 'count', reps: 3 },
      steps: [interval('on', 'interval', 720, 90), interval('off', 'rest', 240, 55)],
    },
    interval('cool', 'cool-down', 300, 60),
  ],
};

export function ChartEntry(container, ctx) {
  const entry = document.createElement('button');
  entry.type = 'button';
  entry.dataset.menuItem = '';
  entry.textContent = 'Chart fixture';
  entry.addEventListener('click', () => ctx.navigate('chart-fixture'));
  container.append(entry);
}

export function ChartScreen(container, ctx) {
  const place = document.createElement('div');
  place.dataset.testid = 'chart-place';
  const fallback = document.createElement('p');
  fallback.dataset.testid = 'chart-fallback';
  fallback.textContent = '65 min · TSS 72';
  const focused = document.createElement('p');
  focused.setAttribute('role', 'status');
  focused.dataset.testid = 'chart-focused';
  focused.textContent = 'Nothing focused';
  const button = (label, onClick) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', onClick);
    return element;
  };

  const chart = ctx.render(workoutChartCapability, place, {
    workout,
    athlete: { ftp: 250 },
    variant: 'full',
  });
  chart.onAvailability((available) => {
    place.dataset.available = String(available);
    fallback.hidden = available;
  });
  chart.on('step-focused', ({ stepId }) => {
    focused.textContent = `Focused ${stepId}`;
  });
  container.append(
    place,
    fallback,
    focused,
    button('Remove the FTP', () => chart.update({ workout, variant: 'full' })),
    button('Give an FTP', () => chart.update({ workout, athlete: { ftp: 250 }, variant: 'full' })),
  );
}
