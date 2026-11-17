# Elevation profile: root-cause analysis (13 Nov 2026)

Why is our profile noisier than Strava's on the Amalfi coast, and what can be fixed? Labels: **[doc]** = from
documentation, **[meas]** = measured here, **[spec]** = speculation. Scripts and caches (not in the repo):
`<scratchpad>/ea/*.py` (`base.py` builds the data; `a_strava.py` to `k_kernel.py` are the experiments).

**Short answer.** The noise comes from the **DEM itself** on the steep coastal stretch. It is not caused by our
positions, the sampling kernel or the filter shape. The Copernicus DSM is wrong at the road by tens of metres, and the error
is correlated over 125 to 325 m of road. That is the same scale as real climbs, so no filter can separate the two.
Strava does not use this DEM: route elevations come from its own crowd-sourced barometric basemap. On km 20 to 45
a DEM-only profile cannot match Strava. No change to `dem.py` was justified, so behaviour is unchanged.

## 1. How our profile is made [meas, code]

`export.py` (GPX export and `elevation_profile`) → `dem.py`:
1. **Positions**: the refined route on the OSM centre line (`refine/result.npz`), moved by the fixed driving-line offset
   (1.6 m right on Amalfi). A grid point is taken every 5 m of arc (`SAMPLE_M`).
2. **DEM**: Copernicus GLO-30 **DSM** (a surface model: trees, roofs and radar artefacts included). These are COG tiles of 1°×1°
   with 3600×3600 px, so 1 arcsec (≈31 m N-S, ≈24 m E-W at 40° N). They are float32, DEFLATE with predictor 3, in 1024² internal
   tiles, and carry no nodata tag (checked on N40E014, N43E007 and N44E005). Heights are EGM2008 geoid heights [doc,
   Copernicus DEM handbook]. They are read by our own numpy/zlib reader.
3. **Sampling**: bilinear between pixel centres, at the point only (no footprint).
4. **Corrections**: OSM tunnels and bridges (widened by 15 m) are interpolated linearly. Then the filter follows the
   local noise: where the DEM is clean, the lower quantile (25 % over 200 m) and a Gaussian (σ 60 m); where it is noisy, the median
   and a robust local-linear fit (σ 150 m), blended between 3 and 10 m of local noise. The grade is clamped to ±18 %, and ascent
   counts climbs over 3 m (hysteresis).

## 2. What Strava's profile is

**[doc]** The Strava support pages
([Elevation](https://support.strava.com/hc/en-us/articles/216919447-Elevation),
[Elevation Basemap](https://support.strava.com/hc/en-us/articles/115000024864-Strava-s-Elevation-Basemap),
[FAQ](https://support.strava.com/hc/en-us/articles/115001294564-Elevation-on-Strava-FAQ)) say:
- Route Builder uses Strava's own elevation database.
- The basemap is built from activities recorded on devices with a barometric altimeter. Where it has no data, a public database
  fills in.
- Outliers are dropped and the data smoothed. Gain needs a threshold: 10 m without good barometric data, 2 m with it.
- Strava warns that basemap errors can inflate totals in mountainous or coastal regions.

The exact smoothing kernel and source DEM are not published.

**[meas] From the GPX** (`amalfi-strava.gpx`, a Strava *route*, 2486 points over 62.0 km):
- **Points**: the spacing is not uniform (median 18 m, p10 8 m, p90 54 m, max 100 m), so the profile is piecewise linear between OSM vertices.
  Elevation has 0.01 m precision, and 22 % of steps repeat the value before.
- **Ascent**: 1018 m without hysteresis, 952 m with 3 m hysteresis. Strava itself reports 986 m.
- **Grade**: p99 over 50 m is 9.3 %, max 31 % (a glitch: Strava has outliers too).
- **Not our DEM at its own positions**: Copernicus sampled at Strava's own lat/lon differs from Strava by std 14.0 m (median
  −0.6 m, MAD 3.7 m, 20 % of points off by more than 10 m; correlation 0.993). The datum agrees within 1 m.
  - A raw DEM along Strava's line would give **5052 m** of ascent.
  - No smoothing reproduces Strava: the best Gaussian (σ 180 m) still leaves std 8.7 m.
  - Shifting along the track does not help (best lag 0 ± 5 m).
  - DEM power exceeds Strava's even at 1 to 2 km wavelengths (PSD ratio 0.11 at 1 km, 0.44 at 2 km). So the difference is not
    just high-frequency noise that Strava smoothed away: it is a different source.
- **Tunnels and bridges**: the profile is smooth across them. It does not show the drops seen in the DEM.

## 3. Experiments (Amalfi, our 5 m grid, reference = Strava interpolated at the projected point)

The "noisy" stretch is km 20 to 45 of our route. Results:

| Experiment | Result |
|---|---|
| (a) Strava's positions instead of ours | Unchanged: total 984 vs 971 m, mean seg. ascent error 8 vs 8 m, km 40–45 175 vs 173 m |
| (d) Cross-track distance of our line from Strava's | median 1.8 m, p90 2.7 m, p99 7.2 m. That is our 1.6 m lane offset, since Strava lies on the OSM centre line. Same in noisy and clean segments (Spearman with error 0.15) |
| (b) Shift of the positions across the track, ±2 / ±5 / ±10 / ±20 m | Raw DEM changes by 1.3 / 3.1 / 6.3 / 12.5 m (cross-slope ≈ 0.6). The filtered profile changes by RMS 0.7 / 1.8 / 3.0 / 5 m. Noisy-km ascent 543–588 m vs 547 m |
| (b) Shift along the track, ±5 to ±20 m; white position noise σ 2 to 10 m | Profile RMS 0.4 to 2.3 m; ascent within ±25 m |
| (b) Global E/N shift (registration), ±30 m grid | Best (+5, +5 m) lowers the clean-stretch std from 4.8 to 4.4 m, and (+10, +20 m) the noisy one from 17.5 to 15.2 m. A few metres of misregistration are possible; it is not the main cause |
| (c) Sampling footprint: disk mean or median r = 15/30/45 m, nearest pixel | Noisy std 17.4 to 17.8 m (bilinear 17.5); seg. error 12.4 to 15.7 m (bilinear 13.8). No effect |
| (c) What predicts the error, 250 m bins, Spearman with \|DEM−Strava\| | DEM local noise 0.58, terrain slope at 30 m 0.49, cross-slope 0.43, curvature 0.37, sea within 30 m 0.28, road curvature 0.20, cross-track 0.15 |
| Terrain | km 20–45: slope median 0.68 and **p90 1.17 (≈50°)**; DEM noise 10.1 m. km 0–20: 0.62 and 0.87, noise 4.3 m. km 45–62: 0.25, noise 1.4 m |
| Error structure, km 20–45 | Residual std 20 m (clean stretches 6.4 m). It is correlated over 125 m (1/e) to 325 m (0.1); clean stretches 75 to 120 m. Half the bad bins are too low, half too high. Example: km 40.5–41.25 (SS163 near 40.620 N, 14.465 E, untagged primary road) has the DEM 30–90 m *below* Strava for 750 m, even ±60 m across the road |
| (e) Old filter vs new filter | Mean \|5 km segment ascent error\|: old 30, new 8 m; on km 20–45, 70 vs 14 m; RMS 14.1 vs 8.9 m. New vs Strava PSD: ×1.6 to ×2.2 at 300 to 500 m wavelength (the DEM error band), and less below 200 m |

**Road class and map priors (maintainer request).**
- **Amalfi has a single class**: all 62 km are `primary`, with no tunnels or bridges tagged on the bad bins.
- **Measured grade p99 per class** (50 m baseline):
  - Amalfi primary (Strava): 9.3 %.
  - Roanne (barometer): primary 3.6 %, secondary 6.0 %, tertiary 3.1 %.
- **Grade clamps do not reach the error**: clamping the new profile to 12 / 10 / 8 / 6 % gives km 20–45 segment errors of
  13.7 / 13.7 / 13.1 / 12.4 m (13.8 without a clamp). The bad bins need only about 6 % grades, so even 6 % (below Amalfi's real p99) barely helps.
- **Road curvature (hairpins) does not predict the error** (ρ 0.20). A smoothing scale chosen by curvature therefore has no basis.

**OSM tags of the route** [meas, `sud.osm.pbf` via pyosmium], 273 ways:
- **Class and surface**: 261 primary, all asphalt but one.
- **Tunnels and bridges**: tunnel 13, bridge 28, covered 1. These are already flagged in the graph and interpolated.
- **incline**: only 13 × `up` and 2 × `20%`, no usable grades.
- **Around km 40.5–41.25**: the three SS163 ways there carry no tunnel, bridge, covered or layer tag. The map cannot explain that dropout.
- **ele nodes**: 126 in the bbox, but only 4 within 50 m of the road:
  - saddle 312 m: Strava 310, ours 311;
  - an untagged node at 471 m: Strava 464, ours 472;
  - Colli di Fontanelle, 343 m at 16 m from the road: Strava 348, ours 348;
  - Grotta del Fesso cave entrance, 150 m: Strava 163, ours 163. This is not a road point.

  So the ele tags confirm our profile to about 1 m where they exist, and none lies on the noisy km 20–45.

**Other filter variants.**
- **Wider robust fit** where the DEM is noisy (σ 250 / 400 / 600 m): RMS falls (6.1 / 5.3 / 7.2 m), but segment ascent error rises
  (15.8 / 17.5 / 25.6 m), because real climbs flatten.
- **Oracle**: interpolate wherever |DEM − Strava| > 15 m. km 20–45 error 9.5 m, RMS 4.3 m. This is the upper bound for any
  "detect bad DEM and bridge it" method.
- **Detectors that use no reference**:
  - Slope mask (slope > 0.8 / 1.0 / 1.2): 11.1 / 16.7 / 15.4 m.
  - Outlier mask (|raw − robust fit σ 150 m| > 10 m, interpolated): helps Amalfi, with km 20–45 at 8.3 m and RMS 7.0 m. On the 7 other references it is mixed:
    - Col de Grimone: 10.1 → 13.5 m segment error, RMS 15.6 → 16.6 m.
    - Roanne: 3.9 → 4.6 m.
    - Synthetic sharp pass crest: it fires there and costs 10 m of ascent.
  - **Rejected.**

## 4. Causes, ranked

1. **DSM error at the road on steep coastal slopes (dominant)** [meas]. Residual std 17.5 m on km 20–45 vs 4.8 m elsewhere,
   correlated over 125 to 325 m, half too high and half too low. It follows terrain slope (p90 ≈ 50°) and DEM roughness. It does not
   follow our positions. Possible mechanisms: radar layover or shadow in TanDEM-X on cliffs, filled from other sources; a 24 to 31 m
   pixel spanning a road ledge cut into a ≈45° slope; buildings and trees of the cliff villages [spec; GLO-30's own height-error and
   fill masks were not checked].
2. **Different source, not a smoothing of ours** [doc + meas]. Strava = barometric crowd basemap. Its profile is not reachable from
   this DEM (std 8.7 m even at the best smoothing, on Strava's own positions).
3. **Filter residue** [meas]. The new filter passes 1.6 to 2.2× Strava's power at 300 to 500 m wavelength. That is exactly the DEM error band;
   a filter can only trade it against real climbs (σ sweep above).
4. **Horizontal position, including the lane offset** [meas]. 1.8 m median from Strava. ±2 m changes the profile by RMS 0.7 m, and ±5 m
   by 1.8 m. Minor.
5. **Sampling kernel or interpolation** [meas]. No measurable effect.
6. **Evaluation artefact** [meas]. The earlier check (`ev.py`, `seg.py`) took the elevation of the *nearest* Strava point (spacing up to
   100 m), followed by a median of 5. Interpolating at the projected point is cleaner: Strava ascent on our grid is 958 m, not
   944 to 968 m. The conclusions do not change.

## 5. What a principled fix would be, and verdict

| Option | Assessment |
|---|---|
| Better horizontal positions or lane detection | Worth it for other reasons; ≤ 2 m of profile RMS here. **No.** |
| Wider sampling footprint, bicubic | Measured no effect. **No.** |
| Larger smoothing scale | Trades RMS against flattened climbs; tuned on one route. **No.** |
| Road-class grade caps or curvature-scaled smoothing | Caps do not bind on the error (needs < 6 %); curvature does not predict it. **No.** |
| Outlier mask before the filter | Helps Amalfi, hurts Grimone, Roanne and a synthetic crest. **No.** |
| **A second elevation source where the DSM is noisy** (a national DTM, e.g. TINITALY 10 m for Italy; FABDEM, a bare-earth version of Copernicus; or the GLO-30 auxiliary height-error and fill masks to find bad pixels) | The only option that attacks cause 1. It needs downloads, licence checks (FABDEM is non-commercial as far as we know, not verified here; national DTMs vary) and a second route with a noisy DSM to validate. **Recommended next study, not implemented.** |
| OSM `ele` tags at peaks and passes as anchors | Only 4 road-side nodes in 62 km, none on the noisy stretch; where they exist our profile already agrees to about 1 m. **No** (too sparse; could be a sanity check later). |

**Verdict.** No change to `dem.py` or `export.py`. The current noise-adaptive filter (P13) is near the best a DEM-only
filter can do here: 8 m mean segment error vs the 6 to 9.5 m oracle bound. More tuning on Amalfi would only fit one route.
