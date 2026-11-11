// SPDX-License-Identifier: AGPL-3.0-or-later

// Hand-written client module (no build): draws one `ui.test-badge` with its own fallback, and
// offers buttons that update it, break its input or render an undeclared capability.
import { defineUiCapability } from '@ridrs/contracts';
import { z } from 'zod';

const badgeCapability = defineUiCapability('ui.test-badge', {
  input: z.object({ label: z.string(), tone: z.enum(['calm', 'loud']) }).strict(),
  output: { picked: z.object({ label: z.string() }).strict() },
});
const undeclaredCapability = defineUiCapability('ui.test-undeclared', { input: z.object({}) });

export function BadgeHost(container, ctx) {
  const place = document.createElement('div');
  place.dataset.testid = 'badge-place';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Waiting';
  const button = (label, onClick) => {
    const element = document.createElement('button');
    element.textContent = label;
    element.addEventListener('click', () => {
      try {
        onClick();
      } catch (error) {
        status.textContent = error.code;
      }
    });
    return element;
  };

  const badge = ctx.render(badgeCapability, place, { label: 'Hello', tone: 'calm' });
  badge.onAvailability((available) => {
    place.dataset.available = String(available);
    if (!available) {
      place.textContent = 'No badge here';
    }
  });
  badge.on('picked', ({ label }) => {
    status.textContent = `Picked ${label}`;
  });

  container.append(
    place,
    status,
    button('Make the badge loud', () => badge.update({ label: 'Hello', tone: 'loud' })),
    button('Send a broken badge', () => badge.update({ label: 7, tone: 'calm' })),
    button('Render a broken badge', () =>
      ctx.render(badgeCapability, document.createElement('div'), { label: 'Hello' }),
    ),
    button('Render an undeclared badge', () =>
      ctx.render(undeclaredCapability, document.createElement('div'), {}),
    ),
    button('Go elsewhere', () => ctx.navigate('elsewhere')),
  );
}

export function Elsewhere(container) {
  const text = document.createElement('p');
  text.textContent = 'Somewhere else';
  container.append(text);
}
