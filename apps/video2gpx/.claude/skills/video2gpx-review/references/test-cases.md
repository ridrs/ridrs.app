# Making snippet tests that are fast and trustworthy

A test is only useful when all three hold:
- it fails for the reason found;
- it passes when that reason is fixed;
- it runs in a few minutes.

The suite grows with every reviewed video. Keep each case small and its truth solid.

## Choosing the window (t0, t1)

- **Lead-in:** 30–90 s before the problem. Start the snippet at a place the frames prove, such as a junction, a roundabout or a sign.
  That place becomes the first checkpoint and the start frame. The full run had the whole route as context; the start frame replaces
  that context. Without it, a short clip is a cold start, which is a different and harder problem (see the Gotthard-start case in
  docs/CONCEPT_fast_testing.md: no_route on 10 min alone).
- **Problem:** the whole spot, plus 20–60 s after it, up to a checkpoint that proves the route is back on track (or still off).
- **Length:** measure it in **driven distance and turns**, not in minutes. A snippet needs about 2–3 km of driving and at least 3
  distinct turns, because the route search calibrates distance scale and focal length anew on every snippet.
  - Self-test 2026-11-19: 75 s and 0.6 km in the Monaco tunnel gave a distance scale of 1.06 instead of 0.86 (full run), and so
    no_route. The full run was confident there.
  - In practice this means 2–5 min in towns and longer on fast roads. Keep it at most 7 min.
- **Runtime:**
  - motion takes about 25 s per minute of 480p clip, rotation about 8 s;
  - the map step reads the whole .pbf the first time: 160 s for alps.osm.pbf (2.3 GB). After that the graph comes from
    `video2gpx-runs/_cache`, as long as the bbox stays the same;
  - refine takes about 1 min.
  - Measured on that self-test: 286 s in total, of which 161 s was the map step.
- **Count the turns before you cut.** Use `series.json` → `cells`, and count the cells with `turn_v` and `turn_m` above 30° in the window.
  With fewer than about 3, the snippet will mis-calibrate. Example, 2026-11-19: the Nice Promenade, 4 min and 2.3 km with no turn, gave
  no_route, 200–1300 m off.
- **When a snippet cannot reproduce** because it loses the full run's calibration, say so in the report. Recommend a
  test-only pipeline option that fixes f_eff / kappa from the full run (not available today). That fact is itself a finding: the result
  depends on context.
- **Area:** make_test.py takes the full run's positions in the window plus all checkpoints, plus 2 km. If the true road is far off, add a
  checkpoint on it. The bbox always covers the checkpoints, so the truth is reachable.
- **Pure motion or rotation causes** (`odometry.*`, `rotation.*`): a 60–120 s snippet is enough, because the fix shows in the motion and
  rotation steps. Still give it checkpoints, so it also proves the route effect.

## When a snippet cannot reproduce: the seeded full case

Some causes need the context of the whole run: the calibration (f_eff, kappa), or a distance mismatch that builds up over kilometres.
Two Nice–Monaco snippets lost their cause this way:
- the U-turn loop did not appear at all;
- the Promenade gave no_route.

For such a cause, make **one case per video** on the whole video, seeded with the finished run:

```bash
$PY $S/make_test.py <id> --name <video>-full-from-search --full-from route_search --checkpoints review/tests/<video>-full.cps.json \
    --kind error --cause "…" --focus t0,t1 --no-backtrack-windows "t0,t1;t0,t1" --why "…"
```

`run_tests.py` copies the run (tens of MB) each time and reruns only from `route_search` (or `refine`), with the run's own parameters
(hint, anchors, intro end). Motion and rotation, the expensive part, are reused.
- **Runtime:** about route_search + refine of the full run. For Nice–Monaco (75 min of video) that is about 8 min, against about 20 min
  for the whole run.
- **Use it** for changes in route search, refine and confidence. Changes in motion or rotation need snippets or the full run.
- **Checkpoints:** put all the frame-verified checkpoints of the video into one file. Add `--no-backtrack-windows` for every place where
  the frames show the vehicle driving straight on but the path loops.

## Checkpoints (the truth)

- Use 3–8 per case, spread over the snippet, with at least one inside the problem and one after it.
- Only take seconds where the frame **proves** the position:
  - the moment of a turn at a junction, the entry into a roundabout, a tunnel portal, a bridge start;
  - a sign with a name, a distinctive building, a ferry quay.

  A straight without features proves nothing.
- Put each checkpoint on the OSM node of that feature (from `evidence/<spot>/nodes.json`, which lists the junction nodes near the route
  with their street names). The node can also come from a node on the true road found in `map.png`. Set `tol_m` to 50 at sharp
  junctions and 100 on open roads or long features.
- `t` is the second of the original video where the camera is at the node: the frame where the turn begins or where you are in the
  middle of the roundabout. Check the neighbouring seconds with `evidence.py frames` to get it within about 1 s.
- `why` says what the frame shows, e.g. "roundabout 99–103, Oberalppass sign left at 104". A later reviewer must be able to re-check it.

File `review/tests/<name>.cps.json`:

```json
[{"name": "Rond-point X (entry)", "t": 683, "lat": 43.6951, "lon": 7.2650, "tol_m": 50, "why": "roundabout entry 682-684, exit 2 at 687"},
 {"name": "Tunnel de Magnan south portal", "t": 760, "lat": 43.6942, "lon": 7.2401, "tol_m": 100, "why": "portal 759-761"}]
```

## Kinds and expectations

| kind | from | today | after a good fix |
|---|---|---|---|
| `error` | a `wrong` spot | FAIL (a checkpoint inside or after the problem is missed) | PASS |
| `uncertain_correct` | a `correct_uncertain` spot | PASS, focus conf low | PASS, focus conf higher (BETTER) |
| `control` | a `correct` control spot or a clean stretch | PASS | PASS (a guard against regressions) |

The suite fails only on a REGRESSION: a checkpoint that passed before and now fails. Confidence changes are reported, not enforced,
because some low confidence is honest (`confidence.no_information`).

## Names

`<video>-<place>-<problem>`, lowercase with hyphens. Examples: `nice-monaco-louis2-tunnel-yaw`, `gotthard-valley-odofail`,
`madone-menton-parallel`. The video part is a short name, not the YouTube id; the id is in case.json.

## Budget

Record each case's runtime from the first `run_tests.py` run (`baseline.json` → `wall_s`). Keep the whole suite in view: when it passes
about 60 min, propose a "quick" subset (one case per cause) in the report. Also propose `--seed … --from-step` for changes that start
late in the pipeline.
