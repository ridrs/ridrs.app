// SPDX-License-Identifier: AGPL-3.0-or-later

import type { UiComponent } from '@ridrs/ui-sdk';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { greetingAt, msUntilNextHour } from './greeting.ts';

const CSS = `
.tb-bar { display: flex; flex-direction: column; gap: 4px; }
.tb-greeting { margin: 0; color: var(--ridrs-text, #f2f5fa); font: 800 40px/1.1 system-ui, sans-serif; }
.tb-sub { margin: 0; color: var(--ridrs-text-muted, #93a1b8); font-size: 20px; }
`;

/**
 * The greeting of the rider by the local time of day. Rendering only: the wall clock decides
 * nothing in a ride (AGENTS.md rule 7 is about simulation code).
 */
function TopBarView() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setTimeout(() => setNow(new Date()), msUntilNextHour(now));
    return () => clearTimeout(timer);
  }, [now]);

  return (
    <div className="tb-bar">
      <style>{CSS}</style>
      <h1 className="tb-greeting">{greetingAt(now.getHours())}</h1>
      <p className="tb-sub">Ready for your next ride?</p>
    </div>
  );
}

export const TopBar: UiComponent = (container) => {
  const root = createRoot(container);
  root.render(<TopBarView />);
  return () => root.unmount();
};
