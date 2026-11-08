// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  LicenseComponent,
  LicenseContent,
  LicenseData,
} from '../plugins/ui-settings/client/licenses.ts';

/** One row of NOTICE: a third-party component, or a folder of third-party content. */
export interface NoticeRow {
  readonly kind: 'dependency' | 'content';
  /** The first column as shown, without the code marks. */
  readonly name: string;
  /** The package or crate ids in it (every code mark; else the names split at " / "). */
  readonly ids: readonly string[];
  readonly version: string;
  /** The SPDX expression. */
  readonly license: string;
  /** The purpose column; for content its author and origin. */
  readonly purpose: string;
  readonly author?: string;
  readonly origin?: string;
  /** The license column's remark in brackets. */
  readonly note?: string;
}

const codeMarks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|\s*/, '')
    .replace(/\s*\|$/, '')
    .split(/\s+\|\s+/);
}

/** The tables of NOTICE and its MPL-2.0 paragraph, in file order. */
export function parseNotice(notice: string): NoticeRow[] {
  const rows: NoticeRow[] = [];
  let table: 'dependency' | 'content' | undefined;
  for (const line of notice.split('\n')) {
    if (!line.startsWith('|')) {
      table = undefined;
      if (line.startsWith('MPL-2.0 components')) {
        for (const id of codeMarks(line).filter((mark) => /^[a-z0-9][a-z0-9-]*$/.test(mark))) {
          rows.push({
            kind: 'dependency',
            name: id,
            ids: [id],
            version: '',
            license: 'MPL-2.0',
            purpose: 'MPL-2.0 component approved by the maintainer; pulled in by Tauri or Vite',
          });
        }
      }
      continue;
    }
    const columns = cells(line);
    const first = columns[0] ?? '';
    if (/^[-|\s]+$/.test(line)) continue;
    if (/^(Package|Crate)$/.test(first)) {
      table = 'dependency';
      continue;
    }
    if (first === 'Folder') {
      table = 'content';
      continue;
    }
    if (table === 'dependency') {
      const [name = '', version = '', license = '', purpose = ''] = columns;
      const marks = codeMarks(name);
      rows.push({
        kind: 'dependency',
        name: name.replaceAll('`', ''),
        ids: marks.length ? marks : name.split(' / '),
        version,
        license,
        purpose: purpose.replaceAll('`', ''),
      });
    } else if (table === 'content') {
      const [folder = '', author = '', origin = '', license = ''] = columns;
      const [spdx = '', ...note] = license.split(' (');
      rows.push({
        kind: 'content',
        name: folder.replaceAll('`', ''),
        ids: [folder.replaceAll('`', '')],
        version: '',
        license: spdx,
        purpose: `${author}, ${origin}`,
        author,
        origin,
        ...(note.length ? { note: note.join(' (').replace(/\)$/, '') } : {}),
      });
    }
  }
  return rows;
}

const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)/i;

function licenseFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => LICENSE_FILE.test(file) && statSync(join(dir, file)).isFile())
    .sort()
    .map((file) => join(dir, file));
}

/** Texts the repository keeps for a component itself, apart from the package's own. */
const REPO_FILES: Readonly<Record<string, readonly string[]>> = {
  'lucide-static': ['plugins/ui-devices/client/assets/icons/LICENSE'],
  'tauri-plugin-blec': [
    'crates/vendor/tauri-plugin-blec/LICENSE_APACHE',
    'crates/vendor/tauri-plugin-blec/LICENSE_MIT',
  ],
};

export interface Sources {
  readonly root: string;
  /** The directory with `registry/src/*` of Cargo; absent on a machine without Rust. */
  readonly cargoHome?: string;
  /** The data generated before: used for a component whose sources this machine lacks. */
  readonly previous?: LicenseData;
}

function slug(id: string): string {
  return (id.split('/').pop() ?? id).toLowerCase();
}

function repoKept(id: string, root: string): string[] {
  const direct = (REPO_FILES[slug(id)] ?? []).map((file) => join(root, file));
  if (direct.length) return direct;
  // Any `plugins/*/licenses/<id>…` file (e.g. the fonts' OFL texts).
  const found: string[] = [];
  const plugins = join(root, 'plugins');
  if (!existsSync(plugins)) return found;
  for (const plugin of readdirSync(plugins)) {
    const folder = join(plugins, plugin, 'licenses');
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder).sort()) {
      if (file.toLowerCase().startsWith(slug(id))) found.push(join(folder, file));
    }
  }
  return found;
}

function npmDir(id: string, version: string, root: string): string | undefined {
  const store = join(root, 'node_modules/.pnpm');
  if (existsSync(store)) {
    const prefix = `${id.replace('/', '+')}@`;
    const candidates = readdirSync(store).filter((dir) => dir.startsWith(prefix));
    const exact = candidates.find((dir) => dir === `${prefix}${version}` || dir.startsWith(`${prefix}${version}_`));
    const dir = exact ?? candidates.sort().at(-1);
    if (dir && existsSync(join(store, dir, 'node_modules', id))) {
      return join(store, dir, 'node_modules', id);
    }
  }
  const direct = join(root, 'node_modules', id);
  return existsSync(direct) ? direct : undefined;
}

function cargoDir(id: string, version: string, cargoHome: string | undefined): string | undefined {
  const registry = join(cargoHome ?? join(homedir(), '.cargo'), 'registry/src');
  if (!existsSync(registry)) return undefined;
  for (const index of readdirSync(registry)) {
    const dir = join(registry, index, `${id}-${version}`);
    if (existsSync(dir)) return dir;
  }
  return undefined;
}

/** The newest version of a crate in a `Cargo.lock`. */
function lockedVersion(lock: string, id: string): string {
  const versions = [...lock.matchAll(new RegExp(`name = "${id}"\\nversion = "([^"]+)"`, 'g'))].map(
    (m) => m[1] ?? '',
  );
  return versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) ?? '';
}

const read = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd();

/** Distinct texts of a component, by the order of preference above; empty if none is found. */
function textsFor(row: NoticeRow, versions: readonly string[], sources: Sources): string[] {
  const found: string[] = [];
  for (const [index, id] of row.ids.entries()) {
    const version = versions.length === row.ids.length ? (versions[index] ?? '') : (versions[0] ?? '');
    const files = repoKept(id, sources.root);
    if (!files.length) {
      files.push(...licenseFilesIn(npmDir(id, version, sources.root) ?? ''));
    }
    if (!files.length) {
      files.push(...licenseFilesIn(cargoDir(id, version, sources.cargoHome) ?? ''));
    }
    for (const file of files) found.push(read(file));
  }
  if (found.length === 0) {
    const old = sources.previous?.components.find((component) => component.name === row.name);
    for (const key of old?.texts ?? []) {
      const text = sources.previous?.texts[key];
      if (text) found.push(text);
    }
  }
  return [...new Set(found)];
}

/** License texts without a copyright holder in them: any copy of one will do for another package. */
const HOLDER_FREE: Readonly<Record<string, RegExp>> = {
  'Apache-2.0': /Apache License\s+Version 2\.0, January 2004/,
  'MPL-2.0': /Mozilla Public License Version 2\.0/,
};

/**
 * For a package that ships no license file: the holder-free text of each license it names that
 * another component's text provides, and for any other a pointer to the SPDX text. Only with at
 * least one real text.
 */
function fallbackTexts(license: string, pool: readonly string[]): string[] {
  const atoms = license.split(/\s+(?:AND|OR)\s+|\//).map((atom) => atom.trim());
  const found: string[] = [];
  let real = false;
  for (const atom of atoms) {
    const text = pool.find((candidate) => HOLDER_FREE[atom]?.test(candidate));
    if (text) real = true;
    found.push(text ?? `${atom}: see https://spdx.org/licenses/${atom}.html`);
  }
  return real ? [...new Set(found)] : [];
}

/** The credit paragraph a content folder keeps, with the full license text's address. */
function contentText(row: NoticeRow, sources: Sources): string[] {
  const readme = join(sources.root, row.name, 'README.md');
  if (!existsSync(readme)) return [];
  const credit = read(readme)
    .split(/\n\s*\n/)
    .filter((paragraph) => /licensed under/i.test(paragraph))
    .join('\n\n')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  const spdx = row.license.toLowerCase().replace(/^cc-/, '').replace(/-(\d+\.\d+)$/, '/$1');
  return [`${credit}\n\nFull license text: https://creativecommons.org/licenses/${spdx}/legalcode`];
}

/** Builds the data from NOTICE and the license files; throws if a row ends without a text. */
export function buildLicenseData(sources: Sources): LicenseData {
  const { root } = sources;
  const notice = readFileSync(join(root, 'NOTICE'), 'utf8');
  const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  const lock = existsSync(join(root, 'apps/native/src-tauri/Cargo.lock'))
    ? readFileSync(join(root, 'apps/native/src-tauri/Cargo.lock'), 'utf8')
    : '';
  const texts: Record<string, string> = {};
  const keyOf = (text: string): string => {
    const key = createHash('sha256').update(text).digest('hex').slice(0, 12);
    texts[key] = text;
    return key;
  };
  const components: LicenseComponent[] = [];
  const content: LicenseContent[] = [];
  const missing: string[] = [];
  for (const row of parseNotice(notice)) {
    if (row.kind === 'content') {
      const found = contentText(row, sources);
      if (!found.length) missing.push(row.name);
      content.push({
        name: row.name,
        author: row.author ?? '',
        origin: row.origin ?? '',
        license: row.license,
        note: row.note ?? '',
        texts: found.map(keyOf),
      });
      continue;
    }
    // An MPL row has no version in NOTICE: Cargo.lock or the package store knows it.
    const noticed = row.version ? row.version.split(' / ') : [];
    const version =
      noticed.length > 0
        ? noticed
        : [
            lockedVersion(lock, row.name) ||
              (npmDir(row.name, '', root)?.match(/@([^@/]+?)(?:_[^/]*)?\/node_modules/)?.[1] ?? ''),
          ];
    const found = textsFor(row, version, sources);
    if (!found.length) missing.push(row.name);
    components.push({
      name: row.name,
      version: version.join(' / '),
      license: row.license,
      purpose: row.purpose,
      texts: found.map(keyOf),
    });
  }
  for (const [at, component] of components.entries()) {
    if (component.texts.length) continue;
    const pool = Object.values(texts);
    const found = fallbackTexts(component.license, pool);
    if (found.length) {
      components[at] = { ...component, texts: found.map(keyOf) };
      missing.splice(missing.indexOf(component.name), 1);
    }
  }
  if (missing.length) {
    throw new Error(`No license text found for: ${missing.join(', ')}`);
  }
  return {
    appName: 'ridrs',
    appVersion: rootPackage.version,
    appLicense: 'AGPL-3.0-or-later',
    appText: keyOf(read(join(root, 'LICENSES/AGPL-3.0-or-later.txt'))),
    components,
    content,
    texts,
  };
}

/** The TypeScript module the licenses screen imports. */
export function renderModule(data: LicenseData): string {
  return `// SPDX-License-Identifier: AGPL-3.0-or-later
// Generated by \`pnpm generate:licenses\` from NOTICE and the repository's license files
// (ADR 0073); do not edit by hand.

import type { LicenseData } from './licenses.ts';

export const licenseData: LicenseData = ${JSON.stringify(data, null, 2)};
`;
}

/** The app's version alone, so that the settings need not load the large licenses module. */
export function renderAbout(data: LicenseData): string {
  return `// SPDX-License-Identifier: AGPL-3.0-or-later
// Generated by \`pnpm generate:licenses\` (ADR 0073); do not edit by hand.

export const appVersion = ${JSON.stringify(data.appVersion)};
`;
}
