// SPDX-License-Identifier: AGPL-3.0-or-later

import type { UiComponent } from '@ridrs/ui-sdk';
import { createRoot } from 'react-dom/client';

/** A deliberately flat backdrop: sky, ground and a road to the horizon. */
function FlatLandscapeView() {
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
      <polygon points="49.7,58 50.3,58 51.5,100 48.5,100" fill="#f2f2f2" />
    </svg>
  );
}

export const FlatLandscape: UiComponent = (container) => {
  const root = createRoot(container);
  root.render(<FlatLandscapeView />);
  return () => root.unmount();
};
