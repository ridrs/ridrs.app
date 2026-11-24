// SPDX-License-Identifier: AGPL-3.0-or-later

/** The activity menu and debriefing texts in English (ADR 0072, ADR 0108): the shape of every language. */
export const en = {
  menuTitle: 'Ride menu',
  continueRide: 'Continue ride',
  finishRide: 'Finish ride',
  workout: 'Workout',
  noWorkout: 'No workout',
  loadWorkout: 'Load workout',
  changeWorkout: 'Change workout',
  planned: 'Planned',
  library: 'Library',
  noWorkouts: 'No workout is on offer yet.',
  route: 'Route',
  freeRide: 'Free ride',
  changeRoute: 'Change route',
  notDownloaded: 'Not on this device',
  refusal: {
    'no-ftp':
      'This workout is set in % of your FTP, and your profile has no FTP yet. Set your FTP in your profile first.',
    'no-power-zones':
      'This workout is set in power zones, and your profile has none yet. Set your zones in your profile first.',
  },
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
  deleteQuestion: 'Are you sure?',
  deleteWarning: 'This ride will be permanently deleted.',
  yes: 'Yes',
  no: 'No',
  tryAgain: 'Try again',
  save: 'Save',
  reconnect: 'Reconnect intervals.icu',
  connect: 'Connect intervals.icu',
  withoutUpload: 'Save without upload',
  delete: 'Delete',
  devices: 'Devices',
  settings: 'Settings',
  /** The row of Devices and Settings. */
  more: 'More',
};

export type Messages = typeof en;
