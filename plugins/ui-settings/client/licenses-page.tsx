// SPDX-License-Identifier: AGPL-3.0-or-later

import { PREVIEW_CSS } from '@ridrs/ui-preview';
import { useEffect, useState } from 'react';
import type { LicenseData } from './licenses.ts';

const STYLE = `
.lic-entry { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; width: 100%; text-align: left; }
.lic-entry .lic-meta { opacity: 0.75; }
.lic-entry .lic-purpose { flex-basis: 100%; opacity: 0.75; font-size: 0.9em; }
.lic-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.lic-block { margin: 0 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, monospace; font-size: 0.85em; }
.lic-block:focus { outline: 2px solid currentColor; outline-offset: 2px; }
`;

/** The license data, loaded when the page opens: it is large and only this page needs it. */
export function useLicenseData(): LicenseData | undefined {
  const [data, setData] = useState<LicenseData>();
  useEffect(() => {
    let current = true;
    void import('./licenses.generated.ts').then((module) => {
      if (current) setData(module.licenseData);
    });
    return () => {
      current = false;
    };
  }, []);
  return data;
}

/** What the page shows the text of: the app itself, or a component by its NOTICE name. */
export type Chosen = { readonly name: string };

export interface LicensesText {
  readonly licensesAndCredits: string;
  readonly licensesIntro: string;
  readonly loading: string;
  readonly back: string;
  readonly appEntry: string;
  readonly appName: string;
  readonly contentSection: string;
  readonly componentsSection: string;
  readonly contentBy: (author: string) => string;
  readonly licenseName: (license: string) => string;
}

/** A license text in blocks the arrows step through (and scroll with), one paragraph each. */
function LicenseText({ texts, data }: { readonly texts: readonly string[]; readonly data: LicenseData }) {
  return (
    <div data-license-text>
      {texts.flatMap((key, index) =>
        (data.texts[key] ?? '')
          .split(/\n\s*\n/)
          .map((block, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed text, never reordered
            <p key={`${index}-${at}`} className="lic-block" tabIndex={0}>
              {block.replace(/^\n+/, '')}
            </p>
          )),
      )}
    </div>
  );
}

export function LicensesPage({
  text,
  chosen,
  onChoose,
  onBack,
}: {
  readonly text: LicensesText;
  readonly chosen: Chosen | undefined;
  readonly onChoose: (chosen: Chosen) => void;
  readonly onBack: () => void;
}) {
  const data = useLicenseData();
  const heading = (title: string) => (
    <header className="pv-title">
      <h1>{title}</h1>
    </header>
  );
  const back = (
    <button type="button" className="pv-button" onClick={onBack}>
      {text.back}
    </button>
  );
  if (!data) {
    return (
      <div className="pv-page">
        <style>{PREVIEW_CSS}</style>
        {heading(text.licensesAndCredits)}
        <p className="pv-muted">{text.loading}</p>
      </div>
    );
  }
  if (chosen) {
    const isApp = chosen.name === data.appName;
    const component = data.components.find((c) => c.name === chosen.name);
    const texts = isApp ? [data.appText] : (component?.texts ?? []);
    return (
      <div className="pv-page">
        <style>{PREVIEW_CSS}</style>
        <style>{STYLE}</style>
        {heading(isApp ? text.appName : chosen.name)}
        <div className="pv-row">{back}</div>
        <p className="pv-muted">
          {text.licenseName(isApp ? data.appLicense : (component?.license ?? ''))}
          {component?.version ? ` · ${component.version}` : isApp ? ` · ${data.appVersion}` : ''}
        </p>
        <LicenseText texts={texts} data={data} />
      </div>
    );
  }
  return (
    <div className="pv-page">
      <style>{PREVIEW_CSS}</style>
      <style>{STYLE}</style>
      {heading(text.licensesAndCredits)}
      <p className="pv-muted">{text.licensesIntro}</p>
      <div className="pv-row">{back}</div>
      <section className="pv-section">
        <h2>{text.appName}</h2>
        <button
          type="button"
          className="pv-button"
          data-license-entry={data.appName}
          onClick={() => onChoose({ name: data.appName })}
        >
          {text.appEntry}
        </button>
      </section>
      <section className="pv-section" data-credits>
        <h2>{text.contentSection}</h2>
        {data.content.map((item) => (
          <div key={item.name}>
            <p>
              <strong>{text.contentBy(item.author)}</strong> · {item.license}
            </p>
            <p className="pv-muted">{item.origin}</p>
            <LicenseText texts={item.texts} data={data} />
          </div>
        ))}
      </section>
      <section className="pv-section">
        <h2>{text.componentsSection}</h2>
        <div className="lic-list">
          {data.components.map((component) => (
            <button
              key={component.name}
              type="button"
              className="pv-button lic-entry"
              data-license-entry={component.name}
              onClick={() => onChoose({ name: component.name })}
            >
              <strong>{component.name}</strong>
              <span className="lic-meta">{component.version}</span>
              <span className="lic-meta">{component.license}</span>
              <span className="lic-purpose">{component.purpose}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
