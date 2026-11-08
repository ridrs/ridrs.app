// SPDX-License-Identifier: AGPL-3.0-or-later

/** The debriefing's texts in English (ADR 0072): the shape of every language. */
export const en = {
  finished: 'Ride finished',
  distance: 'Distance',
  time: 'Time',
  km: (km: string) => `${km} km`,
  notRecorded: 'The ride could not be recorded.',
  uploading: 'Uploading to intervals.icu…',
  kept: 'The ride is kept on this device.',
  /** Why an upload failed, by the planner's reason. */
  failures: {
    'not-connected': 'intervals.icu is not connected.',
    'token-rejected': 'intervals.icu asks you to connect again.',
    unreachable: 'intervals.icu could not be reached.',
    rejected: 'intervals.icu did not accept the ride.',
  },
  uploadFailed: 'The upload failed.',
  saveUploads: (athlete?: string) =>
    `Save uploads the ride to intervals.icu${athlete ? ` as ${athlete}` : ''}.`,
  saveKeeps: 'Save keeps the ride on this device. Connect intervals.icu in Me to upload rides.',
  deleteQuestion: 'Delete this ride?',
  deleteWarning: 'Delete this ride? It cannot be brought back.',
  deleteRide: 'Delete ride',
  keepRide: 'Keep ride',
  tryAgain: 'Try again',
  save: 'Save',
  reconnect: 'Reconnect intervals.icu',
  connect: 'Connect intervals.icu',
  withoutUpload: 'Save without upload',
  delete: 'Delete',
};

export type Messages = typeof en;
