# Feature: search frame, start frame and route hint (KML/GPX)

Status: planned, 2026-11-11. Builds on APP_SPEC.md (research/route-shape-matching/APP_SPEC.md) and PIPELINE_CLI.md.

## Why

Today the visible map section is the search area. That is imprecise: the window shape decides the area, it changes with every zoom, and the user cannot say what they already know ("the video starts in Peille", "it roughly follows this route"). Such knowledge makes the search faster and more reliable, especially for difficult videos (motorcycle, many similar roads).

## 1. Search frame (user-drawn)

- A **rectangle on the map, drawn by the user**, replaces "visible map = search area".
- **Tools:** "Draw search frame" (drag a rectangle), handles to resize, drag to move, "Delete". There is also "Use visible section" as a one-click way to set the frame to the current view (this is the old behaviour).
- **Default:**
  - When a project gets its title suggestion, the app proposes a search frame: the suggestion area, a square of a sensible size around the hit. It is drawn as an editable frame.
  - If a route hint is loaded (section 3), the proposed search frame is the hint's bounding box plus a margin (default 3 km).
- **Display:**
  - The frame is always visible, as a solid outline with a light fill. Its size is shown in the info line ("Suchrahmen 18 × 14 km").
  - Map-data coverage is checked against the frame, not the view.
  - Size warnings (too large or too small) refer to the frame.
- **During a run** the frame is locked (dashed), as now. After the run it stays as it was used, until the user edits it.

## 2. Start frame (optional, user-drawn)

- A second, **smaller rectangle** marks where the video **starts**: the camera position at the first decodable second.
- **Tools:** "Draw start frame", move, resize, delete. It must lie inside the search frame; the app clamps it or warns.
- **Visual distinction:** a different colour (e.g. green) and the label "Start".
- **Meaning for the search:** the route must begin inside this frame. It is a hard constraint on the initial state of the HMM, with a small tolerance (default 150 m), because the first seconds may be gaps.
- **Optional end frame:** same mechanics and colour red, label "Ende". If simple, implement it the same way; otherwise prepare the data model only.

## 3. Route hint: KML or GPX upload (optional)

- **"Load route hint…"** accepts a .gpx (track or route) or .kml (LineString, gx:Track, or MultiGeometry with lines). The file is copied into the project.
- It is drawn as a thin dashed purple line labelled "Vermutete Strecke (Hinweis)".
- **Meaning for the search:** a **corridor**.
  - Only roads within a buffer of the hint are used (default 300 m; adjustable 100 m–2 km in the UI).
  - The hint is only approximate: hand-drawn, a tour description, or a route planner. So it is not trusted blindly:
    - If the corridor is too thin to hold a plausible route (map step: corridor road km against the vms nominal length × the upper distance scale), the status light says "difficult".
    - If the route search in the corridor ends with a poor verdict, the pipeline reruns route_search once on the full search frame and reports both results. The better one becomes the result, and the report says which.
- **Direction:** the hint's direction is not trusted (people draw routes either way); both directions are allowed.
- **Timestamps** in a hint GPX are ignored. It is only geometry. The hint is never used as GPS truth.
- The result, project.json and the GPX metadata state "mit Routenhinweis" (with route hint) and the buffer used, so results with hints are distinguishable from blind ones.

## Pipeline changes (rsm.pipeline)

New CLI options; defaults unchanged:

```
--start-bbox S,W,N,E        start frame (hard constraint on the initial HMM states, tolerance --start-tol-m 150)
--end-bbox S,W,N,E          optional end frame (constraint on the final states)
--hint FILE                 .gpx or .kml route hint
--hint-buffer-m 300         corridor half-width
--hint-fallback auto|off    rerun on the full frame if the corridor result is poor (default auto)
```

- **map step:** with --hint, keep only edges within the buffer of the hint polyline (in addition to the bbox filter), plus the edges needed to keep the corridor connected. Report corridor road km.
- **route_search:**
  - with --start-bbox, the initial log-probabilities of cells outside the frame (plus tolerance) are −inf;
  - with --end-bbox, the same for the final step (back-trace from end cells inside the frame only);
  - if the constraints make the problem infeasible (no path), report a clear "problem" status and fall back to the unconstrained run, saying so.
- **Status events (new signals):**
  - `start_frame`: the decoded start lies inside the frame (good) or at the tolerance edge (difficult);
  - `hint_corridor`: corridor big enough or not, and whether the fallback was used;
  - `hint_agreement`: the share of the decoded route within the buffer of the hint, as information.
- **Checkpoint input hashes** include the new inputs, so changing a frame or the hint reruns from the right step: map for the hint, route_search for start or end.
- **Result summary and GPX metadata:** hints_used = {start_bbox, end_bbox, hint_file, buffer_m, fallback_used}.

## App changes (video2gpx)

- **Map tools** (Leaflet; own small implementation or a maintained MIT plugin such as leaflet-geoman): draw, edit and delete the search frame, start frame and end frame; load and remove the route hint.
- **A legend in the map panel:** search frame, start, end, hint, and the route of the result.
- **Persistence:** frames, hint and buffer are saved in app.json and passed to the pipeline (new RunParams fields).
- **Run panel:** short line "Hinweise: Startrahmen ✓ · Routenhinweis (300 m) ✓".
- **Result:**
  - the new status signals as lights;
  - the note "mit Routenhinweis" next to the verdict;
  - the hint line stays visible for comparison.

## Acceptance

1. Drawing, moving, resizing and deleting all three frames works with the mouse and survives reopening the project.
2. Map-data coverage and size warnings follow the search frame, not the view.
3. **Pipeline unit tests:**
   - the start frame forces the decoded start into the frame;
   - an infeasible frame falls back with a clear status;
   - the corridor filter keeps a connected road set;
   - GPX and KML parsing (track, route, LineString, gx:Track).
4. **E2E on Roanne** (development video; its GPX is only used to build test hints):
   - (a) no hints: same result as before;
   - (b) start frame of 2 × 2 km around the true start: correct, and the route search is no slower;
   - (c) a coarse hint (the GPS track simplified to 20 points and shifted 80 m): correct, with the map and route-search time reported against (a);
   - (d) a wrong hint (a different valley road): the corridor result is poor, and the fallback produces the correct route.
5. Re-freeze the pipeline (new code hash) and update PIPELINE_CLI.md and APP_SPEC.md.
