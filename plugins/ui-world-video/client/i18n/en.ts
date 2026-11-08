// SPDX-License-Identifier: AGPL-3.0-or-later

/** The video world's texts in English (ADR 0072): the shape of every language. */
export const en = {
  km: (km: string) => `${km} km`,
  complete: 'Route complete',
  loading: 'Loading the video…',
  cannotShow: (reason: string) => `The video cannot be shown: ${reason}`,
};

export type Messages = typeof en;
