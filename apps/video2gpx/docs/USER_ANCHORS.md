# Ortsangaben (user anchors) and reruns from a step

## What the user does

In the result view ("Ergebnis") under the timeline, section **Ortsangaben**:

1. Spool the video to a moment where the place is known.
2. **Ort festlegen**, then drag a rectangle on the map: "at this video time the camera is inside this rectangle". Esc cancels.
   The anchor is stored in the project (`app.json`, key `anchors`: `[{t, bbox: [S, W, N, E]}]`), drawn on the map as an orange dashed
   rectangle labelled with its time. An anchor at the same time (within 0.5 s) replaces the old one; several anchors per project are allowed.
3. The list shows every anchor (m:ss, frame); clicking the time spools the video there and shows the frame, the bin deletes it.
4. **Mit Ortsangaben neu berechnen** starts a rerun (enabled when the anchors differ from those of the last run). Only route search,
   refinement and GPX are computed again; motion, rotation and map are reused from the project.
5. After the run the section says how many anchors were used, and names the times of anchors that could not be satisfied
   ("1 von 2 Ortsangaben berücksichtigt; nicht erfüllbar und ignoriert: 1:08").

**Ab Schritt … neu berechnen** (same section): forces a rerun from the chosen step (1. Videobewegung = everything new); the steps before it are
reused from the last run as they are, never recomputed. The choice lists a step only if every step before it has a result. The run view shows
reused steps as "übernommen aus dem letzten Lauf", computed ones as "fertig · time".

## Reruns reuse unchanged steps (app runtime)

Every run started from the app passes `--resume` on the project's `out` dir (`src/anchors.ts` `rerunArgs`, `src/features/run.ts`):
a step whose input hash (cli.py `Run.hashes`, chained) is unchanged is reused. Anchors enter the hashes from `route_search` on only, so a new or
changed anchor reruns route_search, refine and gpx. The map step reruns only when an anchor frame lies outside the search area (it is then grown
by the frame + 500 m, `anchors.grow_bbox`). Caveat: the hashes contain the config and version tokens of each step, not the code hash; after a
pipeline code change "Ab Schritt 1 (alles neu)" forces a full run.

## Pipeline

`python -m rsm.pipeline run ... --anchors FILE.json [--resume [--from-step STEP]]` (sidecar `rsm-pipeline run` the same). The app writes
the anchors to `<project>/anchors.json` (`src-tauri/src/pipeline.rs` `write_anchors`) and passes the path, like the hint file.

Mechanism (`rsm/pipeline/anchors.py`):

- **time → step**: the HMM steps are distance-based; `Steps.t` is the video time at the end of each step. An anchor applies to the step
  nearest to t (only if one lies within 5 s; sliced step sequences of the island pass use their own `t`).
- **frame → cells**: cells whose centre lies inside the frame, projected into the graph CRS and grown by about one cell (`max(10 m, h)`).
- **where**: `dp.STEP_OK_HOOK` merges the masks into `step_ok` of every `viterbi` / `forward_backward` of the step process
  (`anchors.activate`): the route_search calibration scan (the masks cost one `np.where` per anchor step, nothing measurable next to a
  Viterbi pass, so the kappa / f_eff scan is constrained too), its decode and posterior, the local pass, the island and extension passes,
  and the refine posterior (`steps_c.forward_backward_cb`). route_search activates `P["anchors"]`, refine the ones route_search kept
  (`route.pkl["anchors"]["used"]`). The plausibility step (decoys) does not use them.
- **infeasible anchors**: before each search (`_search` → `anchors.ensure`) a Viterbi pass without back pointers on a reference grid
  (kappa 1, middle f, start / end frame applied) checks the anchors; if no path satisfies all, they are added greedily in time order and each one
  that makes the decode infeasible is dropped (`anchors.prune`), logged and reported: status `user_anchors` (good / difficult / problem),
  `route.pkl` and the route_search summary `anchors = {n, used, dropped, dropped_t}`, the final result summary key `anchors`.

Tests: `research/route-shape-matching/tests/test_anchors.py` (parsing, time → step, frame → cells, toy decode forced through an anchor,
infeasible anchor dropped, hashes, resume / `--from-step` with a fake worker); `tests/anchors/anchors.test.ts` (`pnpm test:ui`: storage,
step choice → CLI options, German report); `pipeline.rs` `args_with_anchors_and_from_step`.

## Check on Gotthard (2026-11-14)

Copy of the app project `gotthard-pass-4k-hdr-famous-cobb-…` (`research/route-shape-matching/work/anchors-e2e/`; `before/` = the app's
result, `out/` = the rerun). The original video file of the project was renamed, so the rerun used the 1080p file with
`--resume --from-step route_search --anchors anchors.json`: motion, rotation and map were reused (step events `skipped` + `reused`, with the
warning that their input hashes differ), route_search 47.7 s, refine 76.6 s, gpx 1.1 s (the first run: motion 222 s, rotation 45 s, map 93 s,
route_search 39 s, refine 82 s). One anchor: t = 68 s, frame 46.6365–46.6377 N, 8.5940–8.5958 E around the Bahnhofstrasse / Gotthardstrasse
junction (OSM node 46.63713 N, 8.59487 E).

| | before | with the anchor |
|---|---|---|
| verdict | no_route | uncertain (mean posterior 0.87), status `user_anchors` good, 1 of 1 used |
| 0:40 (first decoded) | 46.6362, 8.5903, valley road west of the village | 46.6386, 8.5944, Gotthardstrasse north of the junction |
| 1:08 | 462 m from the junction | 24 m from the junction |
| 2:20 | 46.6316, 8.5873 (valley road) | 46.6340, 8.5976 (village, south-east) |
| 3:40 | 46.6285, 8.5840 | 46.6321, 8.5922 (station area) |
| 4:12 | 46.6260, 8.5807 | 46.6305, 8.5871, onto the valley road |
| 6:15 | Hospental (46.6181, 8.5679) | Hospental (46.6182, 8.5680) |

The route now runs through Andermatt village and leaves it onto the valley road at about 4:10, as in the true route; before, it never entered the
village. Still wrong: the first minute comes from the north along Gotthardstrasse instead of from the station car park along Bahnhofstrasse
(one anchor fixes 1:08 only; a second anchor at 0:24 at the station car park would be the next test).
