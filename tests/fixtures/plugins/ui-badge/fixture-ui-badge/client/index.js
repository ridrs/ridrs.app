// SPDX-License-Identifier: AGPL-3.0-or-later

// Hand-written client module (no build): provides `ui.test-badge`. It counts its mounts,
// updates and releases where the scenario steps can read them.
const LOG = Symbol.for('ridrs.fixture.ui-badge');

const log = () => {
  globalThis[LOG] ??= { mounts: 0, updates: 0, releases: 0 };
  return globalThis[LOG];
};

export function Badge(container, _ctx, input, emit) {
  log().mounts += 1;
  let current = input;
  const badge = document.createElement('span');
  badge.dataset.testid = 'test-badge';
  const status = document.createElement('p');
  status.dataset.testid = 'test-badge-status';
  const pick = document.createElement('button');
  pick.textContent = 'Pick the badge';
  pick.addEventListener('click', () => emit('picked', { label: current.label }));
  const wrong = document.createElement('button');
  wrong.textContent = 'Pick the badge wrongly';
  wrong.addEventListener('click', () => {
    try {
      emit('picked', { label: 42 });
    } catch (error) {
      status.textContent = error.code;
    }
  });
  const draw = () => {
    badge.textContent = `${current.label} (${current.tone})`;
  };
  draw();
  container.append(badge, pick, wrong, status);
  return {
    update(next) {
      log().updates += 1;
      current = next;
      draw();
    },
    release() {
      log().releases += 1;
    },
  };
}
