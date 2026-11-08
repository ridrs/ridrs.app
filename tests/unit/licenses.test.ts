// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { licenseData } from '../../plugins/ui-settings/client/licenses.generated.ts';
import { parseNotice } from '../../scripts/licenses.ts';

const ROOT = join(import.meta.dirname, '../..');
const rows = parseNotice(readFileSync(join(ROOT, 'NOTICE'), 'utf8'));
const dependencies = rows.filter((row) => row.kind === 'dependency');
const content = rows.filter((row) => row.kind === 'content');

describe('parseNotice', () => {
  it('reads the tables and the MPL-2.0 paragraph', () => {
    const names = dependencies.map((row) => row.name);
    expect(names).toContain('rxjs');
    expect(names).toContain('react / react-dom');
    expect(names).toContain('lightningcss');
    expect(names.filter((name) => name.includes('-|-'))).toEqual([]);
    expect(new Set(names).size).toBe(names.length);
    const rxjs = dependencies.find((row) => row.name === 'rxjs');
    expect(rxjs).toMatchObject({ version: '7.8.2', license: 'Apache-2.0' });
    expect(content[0]).toMatchObject({
      author: 'Fred Van Gestel',
      license: 'CC-BY-NC-SA-4.0',
    });
  });
});

describe('the generated licenses (run `pnpm generate:licenses` after NOTICE changes)', () => {
  it('lists every dependency row of NOTICE with its license and a text', () => {
    for (const row of dependencies) {
      const shown = licenseData.components.find((component) => component.name === row.name);
      expect(shown, `${row.name} is not in the generated licenses`).toBeDefined();
      expect(shown?.license).toBe(row.license);
      if (row.version) expect(shown?.version).toBe(row.version);
      expect(shown?.purpose).toBe(row.purpose);
      expect(shown?.texts.length, `${row.name} has no license text`).toBeGreaterThan(0);
      for (const key of shown?.texts ?? []) {
        expect(licenseData.texts[key]?.trim(), `${row.name}: text ${key}`).toBeTruthy();
      }
    }
  });

  it('credits every content folder of NOTICE', () => {
    for (const row of content) {
      const shown = licenseData.content.find((item) => item.name === row.name);
      expect(shown, `${row.name} is not credited`).toBeDefined();
      expect(shown).toMatchObject({ author: row.author, license: row.license });
      expect(shown?.texts.length).toBeGreaterThan(0);
    }
  });

  it('lists nothing that NOTICE does not', () => {
    expect(licenseData.components.map((c) => c.name)).toEqual(dependencies.map((r) => r.name));
    expect(licenseData.content.map((c) => c.name)).toEqual(content.map((r) => r.name));
  });

  it('holds the version of the root package and the AGPL text', () => {
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(licenseData.appVersion).toBe(version);
    expect(licenseData.texts[licenseData.appText]).toBe(
      readFileSync(join(ROOT, 'LICENSES/AGPL-3.0-or-later.txt'), 'utf8')
        .replace(/\r\n/g, '\n')
        .trimEnd(),
    );
  });
});
