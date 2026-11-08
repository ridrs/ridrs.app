// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLicenseData, type LicenseData, renderAbout, renderModule } from './licenses.ts';

/** Where the licenses screen of the settings plugin finds its data (ADR 0073). */
export const GENERATED = 'plugins/ui-settings/client/licenses.generated.ts';

export const ABOUT = 'plugins/ui-settings/client/about.generated.ts';

const root = join(import.meta.dirname, '..');
const target = join(root, GENERATED);
// What was generated before stands in for the Rust sources on a machine without a Cargo registry.
const previous = existsSync(target)
  ? ((await import(pathToFileURL(target).href)) as { licenseData: LicenseData }).licenseData
  : undefined;
const data = buildLicenseData({ root, ...(previous ? { previous } : {}) });
writeFileSync(target, renderModule(data));
writeFileSync(join(root, ABOUT), renderAbout(data));
console.log(
  `${GENERATED}: ${data.components.length} components, ${data.content.length} content folders`,
);
