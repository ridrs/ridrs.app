// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  type AthleteProfile,
  appLanguageSetService,
  athleteProfileState,
  type DataSource,
  DEFAULT_PROVIDER,
  dataSelectService,
  dataSourceState,
  type Language,
} from '@ridrs/contracts';
import { ActionButton, AreaPage, reactComponent, Toggle, useBack, userDocument } from '@ridrs/ui-preview';
import type { UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { appVersion } from './about.generated.ts';
import { messages } from './i18n/index.ts';
import { type Chosen, LicensesPage } from './licenses-page.tsx';

/** Where the source code of ridrs is offered (AGPL-3.0 section 13). */
const SOURCE_CODE_URL = 'https://github.com/ridrs/ridrs.app';

/** From Lucide (ISC, see the folder's LICENSE), painted as a mask in the text colour. */
const SETTINGS = new URL('./assets/icons/settings.svg', import.meta.url).href;

// Not strict: documents kept before ADR 0072 still hold the language, which lives apart now.
const settingsSchema = z.object({
  units: z.enum(['metric', 'imperial']),
  sounds: z.boolean(),
  smoothing: z.enum(['off', '3s', '10s']),
  frameRate: z.boolean(),
});

type Settings = z.infer<typeof settingsSchema>;

const DEFAULTS: Settings = { units: 'metric', sounds: true, smoothing: '3s', frameRate: false };

/** The language the app starts in and goes back to with Reset. */
const DEFAULT_LANGUAGE: Language = 'en';

/**
 * The settings, kept at once (ADR 0059). Placeholders of the early alpha: nothing reads them yet;
 * the HUD keeps its metric units. The language is the app's (ADR 0072): app state of this plugin's
 * host side, changed through `app.set-language`.
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

/** The app's language: each language a button named in its own language, the chosen one pressed. */
function LanguageChoice({ ctx, name }: { readonly ctx: UiContext; readonly name: string }) {
  const language = useLanguage(ctx);
  const choose = (next: Language) =>
    ctx
      .call(appLanguageSetService, { language: next })
      .catch((error: unknown) => ctx.logger.warn(`Could not change the language: ${String(error)}`));
  return (
    <div className="pv-row" role="group" aria-label={name}>
      <span style={{ minWidth: 140 }}>{name}</span>
      {LANGUAGE_NAMES.map((option) => (
        <button
          key={option.value}
          type="button"
          className="pv-chip"
          lang={option.value}
          aria-pressed={language === option.value}
          onClick={() => choose(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Every language by its own name, so that anyone finds theirs. */
const LANGUAGE_NAMES: readonly { readonly value: Language; readonly label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
];

/** The data type of the row (ADR 0073): the athlete profile, chosen among its providers. */
const ATHLETE_PROFILE = 'athlete.profile';

/** Whether a ride is under way: a new source then applies from the next ride. */
function useRiding(ctx: UiContext): boolean {
  const [riding, setRiding] = useState(false);
  useEffect(
    () =>
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) =>
        setRiding(payload.state === 'running' || payload.state === 'paused'),
      ),
    [ctx],
  );
  return riding;
}

/** ridrs first, then the other providers by their id. */
function inOrder(
  providers: ReadonlyMap<string, DataSource<AthleteProfile>>,
): readonly DataSource<AthleteProfile>[] {
  return [...providers.values()].sort(
    (a, b) =>
      Number(b.provider === DEFAULT_PROVIDER) - Number(a.provider === DEFAULT_PROVIDER) ||
      a.provider.localeCompare(b.provider),
  );
}

/**
 * The athlete profile's source: one button per provider that offers it, the chosen one pressed,
 * and the status of the chosen one beside them. A provider chooses its own name, except ridrs on
 * this device, which is named in the app's language.
 */
function AthleteProfileSource({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  const providers = useStateEntries(ctx, athleteProfileState);
  const chosen = useStateEntries(ctx, dataSourceState).get(ATHLETE_PROFILE)?.provider;
  const current = chosen ?? DEFAULT_PROVIDER;
  const status = providers.get(current);
  const choose = (provider: string) =>
    ctx
      .call(dataSelectService, { key: ATHLETE_PROFILE, provider })
      .catch((error: unknown) => ctx.logger.warn(`Could not choose the source: ${String(error)}`));
  return (
    <div className="pv-row" role="group" aria-label={text.athleteProfile}>
      <span style={{ minWidth: 140 }}>{text.athleteProfile}</span>
      {inOrder(providers).map((provider) => (
        <button
          key={provider.provider}
          type="button"
          className="pv-chip"
          aria-pressed={provider.provider === current}
          onClick={() => choose(provider.provider)}
        >
          {provider.provider === DEFAULT_PROVIDER ? text.thisDevice : provider.label}
        </button>
      ))}
      {status ? (
        <span className="pv-muted" role="status">
          {text.status(
            status.status,
            status.fetchedAt === undefined
              ? undefined
              : new Date(status.fetchedAt).toLocaleTimeString(language, {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
          )}
        </span>
      ) : null}
    </div>
  );
}

function SettingsView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const [state, change] = useSettings(ctx);
  const [advanced, setAdvanced] = useState(false);
  // The licenses are a page inside the settings, not a dialog of their own: Back from them lands
  // in the settings (ADR 0073).
  const [licenses, setLicenses] = useState(false);
  const [chosen, setChosen] = useState<Chosen>();
  const riding = useRiding(ctx);
  useBack(ctx, () => {
    if (chosen) {
      setChosen(undefined);
      return true;
    }
    if (licenses) {
      setLicenses(false);
      return true;
    }
    if (!advanced) return false;
    setAdvanced(false);
    return true;
  });
  if (licenses) {
    return (
      <LicensesPage
        text={text}
        chosen={chosen}
        onChoose={setChosen}
        onBack={() => (chosen ? setChosen(undefined) : setLicenses(false))}
      />
    );
  }
  return (
    <AreaPage title={text.title} intro={text.intro}>
      <section className="pv-section">
        <h2>{text.basics}</h2>
        <Choice
          ctx={ctx}
          name={text.units}
          setting="units"
          options={[
            { value: 'metric', label: text.metric },
            { value: 'imperial', label: text.imperial },
          ]}
        />
        <LanguageChoice ctx={ctx} name={text.language} />
        <div className="pv-row">
          <span style={{ minWidth: 140 }}>{text.sounds}</span>
          <Toggle label={text.sounds} on={state.sounds} onChange={(on) => change((s) => ({ ...s, sounds: on }))}>
            {state.sounds ? text.on : text.off}
          </Toggle>
        </div>
      </section>
      <section className="pv-section">
        <h2>{text.dataSources}</h2>
        <AthleteProfileSource ctx={ctx} />
        {riding ? <p className="pv-muted">{text.riding}</p> : null}
      </section>
      <section className="pv-section">
        <div className="pv-row">
          <button
            type="button"
            className="pv-button"
            aria-expanded={advanced}
            onClick={() => setAdvanced((open) => !open)}
          >
            {text.advanced}
          </button>
          <button
            type="button"
            className="pv-button"
            onClick={() => {
              change(() => DEFAULTS);
              ctx
                .call(appLanguageSetService, { language: DEFAULT_LANGUAGE })
                .catch((error: unknown) =>
                  ctx.logger.warn(`Could not change the language: ${String(error)}`),
                );
            }}
          >
            {text.reset}
          </button>
        </div>
        {advanced ? (
          <>
            <Choice
              ctx={ctx}
              name={text.smoothing}
              setting="smoothing"
              options={[
                { value: 'off', label: text.off },
                { value: '3s', label: text.seconds(3) },
                { value: '10s', label: text.seconds(10) },
              ]}
            />
            <div className="pv-row">
              <span style={{ minWidth: 140 }}>{text.frameRate}</span>
              <Toggle
                label={text.showFrameRate}
                on={state.frameRate}
                onChange={(on) => change((s) => ({ ...s, frameRate: on }))}
              >
                {state.frameRate ? text.shown : text.hidden}
              </Toggle>
            </div>
          </>
        ) : null}
      </section>
      <p className="pv-muted">{text.placeholder}</p>
      <section className="pv-section">
        <h2>{text.about}</h2>
        <p>
          <strong>{text.appName}</strong> · {text.version(appVersion)}
        </p>
        <p>{text.licensedUnder}</p>
        <div className="pv-row">
          <a className="pv-button" href={SOURCE_CODE_URL} target="_blank" rel="noopener noreferrer">
            {text.sourceCode}
          </a>
          <button type="button" className="pv-button" onClick={() => setLicenses(true)}>
            {text.licensesAndCredits}
          </button>
        </div>
      </section>
    </AreaPage>
  );
}

export const SettingsScreen = reactComponent((ctx) => <SettingsView ctx={ctx} />);
function SettingsActionView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  return <ActionButton ctx={ctx} screen="settings" label={text.title} icon={SETTINGS} />;
}

export const SettingsAction = reactComponent((ctx) => <SettingsActionView ctx={ctx} />);
