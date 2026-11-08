// SPDX-License-Identifier: AGPL-3.0-or-later

/** The preview kit's texts in English (ADR 0072): the shape of every language. */
export const en = {
  preview: 'Preview',
  back: 'Back',
  hide: (name: string) => `Hide ${name}`,
};

export type Messages = typeof en;
