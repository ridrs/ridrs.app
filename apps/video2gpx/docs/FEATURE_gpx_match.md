# Feature: match the video to a given GPX, with deviations (Bavaria plan)

Status: planned, 2026-11-17. Nothing in the pipeline or the app is changed yet.
Builds on [BAVARIA_DIAGNOSIS.md](BAVARIA_DIAGNOSIS.md), [FEATURE_area_hints.md](FEATURE_area_hints.md), [USER_ANCHORS.md](USER_ANCHORS.md) and DECISIONS A1, A7, A11–A13.

## Why

The Bavaria video ("5 Lakes", Mittenwald loop, 6872 s, bike) is still not found, even with the komoot GPX as a route hint.
Today the hint is only a **corridor**: it narrows the map to roads within 100–300 m of the GPX, and then the normal search runs inside it.
The search does not use what the GPX tells us beyond that: the order of the places, and that the ride covers almost all of it.

A prototype (17 Nov) used exactly that: it matched the video along the GPX and charged a penalty for every GPX metre that the route does not cover.
The numbers are good, but **just following the GPX is not enough**. A planned route and the ridden route differ:

- **The GPX is longer than the ride**: the rider skipped a part (a shortcut, an out-and-back spur not ridden), or the video cut it out.
- **The GPX is shorter than the ride**: the rider took a detour, an extra loop, rode to a viewpoint and back, or got lost and turned around.
- **The GPX has another way** for a stretch: a parallel path instead of the planned road. This is a skip plus a detour.
- **The GPX geometry is only roughly right**: router snapping, simplified bends, a hand-drawn line. It is locally a few per cent longer or shorter.

The method has to find these places and name them, and the final positions must lie on the real road (goal: the camera position, not the plan).

## What we know (measured, not re-run in the new home)

| Approach | What it is | Bavaria result | Weak point |
|---|---|---|---|
| App run 16:51 (shipped) | hint corridor 100 m + dense HMM (A1), bike paths on, full-frame fallback | covers **40 %** of komoot, partly backwards | the corridor still holds many wrong loops; wrong routes score 3–9 nats/km better than the truth (diagnosis §3) |
| Corridor 300 m, clip 2–20 min | same HMM, all path tiers, fixed calibration | 46–64 % of seconds within 30 m, median 2–62 m | only a clip; uncertain verdict |
| "Oracle" | HMM on a graph that is only the komoot loop | used as a stand-in for the truth | itself weak in minutes 0–70 (heading correlation −0.2…0.4) |
| **GPX prototype** (`work/gpx-align/align_gpx.py`) | monotone 1-D Viterbi along the GPX, penalty λ = 0.25 nats/m for every metre not covered, cut jumps 0.25 nats/m, scan f × κ × direction | covers **99 %** of komoot; f 200, κ 0.80, forward (κ matches the diagnosis); from 70 min on **12–16 m** median from the oracle | minutes 0–70 differ from the oracle by up to 1–2 km; it cannot leave the GPX, so a detour or another way is forced onto it |
| Prototype on a coarse 25-point hint routed on the map | same, but the "GPX" is a shortest-path route through 25 clicked points | covers 74 %, median 270 m from the oracle | only as good as the routed line |

**Which is most promising:** the GPX prototype. It is the only method that keeps the whole loop in order, and it lands on the right calibration without any tuning per video.
But for the first 70 minutes **nobody knows the truth yet**: the prototype and the oracle disagree, and the diagnosis left open whether that part is a heading misfit (camera looking around, mount) or a different route from the komoot plan.
**A model that can leave the GPX answers exactly that question**, so it comes first, together with real landmark times.

## The method: two stages

### Stage 1, GPX alignment with deviations (1-D, along the GPX)

The prototype's state is the position `s` on the GPX (2 m grid). It is extended by three moves, each with its own cost, so that every deviation is a visible, priced event and not hidden noise:

| Move | Meaning | Cost (start values, to be tuned on the synthetic bench) |
|---|---|---|
| ride | advance ≈ κ × nominal metres, heading emission against the GPX heading (as now) | as now |
| **skip** (GPX longer) | jump forward at any time, not only at cuts | λ_skip per skipped metre (start 0.25, like λ); at a detected cut λ_cut |
| **off-GPX** (GPX shorter) | a second state "off" at the exit point: video time runs, `s` stays; the heading is scored by a broad null model (Student-t, sd from the video's own heading noise) | μ per nominal metre ridden off the GPX, plus a fixed cost per excursion |
| **re-entry** | from "off" back onto the GPX at s' ≥ s − 50 m (out-and-back returns near the exit; another way re-enters further on and pays λ_skip for the gap) | computed like the cut jump (running max), O(N) per step |

Further:
- **Local stretch**: a slowly varying factor on κ (a random walk on log κ with 5 levels, ±10 %) shows where the GPX is a little longer or shorter than the ride without a skip or detour. Reported as a profile; it costs 5× the runtime, so it is an option to try, not the default.
- **Closed loops**: if the GPX ends within 200 m of its start, it is unrolled to 2 × L so the ride may start anywhere on it; the coverage penalty still counts each GPX metre once.
- **Direction**: both, as in the prototype (Bavaria: forward wins by about 1000 nats).
- **Calibration**: the prototype takes about 20 s per (f, κ, direction) cell, so a full 6 × 8 × 2 scan is about 30 min. Coarse to fine instead: κ 0.6–1.0 at three f values, then refine around the peak. Target under 5 min for a 2-hour video.

Output of stage 1: time → GPX position, f and κ, and a **deviation list**: skipped GPX stretches (km from–to, time), off-GPX excursions (time from–to, nominal length, exit and re-entry km), and the stretch profile.

### Stage 2, the real road (dense HMM in the GPX corridor)

Stage 1 only knows the GPX line. Stage 2 puts the route on the OSM roads and paths, and finds the roads of the excursions:

- **Map**: all road classes and bike-path tiers (bike) within 150 m of the GPX, plus, around every off-GPX excursion, a disc whose radius is half the excursion's nominal length (the rider cannot be further away). Cut only from the search frame, fitted to the memory cap as now.
- **Search**: the existing dense HMM (A1) at the stage-1 calibration (no wide scan; ±1 grid step for safety), with a **time-varying spatial prior**: at time t the cells within r(t) of GPX(s(t)) are allowed, r = 300 m on the GPX and the excursion disc during an excursion. This reuses the anchor mechanism (`dp.STEP_OK_HOOK`, `anchors.py`), which already applies per-step masks to every decode.
- Then the local pass (A4/A5), refine (A7/A8) and the GPX writer as today, so cuts, standstills and timing fixes keep working.

**Check between the stages**: where stage 2 runs more than 100 m from stage 1 for more than 30 s, that span is reported. If stage 2 cannot place an excursion on any road, the excursion is dropped and stage 1 is rerun without it (a fake detour that only absorbed heading noise).

### Verdict and report

- Confident only if the GPX coverage is ≥ 85 %, no single skip is > 2 km outside a cut, stage 1 and 2 agree, and the heading fit per 10-minute block is not far below the video's own level.
- The report lists every deviation in plain words, for example "Ab 23:10 weicht die Fahrt 1.2 km vom GPX ab (Umweg über …) und kommt bei km 18.4 zurück" or "km 12.1–13.0 des GPX wird nicht gefahren".

## Phases

### Phase 0: move and get truth (small)

1. Move `work/gpx-align/` and `work/bavaria-diag/` from the old repo (`Ridrs/video2gpx/research/route-shape-matching/work/`) into `research/route-shape-matching/work/` here (git-ignored). Rerun `k_c25` and check the result is identical.
2. **Landmark truth for Bavaria** (user task, about 30 min): 8–12 places with a known video time, set as Ortsangaben in the app, ideally checked in Street View: Mittenwald start, Isar bridge / Flößersteg (≈ 20:30), Krün, Wallgau (≈ 45 min), Barmsee, Klais railway (≈ 65 min), Geroldsee, Ferchensee and Lautersee (92–105 min), Mittenwald end. **At least four of them must fall in minutes 5–70**, where the methods disagree. I can propose candidate frames from the video first.
3. Evaluate the four existing results (app run, oracle, `k_c25`, `c25_c25`) against the landmarks. This alone tells us whether the prototype or the oracle is right in minutes 0–70.

#### Phase 0 results (17 Nov)

- Moved: `work/gpx-align/` and `work/bavaria-diag/` are now in this home's `research/route-shape-matching/work/`. A rerun of the best `k_c25` cell is identical (same score, path difference 0.0 m).
- **Landmarks from frames** (`work/gpx-align/landmarks.json`; frames in `work/bavaria-diag/lm/`): 11 places read from frames every 15–30 s and placed on komoot by OSM street names and surface changes (`landmarks_ways.txt`). They are estimates, not Street View checked.
  Examples: Obermarkt at 1:30 (km 0.25), the Flößersteg at 20:30 (km 9.25), the gravel ends at In Gerold at 62:15 (km 22.27), the paved path next to the railway at 63:30–67:45 (km 22.64–24.05), Klais at 68:30 (km 24.35).
- **Error against the landmarks** (komoot km, + = ahead of the truth):

  | Time | 1:30 | 5:45 | 9:30 | 10:00 | 20:30 | 41:45 | 48:00 | 62:15 | 63:30 | 67:45 | 68:30 |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | Prototype `k_c25` | +0.55 | +1.18 | +2.70 | +2.20 | −0.01 | −0.20 | −0.34 | −0.01 | +0.13 | +0.59 | +0.62 |
  | Prototype, cut jumps 0.05–0.1 nats/m, κ 0.75–0.8 | −0.05 | +0.09 | +2.40 | +1.92 | −0.01 | −0.20 | −0.33 | −0.02 | +0.13 | +0.59 | +0.62 |
  | Oracle | +2.04 | +2.18 | +3.16 | +2.65 | 0.00 | −0.33 | +0.23 | +1.23 | +1.29 | +1.27 | +1.19 |
  | App run 16:51 | +38 | +34 | +33 | +32 | +23 | +14 | +8.6 | +2.4 | +2.1 | +2.1 | +2.0 |

- **The prototype is right from 20 to 63 min; the oracle is not** (+1.2 km from 62 min on). The old landmark "Klais = km 24.5 at 65 min" came from the oracle and was wrong; `evaluate.py` now reads `landmarks.json`.
- **Minutes 0–10 are a cut problem: the GPX is longer than the video.** The pipeline now finds cuts at 8:41 (521.5 s, checked in the frames: the scene changes completely) and 10:15. Between them about 2 km of komoot are not in the video. With the cut jump at 0.25 nats/m the prototype cannot afford the jump, so it stretches the town part instead (+1.2 km at 5:45). With 0.05–0.1 nats/m it jumps at 8:41 and the landmarks at 1:30 and 5:45 fit.
- **Open, needs the user (Street View):** where the houses at 9:30 and the greenhouse at 9:45 are. Either Am Unteren Rain (km ≈ 2.65; the cut at 8:41 would then be short and the one at 10:15 long) or the asphalt bit at km ≈ 5.4 (47.473 N, 11.279 E; the cut at 8:41 drops about 2.5 km). The speed argues for km 5.4: from 10:30 to the Flößersteg it is then 5.8 m/s, otherwise 9.3 m/s. If it is km 5.4, the cheap-cut run fits every landmark except the railway path.
- **Second residual: 64–68 min, +0.6 km.** The prototype is too fast on the railway path after the cut at 63:08. A local distance scale (the stretch option of stage 1) is the candidate fix.

Consequences for Phase 1: (1) a cut jump must be cheap enough to skip 2–3 km, but the earlier runs showed that cheap cut jumps alone let κ run away. The scan therefore needs a κ anchor from the stretches between cuts (for example κ fitted on the long pieces only), or a flat jump up to a cap, as in A13. (2) The landmarks go into the synthetic bench as the Bavaria check.

**Update (17 Nov, user Street View check): the houses at 9:30 are at 47.453848, 11.275718, komoot km 2.58.** So the cut at 8:41 is short and the cut at 10:15 drops about 3 km of komoot (see the Phase 1 progress).

### Phase 1 progress (17 Nov, in progress)

Code: `work/gpx-align/align2.py` (stage 1 with an off-GPX state), `lm_eval2.py` (landmarks), outputs in `out2/`; landmark 9:30 corrected to km 2.58.
Bench data copied into `work/gpx-align/bench/<case>/`: tracks of the 15 Nov regress run, the Van Gestel GPS track, and the pipeline route as truth (Roanne, Pontaix, Grimone, Rousset). The rest of the old `work/` (regress, pipeline seeds) is still in the old repo.

1. **Off-GPX state works, after two fixes.** Without them it was a free way to wait (40+ short excursions): (a) an off step must pay the same expected advance log-probability as an on step (the entropy of the advance distribution, about 1 nat per step); (b) going back on re-entry costs λ per metre too. With exit + entry costs of 40 nats it leaves Bavaria's GPX only at the very end (last 27 s, 163 m), and with 20 nats in 6 places (100–190 m). There is no real detour on this ride, so the bench has to show that real ones are found.
2. **The scale was wrong, not the cut cost alone.** Between landmarks without a cut, the GPX covers **0.53–0.88 m per nominal video metre (median about 0.64)**, not the 0.8 every scan chose. The only ratio above 1 is across the cut at 10:15: at a scale of 0.64 it drops **about 3.2 km** of komoot. The κ 0.75–0.8 of 13 Nov came from a clip analysis that assumed the clip starts at km 3.21; it starts at about km 0.4.
3. **Free cut jumps let κ run away** (scores rise by about 400 nats per 0.05 lower κ down to 0.55): low κ plus jumps picks the best-fitting pieces of the GPX. Cut jumps need a cost, and κ needs an anchor that does not come from the same score.
4. **The local scale varies along the ride (0.53–0.88), and a global κ pushes the difference into the cuts.** At every global κ with cut costs of 0.05–0.1, two jumps are wrong: 8:41 (0.8 km) and 63:08 (2.4–2.7 km, truth about 0).
   Upper-bound test with the landmark ratios as a κ(t) profile (uses the truth, only tests the idea), cut cost 0.25: 62–68 min fits (+0.12…+0.18 km), and the 3.4 km skip is found, but at 8:41 instead of 10:15. The 94 s between the two cuts stay ambiguous for a heading-only model.

| Run (Bavaria, f 200) | Landmark errors in km (1:30 … 68:30) |
|---|---|
| prototype `k_c25`, κ 0.80 | +0.55 +1.18 **+2.77 +2.77** −0.01 −0.20 −0.34 −0.01 +0.13 +0.59 +0.62 |
| free cuts, κ 0.65 | 0.00 −0.26 +0.85 +0.82 −0.01 −0.20 −0.33 −0.02 **+2.67 +2.30 +2.17** |
| true κ(t) profile, cut cost 0.25 | 0.00 −0.26 **+3.45 +3.49** −0.01 −0.20 −0.33 −0.02 +0.12 +0.14 +0.18 |

**Correction after the bench measurement (same day).** `scale_bench.py` measures pipeline-route metres per nominal metre on the bench, per 0.5–2 km without gaps. Roanne 1.01 (±3 %), Pontaix 1.03 (±3 %), Grimone 0.81 (±5 %), Rousset 1.05, drifting slowly from 0.97 to 1.21. Neighbouring kilometres differ by 1–2 %. So **the scale is nearly constant within a video**, and point 4 above was wrong: most Bavaria landmark intervals contain cuts, and skips raise the ratio. The two uncut intervals give 0.63 and 0.68, and the "true profile" test was biased by the same effect.

**κ anchor from the pieces between cuts** (`kappa_pieces.py`): each piece of ≥ 240 s is aligned on its own (free start and end, no coverage penalty), with κ scanned.
- On Bavaria, the long pieces that land where the landmarks say give κ 0.55–0.65; the short ones (< 3.5 km nominal) give 0.95–1.0 and land in the wrong place.
- Length-weighted median **0.60**.

Full run (cut cost 0.25, exit/entry 40, f 200) at fixed κ:

| κ | 0.60 | 0.62 | 0.65 | 0.68 | 0.70 | 0.75 | 0.80 |
|---|---|---|---|---|---|---|---|
| score | 41439 | 41511 | **41530** | 41485 | 41507 | 41796 | 41826 |
| landmarks wrong by > 0.4 km | 3 (63–68 min +2.2…2.7) | 3 | **2** | 2 | 4 | – | 4 |

At κ 0.62–0.68 every landmark is within 0.33 km except 9:30 and 10:00 (+0.85 km). Those two are the ambiguity between the cuts at 8:41 and 10:15: the model skips 0.8 + 2.7 km where the truth is about 0.1 + 3.3 km. The skips inside cuts are found: 10:15 → 2.7 km, 33:22 → 1.0 km, 51:55 → 0.2 km.
**Recipe that works on Bavaria without truth:** κ anchor from the pieces, then the full model scanned within ±15 % of it (0.51–0.69), which picks 0.65. It is fragile (0.60 and 0.70 fail), so the bench must show that the anchor holds on other videos.

**κ anchor on the bench (18 Nov).** `kappa_pieces.py` now scans f (300/380/460) and can cut a video into pieces of a given length, because the bench videos have no cuts. Logs are in `out3/`; the full runs go to `out2/bench_<case>*`, scored by `bench_eval.py` against the pipeline route at the same second.

| Video | true κ | anchor, whole video | anchor, 600 s pieces | full model, ±15 % window: best κ | median / p90 error | > 200 m |
|---|---|---|---|---|---|---|
| Roanne | 1.01 | 1.00 | 1.05 | 1.00 | 4 / 9 m | 0 |
| Pontaix | 1.03 | 1.05 | 1.05 | 1.05 | 6 / 12 m | 0 |
| Grimone | 0.81 | 0.90 | 0.90 | 0.90 | 8 / 30 m | 0 (max 130 m) |
| Rousset | ≈1.05 | 1.10 | 1.05 | 1.10 | 5 / 14 m | 0.9 % (*) |

- The anchor is within 5 % of the truth on three videos and 11 % high on Grimone. The truth lies inside the ±15 % window on all four. In the 600 s pieces, one Grimone piece lands in the wrong place (κ 0.55), and the weighted median ignores it. On Rousset the pieces follow the slow drift (1.20 in the middle).
- (*) The last 90 s of Rousset are a truth error, not a model error. The GPS track has one fix per video second, and the model matches it there within 20 m, up to the GPX end at km 49.0. The pipeline route instead turns back to km 47.3. **The pipeline's route end on Rousset is wrong**, which is worth a look in the pipeline.
- **Limit of this test:** without cuts, κ hardly changes the position. Every κ in the window gives the same errors to the metre, so the bench confirms the anchor and the on-GPX accuracy, but not the cut skips that make Bavaria fragile. That needs cuts with known skips: drop spans of known length from the bench videos (a synthetic-cut bench).
- **f is biased low:** the score prefers the lowest f tried (300) on three videos, while the bench f_eff is 355–460. The position does not suffer, but f cannot be read from this score.

**Synthetic-cut bench (18 Nov).** `synth_cuts.py` removes spans of known GPX length from the bench tracks, as an edit would: the video time closes up and the next frame is marked as a cut. Truth is the GPS fix at the original second, which lines up within 0–2 s on all four videos. Variants: "spread" (skips of 0.1 / 0.5 / 1.0 / 3.0 km, evenly spaced) and "pair" (0.1 km, then 94 s of video, then 3.0 km, as at Bavaria's 8:41/10:15, later 1.0 km). The runner is `out3/run_cuts*.sh`, the scorer `cut_eval.py`, and the summaries are `out3/cut_summary*.log`.
- **The κ estimate holds with cuts:** 1.00–1.05 on Roanne and Pontaix, 0.90 on Grimone (true 0.81), 1.05–1.15 on Rousset.
- **The pieces alone find the skips:** the gap between a piece's end and the next piece's start is within 0.01–0.1 km of the truth. Exceptions are one wrong Grimone piece (κ 0.55), and in "pair" the 94 s piece, which is too short and so is counted into the gap.
- **The full model at cut cost 0.25 does not:** it misses most skips of 1–3 km (Grimone finds 0.02 of 3.0 km), pushes κ to the top of the window and stretches the ride, with up to 41 % of seconds more than 200 m off. Only Rousset passes.
- **At cut cost 0.02 or 0.05 (the same results):**
  - Roanne and Rousset are right in both variants (skips within 0.1 km, nothing more than 200 m off).
  - Pontaix "spread" is right.
  - Pontaix and Grimone "pair" split the 3.1 km between the two close cuts wrongly (1.16 + 2.04 km), the same failure as on Bavaria.
  - Grimone "spread" misses about 0.3–0.6 km per skip, because κ 0.925 is 14 % above the truth. With cuts, a κ error turns directly into skip errors.

**Bavaria pulls the other way.** At cut costs ≤ 0.15, the last three landmarks (63:30–68:30) are 1.8–2.7 km off: the model jumps 2.74 km at the 63:08 cut. At 0.25 that cut skips only 0.15 km, and the landmarks are right. Instead the model leaves and re-enters the GPX at **71:29, 1.6 km further along (km 25.42 → 27.03), where no cut was detected**. So something advances the ride by about 1.6 km between 68:30 and 72:00: a cut the detector missed, or a komoot stretch that was not ridden. With a low cut cost the model puts this advance on the nearest cut, 63:08. Coordinates to check: model at 71:00 = 47.476985, 11.237301 (km 25.30); at 72:00 = 47.471155, 11.216580 (km 27.16). Komoot in between: km 26.0 = 47.47511, 11.229796.

**71:29 settled (user, 18 Nov): a missed cross-fade cut.** 71:00 = 47.476991, 11.237311 (km 25.30), 72:00 = 47.471093, 11.216462 (km 27.17), both added to `landmarks.json`. Between them the video cross-fades in about 1 s (71:25.5–71:26.4; the blend weight goes 0.17 → 0.73) from a parking area to a forest road 1.5 km away. The biggest frame-to-frame change there is only 2× the median, so the impulse-based cut detector misses it. A background research task on fade detection is in `work/fade-detect/`.

With the fade added as a cut (`bavaria_tracks_fade.pkl`), the piece estimate is κ 0.65 and the 71:26 skip comes out at 1.6 km, so 71:00 and 72:00 are within 0.01 km. **The full model's score does not identify κ**: inside the window it runs to an edge (0.575 at cut cost 0.05, 0.725 at 0.25, where the start goes 0.8–2.8 km wrong). So κ has to be fixed to the piece estimate.

At κ fixed to the piece estimate (`out2/bav_fade_*`, `out2/cut_*`), errors in km:

| Case | cut cost 0.25 | 0.05 | 0 |
|---|---|---|---|
| Bavaria + fade, κ 0.65 | all landmarks ≤ 0.33 km except 8:41/10:15 (+0.85) | 63:30–68:30 +0.6 / +0.26 / +0.13 (0.6 km false skip at 63:08) | not run |
| Roanne, Pontaix "spread", Roanne "pair", Rousset "pair" | pass | pass | pass |
| Rousset "spread" | 3.0 km skip missed | pass | pass |
| Grimone "spread" (κ 11 % high) | 37 % > 200 m | 6 % | **1.3 %** |
| Grimone "pair" | 30 % | 11 % | **0 %** |
| Pontaix "pair" | **0.1 %** | 5 % (0.1 + 3.0 split as 1.15 + 2.04) | 5 % |

No single cut cost passes everything. A high cost resists false skips but cannot absorb a κ error. A low cost absorbs the κ error but lets two close cuts share the skip wrongly. The piece alignments are more reliable than either: their gaps give the skips within 0.1 km on every case with correct pieces.

**Proposed method change:** the long pieces (≥ 240 s, each aligned on its own) fix both κ and the GPX position of their ends. The full model then only links them: the short pieces in between, the transitions, and off-GPX spans. It keeps each long piece within a corridor of about ±150 m around its own alignment, with a low cut cost. A long piece whose own κ is far from the median (such as Grimone's 0.55) is treated as unreliable and left free.

**Fade detection, first prototype (18 Nov, `work/fade-detect/`).** Method:
- `scan.py` decodes the video once, at 256×144 and 25 fps on the hardware decoder.
- Feature-track survival: ORB corners matched across 0.2, 0.4, 0.8 and 1.6 s with RANSAC. A fade loses the scene across 0.8 s (0 inliers against a median of 46) while every 0.2 s pair inside the fade still keeps 28–39.
- Plus a check that the change follows the straight blend line between the frames before and after.

The frame differences that motion.csv already stores cannot show a fade: at 71:26 they are 1.3× the median, which is normal riding.

Results:
- **Bavaria:** the 71:26 fade is found, and all detected hard cuts are classed as hard. There is one new hard-cut candidate, 13:30.4. There are 16 further fade candidates, but frame strips show 14 of them as continuous riding (an underpass, cyclists passing, turns). At 13:30.4 and 41:38.6 the blend weight rises gradually, like normal motion. The real fade shows a step instead: flat at 0.12–0.17, then 0.49 → 0.75 within 1 s, then flat.
- **Roanne (no cuts):** 7 false fades in 44 min (≈ 9.5 per hour; 31 % too low in texture to judge).
- **Pontaix (no cuts):** 11 false fades and 1 false hard cut in 44 min (≈ 16 per hour).
- **Runtime:** 4K AV1 decodes at ≈ 3× real time, 720p at ≈ 14×. The bench run is still going (Pontaix, Grimone, Rousset, Amalfi; `cache/bench.log`).

**Tightened (18 Nov, same day):** two real fades and 0 false positives on 6 videos (9.9 h).

Chain:
1. Survival and blend line as above.
2. Texture: the median of the 0.8 s inliers is at least 30.
3. Step shape of the blend weight (`fade2.py`): step ≥ 0.45, fit rms ≤ 0.08, drift in the flats ≤ 0.12 per s. There is no ramp-length limit: a 1.3 s limit had rejected the real Rousset fade, whose ramp is about 1.5 s.
4. A 640 px check of each survivor. Frames A (before) and B (after) must share almost nothing: A–B ≤ 12 and ≤ 15 % of a riding control taken over the same span, and the control must be ≥ 30.

The middle-frame part of step 4 needed a decision. `verify.py`, the agent's version, asks for a middle frame matching both sides and a control ≥ 60. That is fragile: its closest false candidates sit at a control of 44 and 55. `verify2.py`, mine, tests a **handover** instead, counting the frames between A and B that match both A and B with ≥ 5 inliers each:
- the real fades have 0 (Bavaria) and 4 (Rousset);
- every false candidate has 8–25.

At 640 px SIFT follows the stronger scene of a blend: at Bavaria 71:26 the matches to A fall 615 → 41 → 0 while those to B rise 0 → 19 → 381.

| Video | Fade candidates | After the cheap checks | After the 640 px check |
|---|---|---|---|
| Bavaria 1.9 h | 17 | 2 | **1, the real fade at 71:26** |
| Roanne 0.7 h | 7 | 2 | 0 |
| Pontaix 0.7 h | 11 | 3 | 0 |
| Grimone 1.4 h | 19 | 2 | 0 |
| Rousset 2.6 h | 24 | 3 | **1, a real fade at 1:21:48** (a viewpoint dissolving into a car park; the rider stood still, so there is no route skip) |
| Amalfi 2.1 h (720p copy; the 4K HDR file is 10-bit) | 7 | 3 | 0 |

- **Caveat:** only two real fades. The closest false candidate under the handover rule is Bavaria 68:09, with 8 shared frames against a limit of 4 (riding from shade into bright sun next to a hut).
- **Cost:** a separate low-resolution decode, at 3× real time for 4K and about 8–14× for 720p. Inside the vms pass, survival would add about 1 min per hour of video: ORB matches across 0.8 and 1.6 s, as new `motion.csv` columns. The 640 px check takes seconds per candidate and would sit next to the same-scene veto.
- **For `plan()`:** cut time = middle of the ramp, and the ramp span is bridged like a hard cut.
- **Test windows:** Bavaria 4270–4300 and Rousset 4900–4915 (fades); Pontaix 885–895, Roanne 500–515 and Bavaria 4080–4100 (no fades).

The earlier notes on what still needed a stricter check:
- the step shape of the blend weight (flat, ramp of ≤ 1.5 s, flat);
- a well-textured stretch around the candidate;
- a sharper match: the frames before and after the fade must not match each other, while a middle frame matches both.

**Piece-anchored model, tested (18 Nov): no gain.** `piece_anchor.py` (with an optional per-observation corridor in `align2.viterbi`):
- κ0 and f0 come from the pieces;
- each long piece whose own κ is within 15 % of κ0 is held within ±150 m of its own alignment;
- a low cut cost links everything.

Results on all 8 cut cases are identical to the plain fixed-κ runs at cut cost 0.05, because the free model already followed the pieces. On Bavaria (with the fade cut) it is identical too: cut cost 0.25 gets every landmark within 0.33 km except 8:41/10:15, while 0.05 keeps the false 0.6 km skip at 63:08. On Bavaria the pieces' own κ splits into two groups (0.55–0.65 and about 1.0), so only 3 of 12 count as reliable, yet at κ0 0.65 the "1.0" pieces also land where the landmarks say. **The anchors are dropped; κ0 from the pieces stays.**

**Ambiguity report (`ambiguity.py`), useful.** For the ride between two reliable pieces that contains cuts, it scores every end position of the stretch before the last cut, and gives the range within 3 nats of the best:
- Pontaix "pair": km 6.11–9.04, truth 6.29. Correctly flagged as ambiguous (2.9 km wide), while the model picked 7.26.
- Roanne "pair": 6.67–6.69, truth 6.67. Rousset "pair": 8.48–8.50, truth 8.48. Both confident and right.
- Grimone "pair": 10.57–10.72, truth 9.75. **Confident and wrong**, because κ0 0.90 is 11 % above the true 0.81: the anchor itself ends 0.7 km too far along.

So with a correct κ the model is either right or reports that it is unsure; with a biased κ it is confidently wrong.

**The remaining lever is κ accuracy.** Piece κ against the truth:
- Roanne 1.00–1.05 (1.01), Pontaix 1.00–1.05 (1.03), Rousset 1.05–1.15 (≈1.05, drifting);
- Bavaria 0.65 (0.63–0.68 from uncut landmark intervals);
- **Grimone 0.90 (0.81)**.

Why the heading fit prefers a 10 % longer advance on Grimone (a climb with hairpins) is the next question.

**Next in Phase 1:**
- (0) the Grimone κ bias: compare piece κ against the truth per piece, look at where the extra GPX length goes (hairpins cut short, speed), and test a κ estimate from the turn timing (turn quanta) instead of the heading fit;
- (0z, dropped) the piece-anchored full model above on the cut bench and on Bavaria with the fade cut;
- (0a, done) settle 71:29 with a landmark at 71:00 and 72:00. If there is a missed cut, the cut detector needs a look, and a low cut cost (0.05) plus the κ window is the recipe. If komoot has an unridden stretch, the off-GPX state found a real deviation;
- (0b) close cuts: place a piece that is too short for its own κ in the gap between its neighbours;
- (a) estimate the local scale without the truth: κ levels as a state (3–5 levels of ±15 %, a switching cost, a 4 m grid for memory), or a second pass with a smoothed κ(t) from the first;
- (b) the edited-GPX bench (removed, added and swapped stretches) on Roanne, Pontaix, Grimone and Rousset, to tune the exit/entry costs and check that real detours are found;
- (c) the map page.

### Phase 1: stage 1 with deviations (prototype, research only)

1. Add skip, off-GPX and re-entry to `align_gpx.py`; coarse-to-fine scan; loop unrolling.
2. **Synthetic deviation bench** on videos with GPS truth (Roanne, Pontaix, Grimone; Amalfi has no GPS, it serves as a no-deviation check against its accepted result). The GPS track without timestamps is the "plan"; then edit it:
   - remove 0.5 / 1 / 2 km (the ride has a detour the GPX lacks);
   - add an out-and-back spur of 0.5 / 1.5 km (the GPX is longer);
   - replace 1 km with a parallel road from OSM (another way);
   - stretch or shrink 2 km by ±5 % (rough geometry);
   - simplify the whole line to 50 m and shift it by 15 m (a hand-drawn line).
3. Tune λ_skip, μ and the excursion cost on that bench only, then run Bavaria with the komoot GPX and the coarse 25-point hint.
4. Map page as before (memory rule: turn quanta on every route-shape map), now with the deviations drawn.

**Gate 1 (go/no-go for stage 2):**
- every synthetic deviation ≥ 300 m is found, with its place within 100 m;
- no fake deviation > 300 m on the unedited GPS tracks;
- Bavaria: the landmarks within 100 m or 15 s.

If Bavaria fails but the bench passes, the misfit in minutes 0–70 is not a route deviation. Then the next step is heading quality (camera yaw against path), not the GPX matching.

### Phase 2: stage 2 (prototype, research only)

1. Build the corridor plus excursion discs from the full-frame graph (`map/graph_real.npz`, `edges_full.npy`, all tiers).
2. Run the pipeline's HMM functions directly with the time-varying masks (as the diagnosis did), then refine.
3. Bench: the same synthetic cases. Metrics: along-track and cross-track error against GPS, the share of seconds within 30 m, and the landmark error on Bavaria. Compare with the shipped hint corridor on the same inputs.

**Gate 2 (go/no-go for the pipeline):**
- unedited GPS tracks as the "plan": along-track error no worse than the current pipeline (Roanne 3.6 m, Pontaix 9.6–13.9 m);
- edited tracks: ≥ 90 % of seconds within 30 m;
- Bavaria confident, with the landmarks met.

### Phase 3: pipeline

- Back up to `work/pipeline_backup_<date>_gpx-match/`.
- New module `rsm/pipeline/gpxmatch.py` (stage 1 and the masks for stage 2). New run option `--hint-mode corridor|follow` (default `corridor`, so the default runs are unchanged). `follow` runs stage 1 at the start of route_search and stage 2 in place of the corridor scan.
- Config constants for λ, λ_skip, μ, the radii and the scan, with a hash token for route_search. New event and status lines (`gpx_match`, the deviation list in the result JSON).
- Tests in `tests/test_pipeline.py`: synthetic GPX with a known skip and detour; loop start; reverse direction; a cut inside a skip.
- Run pytest, re-freeze (`.venv/bin/python -m rsm.pipeline.freeze`), update `PIPELINE_CLI.md`, add DECISIONS A19 and a HISTORY line.
- Regress bench (Roanne, Pontaix, Grimone, Rousset, Amalfi) **without** a hint: must stay byte-identical. Heavy jobs only through `scripts/guard.sh`, ≤ 4 workers, one at a time.

### Phase 4: app

- Hint dialog: a choice "Die Fahrt folgt dieser Strecke weitgehend (GPX-Abgleich)" next to today's "nur Suchkorridor". `follow` is the proposed choice when the file is a track longer than 5 km.
- Result view: the deviations on the map (a skipped GPX part dashed grey, an excursion orange) and as a list under the timeline. A click spools the video to that time, as the Ortsangaben do.
- Status light from the verdict above. Build the sidecar and the app only when the app is closed.

## Risks

- **The excursions absorb heading noise.** In the misfitting minutes, the off-GPX state may "explain" bad headings with fake detours. Countermeasure: a fixed cost per excursion, the stage-2 road check, and μ tuned on the bench, not on Bavaria.
- **The GPX is really far off** (a 25-point hint, a hand drawing). Stage 1 then gives a coarse order only. The coarse-hint run already showed this (74 %, median 270 m). Stage 2's radius has to grow with the hint's resolution (point spacing).
- **Runtime and memory**: stage 1 is light (1-D). Stage 2 on a corridor with all path tiers is smaller than the full frame; excursion discs can grow it. Stays under the HMM memory cap or the disc is clipped, and that is reported.
- **Two truths for minutes 0–70.** Without the landmarks from Phase 0 every comparison is against the oracle, which is itself weak there. Phase 0 is therefore not optional.
