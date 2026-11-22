// SPDX-License-Identifier: AGPL-3.0-or-later

import { activityStateChangedEvent, rideScreenshotService } from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { messages } from './i18n/index.ts';

const CAMERA = new URL('./assets/icons/camera.svg', import.meta.url).href;

/** How long the button says whether the screenshot was saved. */
const STATUS_MS = 2500;

type Status = 'saved' | 'failed';

/**
 * Screenshot, a round control of the activity screen next to ERG (`activity/control`, after it),
 * drawn like Pause and Finish ride: a round glass with a light edge and a camera. Enter or a
 * click asks the app for a screenshot of the ride (`ride.screenshot`, ADR 0102); a press while
 * one is taken is ignored, so two never pick the same number. It then says briefly whether the
 * screenshot was saved. The ride goes on either way.
 */
function ScreenshotButtonView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const startedAt = useRef<number>(undefined);
  const busy = useRef(false);
  const [status, setStatus] = useState<Status>();

  // At commit, not after paint: the button may be pressed before passive effects ran.
  useLayoutEffect(
    () =>
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
        startedAt.current = payload.state === 'idle' ? undefined : payload.startedAt;
      }),
    [ctx],
  );

  useEffect(() => {
    if (status === undefined) return undefined;
    const timer = setTimeout(() => setStatus(undefined), STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const onPress = async () => {
    if (busy.current || startedAt.current === undefined) return;
    busy.current = true;
    setStatus(undefined);
    try {
      const { file } = await ctx.call(rideScreenshotService, { startedAt: startedAt.current });
      ctx.logger.info('Screenshot saved', file);
      setStatus('saved');
    } catch (error) {
      ctx.logger.warn('Screenshot failed', error);
      setStatus('failed');
    } finally {
      busy.current = false;
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        aria-label={text.screenshot}
        title={text.screenshot}
        data-testid="ride-screenshot"
        onClick={() => void onPress()}
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          padding: 0,
          border: 0,
          background: 'var(--ridrs-card-quiet)',
          boxShadow: 'var(--ridrs-edge), var(--ridrs-shadow)',
          color: 'var(--ridrs-text)',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden="true"
          style={
            {
              width: 24,
              height: 24,
              background: 'currentColor',
              mask: `url("${CAMERA}") center / contain no-repeat`,
              WebkitMask: `url("${CAMERA}") center / contain no-repeat`,
            } as CSSProperties
          }
        />
      </button>
      <div
        role="status"
        data-testid="ride-screenshot-status"
        style={{
          position: 'absolute',
          bottom: 56 + 12,
          right: 0,
          padding: '6px 12px',
          borderRadius: 'var(--ridrs-radius-lg)',
          background: 'var(--ridrs-card)',
          boxShadow: 'var(--ridrs-edge), var(--ridrs-shadow)',
          color: status === 'failed' ? 'var(--ridrs-danger)' : 'var(--ridrs-text)',
          fontFamily: 'var(--ridrs-font-text)',
          fontSize: 'var(--ridrs-size-label)',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          visibility: status === undefined ? 'hidden' : 'visible',
        }}
      >
        {status === 'saved' ? text.saved : status === 'failed' ? text.failed : ''}
      </div>
    </div>
  );
}

export const ScreenshotButton: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<ScreenshotButtonView ctx={ctx} />);
  return () => root.unmount();
};
