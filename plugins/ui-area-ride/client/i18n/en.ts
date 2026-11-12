// SPDX-License-Identifier: AGPL-3.0-or-later

/** The ride area's texts in English (ADR 0072): the shape of every language. */
export const en = {
  title: 'Ride',
  intro: 'Ride freely: worlds, routes and real video. Pick a route, then Go.',
  filters: 'Filters',
  filter: { flat: 'Flat', hilly: 'Hilly', short: 'Under 45 min', favourites: 'Favourites' },
  worlds: 'Worlds and routes',
  noWorld: 'No world offers a route.',
  videos: 'Real video',
  noVideo: 'No video source offers a route.',
  noMatch: 'No route matches the filters.',
  later: 'Map, pacers and groups',
  laterAbout: 'A map of every world, pacer bots and group rides come later.',
  onToday: 'On Today',
  showOnToday: 'Show Ride again on Today',
  rideAgain: 'Ride again',
  rideAgainButton: (title: string) => `Ride ${title} again`,
  video: 'Video',
  route: 'Route',
  part: (tour: string, part: number) => `${tour}, part ${part}`,
  /** A country of a route's tags, by its English name; others as they are. */
  countries: { France: 'France', Germany: 'Germany' } as Readonly<Record<string, string>>,
  /** A level of a route's tags, by its English name; others as they are. */
  levels: { Easy: 'Easy', Moderate: 'Moderate', Hard: 'Hard' } as Readonly<Record<string, string>>,
  favourite: 'Favourite',
  favouriteOf: (title: string) => `Favourite ${title}`,
  profileOf: (title: string) => `Elevation profile of ${title}`,
  details: (title: string) => `${title} details`,
  distance: 'Distance',
  climb: 'Climb',
  duration: 'Duration',
  level: 'Level',
  go: 'Go',
  download: 'Download',
  downloadOf: (title: string) => `Download ${title}`,
  cancelDownload: 'Cancel download',
  cancelDownloadOf: (title: string) => `Cancel download of ${title}`,
  remove: 'Remove from this device',
  notHere: (size: string) => `Not on this device yet: ${size} to download`,
  downloading: (percent: number) => `Downloading: ${percent} %`,
  failed: 'Download failed',
  failedBecause: (reason: string) => `Download failed: ${reason}`,
  importingRoute: 'Importing: it can be ridden once it is on this device',
  onDevice: 'On this device',
  importVideo: 'Import video',
  importKind: 'Import',
  importAbout: 'An Incyclist package (.zip or .ride) with video, GPX track and control file',
  importing: 'Importing',
  importingFile: (file: string) => `Importing ${file}`,
  importFailed: 'Import failed',
  importFailedBecause: (reason: string) => `Import failed: ${reason}`,
  profile: 'Profile',
  climbs: 'Climbs',
  gradients: 'Gradients',
  credits: (author: string, source: string, license: string, url: string) =>
    `By ${author}, ${source}, ${license}. ${url}`,
  /** m along the route as the rider reads it: `14.3`. */
  km: (metres: number) => (metres / 1000).toFixed(1),
  kmAt: (km: string) => `km ${km}`,
  metres: (metres: number) => `${Math.round(metres)} m`,
  /** A categorised climb's name: `HC` or `Cat 1` to `Cat 4` (ADR 0070). */
  category: (category: string) => (category === 'HC' ? 'HC' : `Cat ${category}`),
  /** A climb in the details: `Cat 1: summit 1244 m at km 14.3 · 14.3 km at 4.9 %`. */
  describeClimb: (category: string, summit: number, at: string, length: string, grade: number) =>
    `${category}: summit ${Math.round(summit)} m at km ${at} · ${length} km at ${grade.toFixed(1)} %`,
  /** How long a ride takes about: `about 2 h 53 min`, `about 44 min`. */
  about: (minutes: number) =>
    minutes < 60 ? `about ${minutes} min` : `about ${Math.floor(minutes / 60)} h ${minutes % 60} min`,
  /** A download's size: `11.2 GB`, `770 MB`. */
  size: (bytes: number) =>
    bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`,
  /** The gradient bands of the profile, flattest first (`GRADES`). */
  grades: ['below 2 %', '2–4 %', '4–6 %', '6–8 %', '8–10 %', '10 % and more'] as readonly string[],
};

export type Messages = typeof en;
