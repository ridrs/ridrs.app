# History, background and open items

This is a summary of the research and product work through 2026-11-12. The full lab notebook, with every number, is `research/route-shape-matching/FINDINGS.md`. The decisions and their reasons are in [DECISIONS.md](DECISIONS.md).

## The problem

The input is a road video (bike, motorcycle or car) with **no GPS**: a YouTube ride, a helmet camera. The output is a GPX whose timestamps are the video time and whose positions are where the camera was on the road. Only two things are available:
- the motion in the picture (optical flow → turning rate and relative speed);
- the OpenStreetMap road network.

The method has to be classical (no AI) and run locally.

## Background: how the motion is measured

- **vms**, from `research/video-motion-speed`, vendored as `rsm/pipeline/vmsx`: frame-pair Lucas-Kanade on a road trapezoid with a ground-plane flow model, giving yaw (px/frame) and relative speed per frame pair.
  - The angle needs a focal scale (**f_eff**). The distance needs a scale (**κ**, map metres per nominal metre; the nominal camera height is 1.1 m).
  - Neither is known for a random video, which is why the pipeline scans them.
- **Far-feature rotation**: points near the horizon move almost only by rotation. A rotation-only fit gives a cleaner heading, especially for motorcycles.
- **Tracks**: continuous pieces of heading over distance (4 m grid). Gaps come from cuts, darkness or standstills.

## Research arc (11 Nov and before; details in FINDINGS)

1. **Quanta** (curve–straight–curve signatures) matched against OSM: the proof of concept was **negative**. Refinements followed (two-stage weak candidates plus plausibility, whole-video tracking v2/v3), still not reliable.
2. **Calibration against GPS videos** (Van Gestel bikes) showed the turning angle is right up to a factor. That led to the idea of scanning the factor.
3. **Fable review** (external model consultation) proposed three steps: decoys, speed against gradient, and a **dense HMM**. The dense HMM was **the breakthrough**: Grimone 99.8 % fed with GPS; on vms, the correct edges for Grimone 99.9 %, Roanne 99.5 %, Rousset 93 %.
4. **Amalfi** (YouTube, motorcycle, no GPS): a 2-D calibration scan (f_eff × κ) plus far yaw found the right coast road. The user checked it in Street View: right route, 20–40 m along-track offsets on straights.
5. **Refinement**: generalised anchors (curves) with per-segment factors, and an RTS smoother, giving along-track 4.5–6.7 m on the bikes.
6. **Packaging**: the consolidated, frozen pipeline CLI, then a **blind test** on Pontaix–Chamaloc, which came out confident: 100 % correct road, along-track 9.6–13.9 m, cross-track 2.5 m. Then the Tauri app beta.

## Product work in the 11–12 Nov session

| Topic | Outcome |
|---|---|
| App fixes | Beachball (media server); title place search; bbox follows the view; square map. |
| Area hints | Search frame, start and end frames, route-hint corridor; bundled sidecar as default; adaptive calibration grid. |
| **Madone** (motorcycle, 4K HDR, Peille → Col de la Madone → Menton, 51 min) | Without hints it is **no_route** (the route ends in Nice; the calibration peak runs to the grid limit). **With a start frame at Peille: confident, 0.94**, with Peille → Col → Menton → Garavan correct. |
| Menton turn-by-turn (truth from video frames) | The search map lacked residential streets (St-Roch was a dead end), so the **local pass** was added (A4). Then a timing study: up to 21 s late at roundabouts and kinks. **Fable** diagnosed four causes, and fixes A6–A8 brought the **mean lateness from 8.8 s to 2.7 s (max 21 → 8.3 s)**, with Roanne unchanged at 3.6 m along-track. |
| Side street in Menton | The local pass chose the parallel Avenue Cernuschi, so the **road-class prior** was added (A5); the Cours René Coty is now correct. |
| Incyclist export | XML + MP4 + GPX with elevation, ZIP or folder; HDR→SDR and downscaling options. Roanne: export 8 s; ascent 66 m against 67 m reference, constant offset −8 m (RMS 8.7 m, 2.9 m without the offset). Madone: WebM→MP4 remux in 18 s, 9 GB, ZIP64, frame count identical. |
| Incyclist import | **ZIP is not accepted; pick the XML** (P11). RLV is not worth it (P12). |
| Playback view | Speed, grade, elevation, ±100 m profile (P15). |
| Road width from video | Not feasible (P16); the experiment was deleted. |
| Map rendering | Grey map in dark mode, so the filter was moved per tile (E4). |
| Repository | Research moved into `video2gpx/research/` and put under git; data is excluded (E5). |

## Results at a glance

| Video | Type | Result |
|---|---|---|
| Roanne (Van Gestel, GPS) | bike | 100 % correct road, along-track median 3.6 m, p90 8.6 m |
| Grimone, Rousset (GPS) | bike | correct edges 99.9 % / 93 % (earlier pipeline; **not re-run** after the timing fixes) |
| Pontaix–Chamaloc (blind) | bike | confident, 100 % correct road, along-track 9.6–13.9 m |
| Amalfi (YouTube) | motorcycle | right route, decoy rank 1, 20–40 m on straights (user check) |
| Madone (YouTube) | motorcycle | needs a start frame; then confident; Menton landmark lateness mean 2.9 s, max 8.7 s |

## Open items

**Product and app**
- [ ] Verify in the real app (not only the browser mock): the dark-mode map fix, the playback profile, the Incyclist dialog.
- [ ] POV Drive Atlas round trip (P21, 18 Nov, docs/FEATURE_atlas.md): a real job from the atlas admin (drop, route download, import with a 480p template, run, Atlas card, save dialog, upload in the admin); `pnpm ui-shots` for the scenarios `atlas`, `atlas-uncertain`, `atlas-setup`. Still open on the plan: deep link (C), direct send with a service token (D), atlas map lines (E).
- [ ] Incyclist checks only the user can do: import of the XML, VP9-in-MP4 playback, whether standstills are skipped.
- [ ] Make "Als Ordner speichern" the export default (offered, not decided).
- [x] Compute the elevation profile as its own step and let the export reuse it (15 Nov 2026, P18): the Höhe stage makes and shows the profile, the export interpolates its GPX heights from it when it is current. Old profiles are recomputed when the pipeline code or the cached source blocks changed (`stale` in `profile_load`).
- [x] Analyse stage, Part A of docs/FEATURE_analysis_insight.md (16 Nov 2026, P19): the weak stretches get their causes (series per second, curvature of video against map, overlay of the tracked points). Not yet checked in the real app (neither sidecar nor app was built); Part B (live preview during the run) is open.
- [ ] Bundle ffmpeg as an LGPL decode-only build (not approved). App size is 309 MB, and the OpenCV wheel carries GPL x264/x265: dedupe the dylibs, use a minimal OpenCV, replace pyproj. Notarisation needs an Apple developer account.

**Algorithm**
- [ ] Sure standstill (A14, 16 Nov): check the thresholds on a held-out video with town traffic (Madone/Menton, Gotthard); check in Incyclist that the sub-second standstill edges are read and the stop plays right; run the regression bench (Roanne, Grimone, Rousset, Pontaix) against the code before A14.
- [x] Gotthard: a sun flash at 3:12 was taken for a scene cut and the route jumped onto the Andermatt bypass unless anchored (16 Nov 2026, A15): same-scene veto, real-video test on 3:00-3:20. Not yet in an app build; old projects recompute the rotation step.
- [ ] Madone without hints still fails, because the calibration peak runs away. Ideas: a far-feature focal seed (not built), better motorcycle yaw.
- [ ] A roundabout passed straight still lags (+8 s on Madone); roundabouts carry little heading information.
- [ ] The road-class prior can mislead an all-residential route next to a parallel main road (seen in a synthetic town only).
- [ ] Re-run Grimone, Rousset and Pontaix with the current pipeline (b5a5c92f5e2eeca7) to confirm there is no regression.
- [ ] Roanne elevation is offset −8 m against Van Gestel; it is unclear which side is wrong (DEM or barometer). (Offsets do not affect the per-segment metrics of P17; IGN RGE ALTI now gives the absolute height in France.)
- [x] Old profiles were not recomputed when the pipeline version changed: closed by P18 (`stale`, compared by code hash and source blocks).
- [ ] Elevation (P17, docs/ELEVATION_STRATEGY.md §7):
  - reference routes are missing for swissALTI3D, BEV Austria, South Tyrol, NRW and Bavaria (only download and plausibility were checked), and for a second Italian route;
  - fetchers for Slovenia, Trentino and the other open German Länder;
  - check the AW3D30 terms (it would help on void-filled stretches);
  - the Höhe stage (download, chart, stale recompute) and the export dialog line are still to be checked in the real app;
  - profiles from before P17 are only recomputed when the result or the extra data change.
- [ ] The driving line is still a fixed offset; lane position from the video is future work.

## How the work was organised

- **Background agents** did large tasks in parallel: area hints, the Incyclist export, the road-width experiment. **Fable** was consulted for fresh ideas twice: the HMM breakthrough, and the timing diagnosis.
- **Truth without GPS** came from **video frames**: landmarks such as the Cocteau museum, the Bastion and Rond-Point St-Roch, geocoded via Nominatim, plus the user's Street View checks (Roanne 20/20, Amalfi).
- **Check pages:**
  - `rsm/bench/verify_page.py`: frame next to Street View;
  - `rsm/bench/verify_map.py`: map plus frame; a click seeks the video;
  - served by the "verify-pages" launch config from `research/route-shape-matching/work/verify`.
