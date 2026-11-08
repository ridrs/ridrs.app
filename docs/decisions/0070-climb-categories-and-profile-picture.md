<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0070: Climb Categories for Catalog Routes, and a Profile Picture from the Tool

## Context

The route details of a video route showed a small elevation line and the total ascent. Riders know climbs by the big tours' categories (Cat 4 to Cat 1 and HC) and their stage profiles: a slab coloured km by km by its gradient, with each summit marked. The maintainer asked for both in the Van Gestel catalog, "exactly by the Tour de France's criteria".

The Tour publishes no formula. Its organiser categorises each climb by hand, weighing length, gradient, position in the stage and the road. Only a stand-in can be computed.

## Decision

- **Score = length in m × average gradient in %** (accepted by the maintainer on 2026-11-07). This is the best-known stand-in, also used by Strava. Thresholds: Cat 4 from 8,000, Cat 3 from 16,000, Cat 2 from 32,000, Cat 1 from 64,000, HC from 80,000. Climbs averaging under 3 % or shorter than 500 m get no category. Since length × gradient = 100 × height gained, the category follows the climb's height: Cat 4 from 80 m, Cat 3 from 160 m, Cat 2 from 320 m, Cat 1 from 640 m, HC from 800 m.
- **What counts as one climb** (our own rules: the stand-in says nothing about this):
  - A climb runs from a low point to a high point of the 100-m profile.
  - A dip of less than 50 m does not end it.
  - The foot moves past a false flat: forward while the next 100 m step or the next 500 m climbs less than 2 %.
  - If the climb then averages under 3 %, the foot moves on to the first point from which the rest of the climb averages 3 %.
- **Counter-proposal considered: the FIETS index** (H² / (D × 10) + (T − 1000) / 1000), which also rewards a high summit. Rejected: there are no common thresholds for mapping it to categories, so the HC and Cat 1 boundaries would be our invention.
- **The profile picture is a side product of the catalog tool, not used by the app** (maintainer, 2026-11-07). The app draws a route's profile itself from the offer's data. The picture is an SVG: `catalog/<id>/profile.svg`, with no library (a text format, deterministic, a few hundred lines of ridrs code). It shows:
  - a slab with a top face, coloured km by km in six gradient bands (below 2 %, 2–4, 4–6, 6–8, 8–10, 10 % and more); a descent counts as flat;
  - the gradient written in each km of a climb;
  - each summit marked with a red disc showing its category, its altitude and its km;
  - start and finish altitudes, an altitude and a km scale, and a legend.

  It carries no name, logo or jersey of the Tour de France; those belong to its organiser.
- **Data:** `categoriseClimbs` and `nameClimbs` (`plugins/video-source-vangestel/climbs.ts`) and `drawProfile` (`profile-picture.ts`) run in `pnpm fetch:video-catalog`. Each route folder has `<id>/peaks.txt` with the summit names of its categorised climbs in order (kept when the tool runs again; seeded from the control file's notes when missing). `index.json` and `route.json` get `climbs` (category, start, end, gain, grade, summit, name); the picture sits at `<id>/profile.svg`, named in no JSON and shipped with no bundle. The offer contract gets the optional `climbs`. The ride page's route details keep the profile the app draws and list each climb, e.g. `Cat 1: summit 1244 m at km 14.3 · 14.3 km at 4.9 %`.

| Point | Confidence | Revisit when |
|---|---|---|
| Score and thresholds | ~85 % that it is the best-known stand-in; ~60 % that it matches the Tour's rating of a given climb (the Tour weighs the position in the stage, which a catalog route doesn't have) | Riders compare ratings with real Tour stages and find them off |
| The 50 m dip, 2 % false flat, 3 % foot | ~70 % | A route's climbs look split or merged to the eye |

## Consequences

- Of the 23 routes, 17 have at least one categorised climb. The most demanding are the Col de Rousset and the Col de Menée (Cat 1).
- The tool keeps a `thumbnail.jpg` or `peaks.txt` that is already there and fetches the site's picture or seeds `peaks.txt` from the notes only for a route without one: the routes get thumbnails and summit names of their own.
- The pictures are derived from the GPX tracks and fall under the catalog folder's CC BY-NC-SA 4.0 (LICENSING.md, section 6a).
- Climbs are named from `<id>/peaks.txt` first, or else from the control file's notes where they name them (2026-11-07): a place named within 300 m of the summit (`Col de Pennes (alt. 1040m)`), else the last note announcing an ascent from 500 m before the foot to the summit (`Rimberg - ascent ca. 6 %`). Notes about the whole route (title with its length, license) never name a climb. Every climb of the catalog has its summit named in `<id>/peaks.txt` from the map at the summit's coordinates. The ride page's route details draw the profile coloured by the six gradient bands (the steepest in dark purple, not black, on the dark background) with each summit's category and name or altitude.
