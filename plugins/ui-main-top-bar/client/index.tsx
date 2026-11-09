// SPDX-License-Identifier: AGPL-3.0-or-later

import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { greetingAt, msUntilNextHour } from './greeting.ts';
import { messages } from './i18n/index.ts';

const CSS = `
.tb-bar { display: flex; flex-direction: column; gap: 14px; }
.tb-greeting { margin: 0; color: var(--ridrs-text, #f2f5fa); font: 800 40px/1.1 system-ui, sans-serif;
  text-box: trim-both cap alphabetic; }
.tb-sub { margin: 0; color: var(--ridrs-text-muted, #93a1b8); font-size: 20px; }
`;

/**
 * The greeting of the rider by the local time of day. Rendering only: the wall clock decides
 * nothing in a ride (AGENTS.md rule 7 is about simulation code).
 */
function TopBarView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setTimeout(() => setNow(new Date()), msUntilNextHour(now));
    return () => clearTimeout(timer);
  }, [now]);

  return (
    <div className="tb-bar">
      <style>{CSS}</style>
      <h1 className="tb-greeting">{text.greeting[greetingAt(now.getHours())]}</h1>
      <p className="tb-sub">{text.question}</p>
    </div>
  );
}

export const TopBar: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<TopBarView ctx={ctx} />);
  return () => root.unmount();
};
