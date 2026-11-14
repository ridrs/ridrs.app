// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

export const de: Messages = {
  bin: 'Papierkorb',
  dateLocale: 'de-DE',
  items: (count: number) => (count === 1 ? '1 Eintrag' : `${count} Einträge`),
  dropToRemove: 'Zum Entfernen hier ablegen',
  dropToDeleteRide: 'Zum Löschen der Fahrt hier ablegen',
  intro: 'Was du in den Papierkorb ziehst, ist überall ausgeblendet. Gelöscht wird es erst, wenn du es hier löschst.',
  empty: 'Der Papierkorb ist leer.',
  emptyHint: 'Zieh ein geplantes Workout oder eine gefahrene Fahrt auf den Papierkorb im Menü, um es zu entfernen.',
  planned: 'Geplante Workouts',
  done: 'Gefahrene Fahrten',
  binnedOn: (date: string) => `Im Papierkorb seit ${date}`,
  restore: (title: string) => `Wiederherstellen: ${title}`,
  restoreLabel: 'Wiederherstellen',
  deleteForGood: (title: string) => `Endgültig löschen: ${title}`,
  deleteLabel: 'Endgültig löschen',
  emptyBin: 'Papierkorb leeren',
  cancel: 'Abbrechen',
  and: (all: readonly string[]) =>
    all.length <= 1 ? (all[0] ?? '') : `${all.slice(0, -1).join(', ')} und ${all.at(-1)}`,
  askOne: (title: string, where: string) =>
    `„${title}“ aus ${where} löschen? Das kann nicht rückgängig gemacht werden.`,
  askAll: (count: number) =>
    `${count === 1 ? 'Den Eintrag' : `Alle ${count} Einträge`} im Papierkorb löschen? Das kann nicht rückgängig gemacht werden.`,
  refused: (source, reason) =>
    reason === 'read-only'
      ? `${source} kann hier nicht geändert werden: Es wurde nichts entfernt.`
      : reason === 'unreachable'
        ? `${source} war nicht erreichbar: Es wurde nichts entfernt.`
        : `${source} hat die Änderung nicht angenommen.`,
};
