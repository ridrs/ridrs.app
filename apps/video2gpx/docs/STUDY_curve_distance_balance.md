# Study: curve errors against the distance factor (2026-11-21)

Ran on branch `exp/v2g-balance` (removed after the study; its study knobs, drivers in `work/study/` and variant stages were not kept). The
code changes were study knobs (below). The study asks where the balance should sit between what the route side takes from the curves (heading / turns) and what it
takes from the distance (scale factor kappa, the drift of rho, the horizon row of the road-flow fit that sets the speed).

## Short answer

- **A24 (running horizon) costs Pontaix, the bike case with verified truth, a lot, and buys almost nothing on Sa Calobra.** With the horizon row fixed
  (`HZ_FOLLOW = 0`, variant A) Pontaix goes from along 3.6 / 16.8 m (≤ 10 m 76 %) back to 1.7 / 5.3 m (≤ 10 m 100 %), better than before A24
  (t2base 2.2 / 5.4 m). In T3, pontaix-10m goes from 18.3 / 37.6 m to 7.2 / 29.4 m. Sa Calobra (motorcycle) is the same either way (2.1 / 6.0 m).
- **But A24 is what holds Gotthard.** Without it Gotthard's checkpoints get worse (T2 max 31 → 42 m; T3 max 33 → 84 m, which fails the T3 check of
  70 m, and the parity speed ratio 0.954 fails its 0.96).
- **Recommendation: variant B, A24 only for car and motorcycle** (fixed row for the bike). Composed from the runs above, B keeps every gain of A on the
  bike cases and every result of the base on the motor cases, T3 included. It needs one design decision (the vehicle has to be known before the
  road-flow fit, see "Open points").
- **The route-side weights (D) are not the lever.** None of them moves both verified cases the same way; the defaults stay.

## Method

### Selection: first sieve, then check (maintainer, 2026-11-21)

1. **Pre-selection.** Every variant first runs T2 only on the two verified cases, Pontaix (bike, verified track) and Sa Calobra (motorcycle-scale,
   steep serpentines, verified track): `--only pontaix,sacalobra`.
2. **Final selection.** Only the 2-3 best variants then run on all cases and through T3.

The route-side variants D and variant A had already run on all cases before this rule was set (first agent of the study); those runs are used, not
repeated. C (`hz05`) and the combination A+D (`hz0` + `q_rho` × 2) ran only the pre-selection first. The final selection is base, A, B (composed,
no own run) and the combination A+`q_rho`×2 (one cheap full T2: route side only); T3 for base and A (B's T3 is composed from them, see below).

### Rules

- Every heavy job through `scripts/heavy.sh`, one at a time; step cache (`work/regress/_cache`), keys follow the study knobs.
- The shared stages `test-data/stages` are never written. Variant stage sets live in `work/vstages/<name>` (`base`: copy of the shared stages rekeyed
  to the study code, knobs at their defaults; `hz0`, `hz05`: copies re-interpreted from the stored extraction under the knob, `ST.reinterp`).
- Truth: Pontaix and Sa Calobra are the verified tracks (scored along / across the road); Gotthard checkpoints and Madone landmarks are checks; the
  Van Gestel tracks (Roanne, Rousset, Grimone, CdP, Pennes) are coarse and used only as a do-no-harm check, never to choose.
- Sa Calobra: patch of the v2g-extraction worktree applied (source-free stage, `adopt`, case `sacalobra`, inexact ranges left out of the score),
  inexact range **[1010, 1040] s** (maintainer 2026-11-21: track good up to 1009.8 s and again from 1040.3 s). The base run reproduces the reference
  `sacal1` of v2g-extraction exactly: confident, kappa 1.51, road 98.5 %, along 2.09 / 6.05 m, ≤ 10 m 96 %, off road 164-168, 1000-1009,
  1041-1058 s. Sa Calobra's stage in each variant set was adopted from the app run (`ST.adopt`, image side under the variant's knob).
- References: `t2base` (main, before A21-A24), `p5t2` (phase 5, A24 on, the stages the base set comes from), `sacal1` (v2g-extraction).
- Cell format of the tables: verdict, kappa, f_eff · on-road share, place median / p90 (coarse truth) or **along median / p90, share ≤ 10 m**
  (verified truth) · checkpoints ok, median / max · landmarks mean / max |dt|.

### Code changes behind the variants

| knob | file | what it does | default |
|---|---|---|---|
| `HZ_FOLLOW` | `rsm/pipeline/config.py`, used in `vmsx/motion.py:running_horizon` | share of the running horizon's deviation from the calibrated row that the road-flow fit follows. 1 = A24, 0 = fixed row (before A24), 0.5 = damped | 1.0 |
| `FUSE_Q_RHO` | `config.py`, passed in `steps_c.fuse` to `rts.FuseParams(q_rho=...)` | drift of the distance factor rho per sqrt(map metre) | 2.5e-3 (the old built-in value) |
| `FUSE_RHO0_SD` | same, `rho0_sd` | prior sd of rho around kappa | 0.2 (built-in value) |
| `RSM_CFG_OVERRIDE` | end of `config.py` | JSON env var that replaces config values for one process, so the bench step keys follow | – |

`ALIGN_POST_INFL` (A20 posterior pin strength, 1.5) and `ALIGN_MEAS_MODE` (`turns` = old baseline) existed already and are set through the override.
Drivers in `work/study/` (`t2v.py`, `t3v.py`, `reinterp_variant.py`, `adopt_sac.py`, `compare.py`, `batch*.sh`). With all knobs at their defaults
the code gives the same steps as main (checked: the base set rekeyed without change, `s0base` = `p5t2` on every case).

| variant | override | tag (T2) | T3 tag |
|---|---|---|---|
| base | – | `s0base` | `t3s0base` |
| A: A24 off | `HZ_FOLLOW=0` | `shz0` | `t3hz0` |
| B: A24 only car / motorcycle | composed: bike cases from `shz0`, motorcycle cases from `s0base` (the route search picks bike for Roanne, Pontaix, Rousset, Grimone, CdP, Pennes; motorcycle for Lahntal, Marburg, Madone, Gotthard, Amalfi, Sa Calobra) | – | composed |
| C: A24 damped | `HZ_FOLLOW=0.5` | `shz05` (pre-selection only) | – |
| D turns | `ALIGN_MEAS_MODE=turns` | `sDturns` | – |
| D pin ×2 | `ALIGN_POST_INFL=3.0` | `sDinfl3` | – |
| D drift ½ | `FUSE_Q_RHO=0.00125` | `sDqrho05` | – |
| D drift ×2 | `FUSE_Q_RHO=0.005` | `sDqrho2` | – |
| D kappa prior tighter | `FUSE_RHO0_SD=0.1` | `sDrho01` | – |
| A + D drift ×2 | `HZ_FOLLOW=0`, `FUSE_Q_RHO=0.005` | `sAhz0qrho2` | – |
| E: DEM-grade covariate | not built (see open points) | – | – |

## Results

### Pre-selection: the two verified cases

| variant | Pontaix (bike) along median / p90, ≤ 10 m | verdict | Sa Calobra (motorcycle) along median / p90, ≤ 10 m | verdict |
|---|---|---|---|---|
| t2base (before A24) | 2.2 / 5.4 m, 100 % | confident | – | – |
| sacal1 (reference) | – | – | 2.09 / 6.0 m, 96 % | confident |
| **base** (A24 on) | 3.60 / 16.8 m, 76 % | confident | 2.09 / 6.05 m, 96.5 % | confident |
| **A** A24 off | **1.72 / 5.35 m, 99.7 %** | uncertain¹ | 2.08 / 5.92 m, 95.5 % | uncertain¹ |
| **B** A24 car/moto only | **1.72 / 5.35 m, 99.7 %** | uncertain¹ | 2.09 / 6.05 m, 96.5 % | confident |
| C A24 damped (0.5) | 2.45 / 18.7 m, 85 %, off road 1140-1144 s | confident | 1.86 / 4.94 m, 96.5 % | confident |
| D turns | 4.85 / 14.6 m, 79 % | confident | 2.09 / 6.05 m, 96.5 % | confident |
| D pin ×2 | 3.4 / 15.5 m, 77 % | confident | 2.09 / 6.05 m, 96.5 % | confident |
| D drift ½ | 3.54 / 13.2 m, 81 % | confident | 2.86 / 8.02 m, 92 % | confident |
| D drift ×2 | 3.79 / 18.9 m, 74 % | confident | **1.77 / 4.92 m, 97.6 %** | confident |
| D kappa prior 0.1 | 3.6 / 16.9 m, 76 % | confident | 2.09 / 6.05 m, 96.5 % | confident |
| A + D drift ×2 | 2.09 / 7.42 m, 97.5 % | uncertain¹ | 1.87 / 4.86 m, 97.0 % | uncertain¹ |

On-road share is 100 % on Pontaix and 98.5 % on Sa Calobra in every variant except C (Pontaix 1140-1144 s off road); the Sa Calobra off-road
seconds (164-168, 1000-1009, 1041-1058 s) are the same in every variant: they come from the route at the turn and the cut, not from the balance.

¹ The only failing verdict signal is the share of time with posterior below 0.5: Pontaix 5.04 %, Sa Calobra 5.32 % against the limit 5 %
(`NODECOY.below_half`; base: 3.3 % and 4.6 %). The calibration peak (9.0 and 15.3 nats/km), the mean posterior (0.95) and the heading noise are all
in the confident range. The verdict flips on a threshold edge, the positions get better or stay the same.

Where A24 costs Pontaix (along error |s − s_gps| per 5 min, median / p90 in m):

| min | 0 | 5 | 10 | 15 | 20 | 25 | 30 | 35 | 40 |
|---|---|---|---|---|---|---|---|---|---|
| base (A24) | 16 / 28 | 7 / 15 | 13 / 17 | 9 / 18 | 4 / 9 | 2 / 4 | 1 / 3 | 1 / 3 | 2 / 5 |
| A (fixed row) | 1 / 3 | 6 / 9 | 2 / 4 | 1 / 3 | 3 / 7 | 1 / 3 | 1 / 3 | 1 / 3 | 2 / 4 |

The loss is in the first 20 minutes (the valley start), not at 30:00-34:00, where A24's decision recorded its known cost (DECISIONS A24).

Ranking for the final selection: A and B (Pontaix p90 5.3 m, Sa Calobra unchanged), then A + D drift ×2 (both cases good, Pontaix worse than A).
C trades a Pontaix tail (p90 18.7 m and an off-road stretch) for a small Sa Calobra gain and is out. No D variant improves Pontaix's p90 below 13 m;
drift ×2 is the best on Sa Calobra and the worst on Pontaix, drift ½ the reverse.

### Final selection: all T2 cases

| case | t2base | p5t2 | base `s0base` | A `shz0` | A + drift ×2 `sAhz0qrho2` |
|---|---|---|---|---|---|
| roanne | conf k0.99 f423 · 100% 3.0/5.8 | conf k0.99 f423 · 100% 3.0/5.8 | conf k0.99 f423 · 100% 3.0/5.8 | conf k0.99 f423 · 100% 3.0/5.8 | conf k0.99 f423 · 100% 2.9/5.7 |
| pontaix | conf k1.06 f423 · **2.2/5.4 m, 100%** | conf k0.99 f423 · **3.6/16.8 m, 76%** | conf k0.99 f423 · **3.6/16.8 m, 76%** | unce k1.06 f389 · **1.7/5.3 m, 100%** | unce k1.06 f389 · **2.1/7.4 m, 97%** |
| rousset | conf k1.06 f461 · 100% 1.9/4.1 | conf k1.06 f461 · 100% 1.9/4.1 | conf k1.06 f461 · 100% 1.9/4.1 | conf k1.06 f461 · 100% 1.9/4.1 | conf k1.06 f461 · 100% 1.9/4.1 |
| grimone | conf k0.80 f355 · 99% 2.0/5.7 | conf k0.80 f355 · 99% 2.0/5.8 | conf k0.80 f355 · 99% 2.0/5.8 | conf k0.80 f355 · 99% 2.0/5.8 | conf k0.80 f355 · 99% 2.0/5.7 |
| cdp | conf k1.06 f504 · 100% 1.9/5.0 | conf k1.06 f504 · 98% 1.9/5.4 | conf k1.06 f504 · 98% 1.9/5.4 | conf k1.06 f504 · 99% 1.9/5.0 | conf k1.06 f504 · 99% 1.9/5.0 |
| pennes | conf k1.06 f504 · 100% 1.6/4.4 | conf k1.06 f463 · 100% 1.6/4.4 | conf k1.06 f463 · 100% 1.6/4.4 | conf k1.06 f463 · 100% 1.6/4.4 | conf k1.06 f463 · 100% 1.6/4.4 |
| lahntal-marburg | no_route | no_route | no_route | no_route | no_route |
| marburg-lahntal | no_route k1.31 | no_route k2.64 | no_route k2.64 | no_route k1.31 | no_route k1.31 |
| madone-start | unce k1.86 f461 · lm 4.0/8.2 s | conf k1.73 f423 · lm 4.0/8.6 s | conf k1.73 f423 · lm 4.0/8.6 s | conf k1.73 f424 · lm 4.1/8.3 s | conf k1.73 f424 · lm 4.0/8.6 s |
| madone-nohint | unce k1.86 f461 | conf k1.73 f423 | conf k1.73 f423 | conf k1.73 f424 | conf k1.73 f424 |
| gotthard-start | unce k1.73 f298 · cp 10/10 18/62 m | unce k1.86 f325 · cp 10/10 12/31 m | unce k1.86 f325 · cp 10/10 12/31 m | unce k1.62 f325 · cp 10/10 13/**42** m | unce k1.62 f325 · cp 10/10 13/35 m |
| amalfi | conf k0.99 f355 | conf k0.99 f355 | conf k0.99 f355 | conf k0.99 f355 | conf k0.99 f355 |
| rousset-end | unce k1.06 f176 · 100% 3.5/4.9 | unce k1.06 f193 · 100% 3.5/4.8 | unce k1.06 f193 · 100% 3.5/4.8 | unce k1.06 f176 · 100% 3.5/4.8 | unce k1.06 f176 · 100% 3.5/4.8 |
| pennes-descent | conf k1.06 f461 · 100% 1.4/4.0 | conf k1.06 f461 · 100% 1.3/4.1 | conf k1.06 f461 · 100% 1.3/4.1 | conf k1.06 f503 · 100% 1.5/4.2 | conf k1.06 f503 · 100% **2.8**/4.7 |
| madone-town | unce k0.99 f230 · lm 89.4/150.4 s | unce k1.86 f298 · lm 4.4/8.0 s | unce k1.86 f298 · lm 4.4/8.0 s | unce k1.73 f251 · lm 4.6/8.9 s | unce k1.73 f251 · lm 4.7/8.6 s |
| sacalobra | – | – | conf k1.51 f504 · **2.1/6.0 m, 96%** | unce k1.51 f504 · **2.1/5.9 m, 96%** | unce k1.51 f504 · **1.9/4.9 m, 97%** |

B is the `shz0` column for the bike cases (Roanne to Pennes, rousset-end, pennes-descent) and the `s0base` column for the motorcycle cases (Lahntal,
Marburg, Madone, Gotthard, Amalfi, Sa Calobra).

Do-no-harm (Van Gestel, coarse): unchanged under A within 0.1 m, CdP slightly better (98 → 99 %, p90 5.4 → 5.0 m). Under A + drift ×2,
pennes-descent median 1.3 → 2.8 m. Madone landmarks are the same within 0.3 s mean in all. Lahntal / Marburg stay no_route in all variants (a known
case of its own, not of the balance).

The D variants on all cases (`sDturns`, `sDinfl3`, `sDqrho05`, `sDqrho2`, `sDrho01`) are identical to base on every case except Pontaix, Sa Calobra
(pre-selection table) and small moves on Gotthard (cp max 26-35 m against 31) and Madone (landmarks max 7.3-8.8 s against 8.6): the table
`work/study/table_D.md` in the worktree.

### T3 (whole pipeline from the long videos, parity against the variant's stage set)

| T3 | pontaix-10m along median / p90 | parity v corr / ratio / yaw corr | gotthard-start cp | parity v ratio | checks |
|---|---|---|---|---|---|
| base `t3s0base` | 18.3 / 37.6 m, confident | 1.00 / 1.00 / 0.999 | 10/10, max 32.9 m, uncertain | 1.00 | all ok |
| A `t3hz0` | **7.2 / 29.4 m**, confident | 1.00 / 1.02 / 0.999 | 10/10, max **84.1 m**, uncertain | **0.954** | Gotthard fails: cp max > 70 m, parity ratio < 0.96 |
| B (composed: Pontaix from A, Gotthard from base) | 7.2 / 29.4 m | 1.00 / 1.02 / 0.999 | 10/10, max 32.9 m | 1.00 | all ok |

No scene cut and no standstill second differs between run and stage in any T3 run. The known short-video lag of pontaix-10m (f_eff found lower than
on the whole video) stays, but A / B cut it from 18 to 7 m median.

Not run: T3 for A + drift ×2 (its image side is A's, so the parity is A's; its route would only add the Pontaix p90 loss seen in T2) and for C / D
(out in the pre-selection).

## Recommendation

**B: keep A24 for car and motorcycle, use the fixed horizon row for the bike. Leave the route-side weights at their defaults.**

In plain words: A24 lets the speed follow a horizon that moves with the road's grade. That is right for fast videos on steep alpine roads where the
camera holds level while the road tilts (Gotthard: without it a checkpoint drifts to 84 m in T3). On a bike video the horizon estimate moves for
other reasons (slow speed, little flow, the rider's posture), the speed follows that noise, and the route lags up to 15-30 m along the road over the
first 20 minutes of Pontaix. Sa Calobra, a motorcycle descent and climb of steep serpentines, does not care either way: the many hairpins pin the
position, so the distance factor has little to say there. So the curve side already holds where there are many curves, and the distance side is what
matters on the long, open bike stretches, where A24 hurts.

The route-side weights do not resolve this: allowing more drift of rho helps Sa Calobra (p90 6.0 → 4.9 m) and hurts Pontaix (16.8 → 18.9 m); less
drift does the opposite; a stronger pin of the posterior and the old "turns" mode change little. Fixing the image side where it goes wrong is a
larger and cleaner gain than tuning the route side to absorb it. The combination A + drift ×2 is the best single setting on both verified cases
together (Pontaix 2.1 / 7.4 m, Sa Calobra 1.9 / 4.9 m) but costs pennes-descent and does not hold Gotthard as B does; it is the fallback if B
cannot be built.

The verdict flip to uncertain under A (and on Pontaix under B) is a threshold edge (posterior below 0.5 in 5.0-5.3 % of the time against 5 %), not a
worse route; it has to be decided with B (open points).

## Open points

1. **The vehicle before the motion.** B needs the vehicle when the road-flow fit runs, but today the vehicle is decided from kappa in the route
   search (`vehicle_final.json`, `from_kappa`). Options: (a) a two-pass: interpret motion with A24, decide the vehicle, re-interpret the bike case
   with the fixed row from the stored extraction (12 s per 10 min, A26), then the route search; (b) a pre-vehicle from the speed scale of the
   motion; (c) the user's vehicle setting when given. Not built; B's numbers here are composed from A and base.
2. **The confident verdict under A / B on Pontaix** (5.04 % below 0.5 against 5 %): accept the limit as is, or look at why the fixed row gives a
   few more low-posterior seconds. Not changed in this study.
3. **E, the DEM-grade covariate** (scale as a function of the DEM grade in the route search, the alternative named in A24): not sketched; with B
   the grade effect is held by A24 on the motor cases, so E is only needed if B's split by vehicle is not wanted.
4. **Gotthard under A in T3**: the parity speed ratio 0.954 means the long-video run and the hz0 stage disagree in speed by 4.6 % with the fixed
   row; not followed up, as B keeps A24 there.
5. **More verified bike cases.** The bike side of the recommendation rests on one verified track (Pontaix) and five coarse ones (no harm only).
   The next verified bike video should be checked with A24 on and off before B is decided.
6. Sa Calobra's off-road seconds at 1000-1009 and 1041-1058 s (now real errors with the inexact range [1010, 1040]) and at 164-168 s are the same in
   every variant: they belong to the route search around the cut at the turn, not to this balance.

## Outcome (2026-11-21)

The maintainer chose B. It is built on `feat/v2g-extraction` with a second pass from the stored extraction (CONCEPT_extraction.md, phase 5)
and measured there: Pontaix 1.72 / 5.3 m, Sa Calobra 2.09 / 6.0 m, T3 both pass.
