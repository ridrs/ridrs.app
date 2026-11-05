// SPDX-License-Identifier: AGPL-3.0-or-later

import { createTauriIpc, TauriBleCentral } from '@ridrs/ble-tauri';
import type { BleCentral } from '@ridrs/contracts';
import { keyboardNavigation } from '@ridrs/ui-shell';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { suppressBrowserChrome } from './browser-chrome.ts';
import { startCompanion } from './companion.ts';
import { CompanionScreen } from './companion-screen.tsx';
import {
  companionName,
  createCompanionIpc,
  ensureBluetoothPermission,
  keepScreenOn,
  secretPairingStore,
} from './platform.ts';

async function main(): Promise<void> {
  const root = document.getElementById('companion');
  if (!root) {
    throw new Error('Missing #companion root element');
  }
  suppressBrowserChrome(document.documentElement, { allowInspect: import.meta.env.DEV });
  // One screen, so nothing to go back to: the arrow keys and Enter only (AGENTS.md rule 12).
  keyboardNavigation(root);
  keepScreenOn();
  const granted = await ensureBluetoothPermission().catch(() => false);
  if (!granted) {
    console.warn('Bluetooth permission not granted; only dummy devices can be forwarded');
  }

  let central: BleCentral = new TauriBleCentral(createTauriIpc());
  let dummyPanel: ReactNode | undefined;
  // Replaced at build time: release builds drop this branch and the simulator with it.
  if (import.meta.env.VITE_DUMMY_DEVICES === 'true') {
    const dummy = await import('./dummy-panel.tsx');
    const setup = dummy.withDummyDevices(central);
    central = setup.central;
    dummyPanel = <dummy.DummyPanel dummies={setup.dummies} />;
  }

  const companion = await startCompanion({
    ipc: createCompanionIpc(),
    central,
    name: companionName(),
    pairingStore: await secretPairingStore(),
  });
  window.addEventListener('pagehide', () => {
    void companion.stop();
  });
  createRoot(root).render(<CompanionScreen companion={companion} dummyPanel={dummyPanel} />);
}

main().catch((error: unknown) => {
  console.error('ridrs companion failed to start', error);
  const root = document.getElementById('companion');
  if (root) {
    root.textContent = `The companion could not start: ${String(error)}`;
  }
});
