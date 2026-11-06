// SPDX-License-Identifier: AGPL-3.0-or-later

import { ActionButton, AreaPage, reactComponent, Toggle, useBack, userDocument } from '@ridrs/ui-preview';
import type { UiContext } from '@ridrs/ui-sdk';
import { useState } from 'react';
import { z } from 'zod';

/** From Lucide (ISC, see the folder's LICENSE), painted as a mask in the text colour. */
const SETTINGS = new URL('./assets/icons/settings.svg', import.meta.url).href;

const settingsSchema = z
  .object({
    units: z.enum(['metric', 'imperial']),
    language: z.enum(['en', 'de']),
    sounds: z.boolean(),
    smoothing: z.enum(['off', '3s', '10s']),
    frameRate: z.boolean(),
  })
  .strict();

type Settings = z.infer<typeof settingsSchema>;

const DEFAULTS: Settings = { units: 'metric', language: 'en', sounds: true, smoothing: '3s', frameRate: false };

/**
 * The settings, kept at once (ADR 0059). Placeholders of the early alpha: nothing reads them yet;
 * the HUD keeps its metric units and English.
 */
const useSettings = userDocument({ name: 'preview', version: 1, schema: settingsSchema }, DEFAULTS);

/** One choice of a few: each option a button, the chosen one pressed. */
function Choice<K extends keyof Settings>({
  ctx,
  name,
  setting,
  options,
}: {
  readonly ctx: UiContext;
  readonly name: string;
  readonly setting: K;
  readonly options: readonly { readonly value: Settings[K]; readonly label: string }[];
}) {
  const [state, change] = useSettings(ctx);
  return (
    <div className="pv-row" role="group" aria-label={name}>
      <span style={{ minWidth: 140 }}>{name}</span>
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          className="pv-chip"
          aria-pressed={state[setting] === option.value}
          onClick={() => change((s) => ({ ...s, [setting]: option.value }))}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SettingsView({ ctx }: { readonly ctx: UiContext }) {
  const [state, change] = useSettings(ctx);
  const [advanced, setAdvanced] = useState(false);
  useBack(ctx, () => {
    if (!advanced) return false;
    setAdvanced(false);
    return true;
  });
  return (
    <AreaPage title="Settings" intro="Every change takes effect at once.">
      <section className="pv-section">
        <h2>Basics</h2>
        <Choice
          ctx={ctx}
          name="Units"
          setting="units"
          options={[
            { value: 'metric', label: 'Metric' },
            { value: 'imperial', label: 'Imperial' },
          ]}
        />
        <Choice
          ctx={ctx}
          name="Language"
          setting="language"
          options={[
            { value: 'en', label: 'English' },
            { value: 'de', label: 'Deutsch' },
          ]}
        />
        <div className="pv-row">
          <span style={{ minWidth: 140 }}>Sounds</span>
          <Toggle label="Sounds" on={state.sounds} onChange={(on) => change((s) => ({ ...s, sounds: on }))}>
            {state.sounds ? 'On' : 'Off'}
          </Toggle>
        </div>
      </section>
      <section className="pv-section">
        <div className="pv-row">
          <button
            type="button"
            className="pv-button"
            aria-expanded={advanced}
            onClick={() => setAdvanced((open) => !open)}
          >
            Advanced
          </button>
          <button type="button" className="pv-button" onClick={() => change(() => DEFAULTS)}>
            Reset to defaults
          </button>
        </div>
        {advanced ? (
          <>
            <Choice
              ctx={ctx}
              name="Power smoothing"
              setting="smoothing"
              options={[
                { value: 'off', label: 'Off' },
                { value: '3s', label: '3 s' },
                { value: '10s', label: '10 s' },
              ]}
            />
            <div className="pv-row">
              <span style={{ minWidth: 140 }}>Frame rate</span>
              <Toggle
                label="Show the frame rate"
                on={state.frameRate}
                onChange={(on) => change((s) => ({ ...s, frameRate: on }))}
              >
                {state.frameRate ? 'Shown' : 'Hidden'}
              </Toggle>
            </div>
          </>
        ) : null}
      </section>
      <p className="pv-muted">Nothing reads these settings yet; the ride keeps metric units and English.</p>
    </AreaPage>
  );
}

export const SettingsScreen = reactComponent((ctx) => <SettingsView ctx={ctx} />);
export const SettingsAction = reactComponent((ctx) => (
  <ActionButton ctx={ctx} screen="settings" label="Settings" icon={SETTINGS} />
));
