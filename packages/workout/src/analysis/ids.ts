// SPDX-License-Identifier: AGPL-3.0-or-later

const slug = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * An id for an imported workout: from the file name (what the importer derived), else with the
 * start of the hash, else counted. The same files give the same ids, and no id is used twice in
 * the library or the batch. A copy always carries the hash, so it never takes the id of its
 * original.
 */
export function chooseWorkoutId(
  base: string,
  hash: string,
  taken: ReadonlySet<string>,
  copy: boolean,
): string {
  const root = slug(base) || 'workout';
  if (!copy && !taken.has(root)) return root;
  const hashed = `${root}-${hash.slice(0, 8)}`;
  if (!taken.has(hashed)) return hashed;
  for (let n = 2; ; n += 1) {
    if (!taken.has(`${hashed}-${n}`)) return `${hashed}-${n}`;
  }
}

/** The time of an import as a workout's `source.importedAt` keeps it: ISO 8601 from epoch ms. */
export function importTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
