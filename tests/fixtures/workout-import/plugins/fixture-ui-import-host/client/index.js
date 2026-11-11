// SPDX-License-Identifier: AGPL-3.0-or-later

// Hand-written client module (no build): a page with the button the Training area will have. It
// opens the import screen by navigation, as any plugin does.
export function ImportHost(container, ctx) {
  const button = document.createElement('button');
  button.textContent = 'Open the workout import';
  button.addEventListener('click', () => ctx.navigate('workout-import'));
  container.append(button);
}
