# Elevation: regional sources and the robust road-height estimator (15 Nov 2026)

Follow-up to [ELEVATION_ANALYSIS.md](ELEVATION_ANALYSIS.md) and [DEM_STUDY.md](DEM_STUDY.md). It covers three things:

1. Detailed national and regional terrain models as on-demand sources: a registry, per-route download, cache, attribution.
2. A new estimator that replaces the pure lower-quantile / median filter (P13) wherever a terrain model has data.
3. Terrain-adaptive stiffness: stiffer in rugged terrain, softer in gentle terrain.

All numbers are **[meas]** on reference tracks, unless marked otherwise. Labels as in DEM_STUDY.

The code:
- `rsm/pipeline/tiff.py`: the GeoTIFF reader.
- `rsm/pipeline/demsrc.py`: the registry, download and cache.
- `rsm/pipeline/dem.py`: `collect_samples`, `robust_road_height` and `profile_multi`.
- `rsm/pipeline/export.py`: `corrected_elevation`, `path_lonlat`.
- The CLI: `dem-plan` and `dem-fetch`.
- The app: `src-tauri/src/incyclist.rs` (`extras_plan`, `fetch_extras`), `src/ridePanel.ts`, `src/incyclist.ts`.

Evaluation scripts and data (git-ignored) are in `research/route-shape-matching/work/elev-strategy/`:
- `code/sample.py`, `code/est.py`, `code/run.py`: the prototype (rasterio, study windows).
- `code/pipe_cases.py`: cases sampled through the pipeline.
- `code/pipe_eval.py`: the tables below.
- `dem/`: the cache.
- `summary.md`, `per_route.md`.

## 1. Result in short

- **Where a terrain model covers the route, the new estimator wins or ties** on 16 hold-out routes. It is compared with today's filter and with the DEM_STUDY fusion (national DTM plus P13 filter):

  | | ascent/descent error | seg. std |
  |---|---|---|
  | new estimator | **2.86 m** | **1.95 m** |
  | DEM_STUDY fusion | 3.01 m | 2.04 m |
  | today (P13 on Copernicus) | 4.09 m | 2.93 m |

  On the gentle Hessian routes the gain is clearest: 2.04 / 1.44 m against 3.11 / 1.60 m (fusion) and 6.40 / 3.70 m (today). On the training routes it is about level with the fusion: 3.84 / 2.72 m against 3.70 / 2.70 m.
- **Where only global surface models exist** (Copernicus and NASADEM), the new estimator does **not** win. There the pipeline uses the DEM_STUDY recipe instead: Copernicus with its void-filled pixels (FLM) replaced by NASADEM, then the unchanged P13 filter. Today's filter therefore stays as the fallback.
- **Terrain-adaptive stiffness beats fixed stiffness overall:**
  - ℓ = 60 m in gentle terrain and 100 m in rugged terrain; it is applied with the plausibility rules in §3.
  - No single fixed value is good on both sets. A fixed ℓ = 60 m ties on the hold-out set but loses badly on Amalfi (5 km asc/desc 7.5 vs 4.8 m; total ascent 1009 vs 917 m, reference 936 m). A fixed ℓ = 80 m is best on the training set but loses on the hold-out set (3.21 vs 2.86 m), mostly on the gentle Hessian routes (3.6 vs 2.0 m).
  - A short real ramp of 4 m (σ 60 m) keeps 58 % of its height on the flat Marburg route, against 40 % with ℓ = 80 m and 35 % with the P13 filter.
- **Sources implemented:**
  - Global: Copernicus fill mask, NASADEM.
  - France: IGN RGE ALTI.
  - Italy: TINITALY, and the South Tyrol DTM 2.5 m.
  - Switzerland: swissALTI3D.
  - Austria: BEV ALS DTM.
  - Germany: DGM1 for Bavaria, Hesse and North Rhine-Westphalia.

  Validated against a reference: France (16 routes), Italy / TINITALY (Amalfi only), Hesse (3 routes). Fetched and sampled but **without a reference route**: Switzerland, Austria, South Tyrol, NRW and Bavaria. The one Bavarian track is not a usable reference (§5.3).
- **Campania re-check:** there is still no open LiDAR DTM. The national geoportal lists only a 2 m LiDAR *surface* model (last return), with no open download found. A DNS failure blocked the INSPIRE record itself. TINITALY via its WCS stays the best open source for Amalfi.

## 2. Sources

The registry is `demsrc.SOURCES`. "Status" is whether the licence was checked on the provider's own page or metadata in this session. A source marked unverified is never enabled by default.

All sources below are free of charge, need no login and ask no terms to be accepted. Each one needs the attribution shown, and the export names only the sources it actually used. None has an NC or ND clause, so they are compatible with AGPL distribution: the app downloads them, it does not ship them.

**Global and Italy**

| Name | Coverage, resolution, type | Access, cache block, size [meas] | Licence (checked where) | Attribution | Status | Validated |
|---|---|---|---|---|---|---|
| `cop_flm` | global, 1″, Copernicus fill mask | AWS S3 `…/AUXFILES/*_FLM.tif`, one file per 1° tile, 0.2–1.5 MB | Copernicus DEM licence (as the DEM) | as Copernicus | verified | DEM_STUDY |
| `nasadem` | 60° S – 60° N, 1″, DSM | OpenTopography S3 mirror, one file per 1° tile, **5–22 MB**. Only fetched where the mask shows void-filled pixels on the route | public domain (NASA) | "NASADEM: NASA JPL (2020), public domain" | verified | 7 routes (DEM_STUDY) |
| `aw3d30` | global, 1″, DSM | OpenTopography mirror, 1° tile, about 7–20 MB | JAXA terms: the page is rendered by script and could not be read. **Redistribution and derived-data wording not verified** | "AW3D30 © JAXA" | **unverified, off** | measured useful as a second fill (DEM_STUDY); not used |
| `it_tinitaly` | Italy, 10 m, DTM (TIN from contours, spot heights, some LiDAR) | INGV WCS 2.0.1 (GeoServer), 5 km blocks, DEFLATE, about 0.45–0.85 MB per block. This replaces the 63 MB zip per 50 km tile | CC BY 4.0 (tinitaly.pi.ingv.it) | "TINITALY 1.1, Tarquini et al. (2023), INGV, CC BY 4.0, doi:10.13127/tinitaly/1.1" | verified | Amalfi (Strava) |
| `it_bz_dtm` | South Tyrol, 2.5 m, LiDAR DTM | provincial WCS `geoservices9.civis.bz.it`, 1.25 km blocks, DEFLATE | **CC0 1.0** (geocatalogue record `p_bz:Elevation:DigitalTerrainModel-2.5m`) | "DTM 2.5 m © Autonome Provinz Bozen – Südtirol, CC0 1.0" | verified | **no reference route**; smoke test near Bolzano (255–386 m, plausible) |

**France, Switzerland, Austria**

| Name | Coverage, resolution, type | Access, cache block, size [meas] | Licence (checked where) | Attribution | Status | Validated |
|---|---|---|---|---|---|---|
| `fr_rgealti` | France, served at 5 m, DTM (LiDAR HD where flown) | IGN Géoplateforme WMS-R, raw BIL float32, 2.5 km blocks, 1 MB per block | Licence Ouverte 2.0 | "RGE ALTI © IGN, Licence Ouverte 2.0" | verified (DEM_STUDY) | 16 Drôme routes |
| `ch_swissalti3d` | Switzerland and Liechtenstein, 2 m (0.5 m exists), LiDAR DTM | swisstopo STAC API, 1 km COG tiles, LZW, about 1.1 MB per km² | swisstopo free geodata (OGD): use, distribution and commercial use allowed, a source reference is mandatory (swisstopo terms of use page) | "swissALTI3D © swisstopo" | verified | **no reference route**. Gotthard project fetched and profiled end-to-end (23 tiles, 50 MB with NASADEM); smoke test at Lugano |
| `at_als_dtm` | Austria, 1 m (stored at 2 m), ALS DTM | BEV 50 km BigTIFF COGs (`data.bev.gv.at/download/ALS/DTM/20250915/…`, EPSG:3035), read by **HTTP range requests** per 256 m internal tile, about 0.2 MB per tile | **CC BY 4.0** (BEV metadata) | "ALS DTM © BEV – Bundesamt für Eich- und Vermessungswesen, CC BY 4.0" | verified | **no reference route**; smoke test in the Inn valley near Innsbruck (568–579 m, plausible) |

**Germany**

| Name | Coverage, resolution, type | Access, cache block, size [meas] | Licence (checked where) | Attribution | Status | Validated |
|---|---|---|---|---|---|---|
| `de_by_dgm1` | Bavaria, 1 m (stored at 2 m), LiDAR | `download1.bayernwolke.de/a/dgm/dgm1/<E>_<N>.tif`, 1 km tiles, LZW, about 2.4 MB | **CC BY 4.0**: field `produkt_lizenz` of the LDBV open-data catalogue (`opengeodata_datensaetze.json`) | "DGM1 © Bayerische Vermessungsverwaltung – www.geodaten.bayern.de, CC BY 4.0" | verified | **no usable reference** (§5.3). The Bavaria project was fetched and profiled end-to-end; smoke test in Munich |
| `de_he_dgm1` | Hesse, DGM1 served at 2 m, LiDAR | HVBG INSPIRE WCS `inspire-hessen.de/raster/dgm1/ows`, coverage `he_dgm1_2`, 1 km blocks, uncompressed, 1 MB per block | **dl-de/zero-2-0** (the WCS capabilities `Fees` field; the open-data portal says the same) | "DGM1 © HVBG, dl-de/zero-2-0" | verified | 3 Marburg routes (barometric) |
| `de_nw_dgm1` | NRW, 1 m (stored at 2 m), LiDAR | `opengeodata.nrw.de/…/dgm1_tiff/` with its `index.json` (3.6 MB, once), 1 km tiles, LZW, about 2.4 MB | dl-de/zero-2-0 (open.nrw metadata; Geobasis NRW: "ohne Einschränkungen") | "DGM1 © Geobasis NRW, dl-de/zero-2-0" | verified | **no reference route**; smoke test in the Sauerland |

**Listed, not implemented** (no time in this session; all would need their own fetcher and a reference route):
- **Slovenia:** ARSO LiDAR, 1 km ASCII tiles; licence not checked.
- **Trentino:** PAT LiDAR, ASC/XYZ zips, CC BY 4.0 on the tile index; no WCS found.
- **Lower Saxony:** WCS, CC BY 4.0.
- **Baden-Württemberg:** open WCS `WCS_INSP_BW_Hoehe_Coverage_DGM1`; licence not checked.
- **Saxony-Anhalt:** WCS, dl-de/by-2-0.
- **Others:** Saxony, Thuringia, Brandenburg, Rhineland-Palatinate, Schleswig-Holstein, Mecklenburg-Vorpommern. Open according to third parties, not checked.
- **Federal BKG DGM1:** not usable, because it needs a licence agreement and fees.

**Coverage, cache and reader.**
- *Coverage:* coarse lon/lat boxes per source. A block the provider does not have (404, outside its area, all nodata) gets a `.none` marker. Server errors such as HTTP 5xx or an exception report are **not** marked; they are retried on the next run.
- *Cache layout:* `<dem_dir>/<source>/<block>.npz` (float32, NaN = nodata, plus the pixel-centre origin and resolution). The 1° tiles stay as `<dem_dir>/<source>/<tile>.tif`. Copernicus itself stays at the top level, as before.
- *What is fetched:* only the blocks within 60 m of the route, not the whole bounding box. WCS and WMS blocks carry one pixel of overlap, so the bilinear interpolation never clamps at a block edge. Without the overlap, TINITALY differed from the zip tile by up to 6.7 m; with it the two agree exactly.
- *Reader:* the GeoTIFF reader (`tiff.py`, numpy + zlib, no GDAL) adds BigTIFF, strips, LZW, predictor 2, int16 / uint8 and ModelTransformation. It matches rasterio bit for bit on Bavaria, NRW, Hesse, TINITALY, NASADEM, AW3D30 and the FLM. Decoding one Bavarian 1 km LZW tile takes about 1 s.
- *Download behaviour:* the mask is fetched first; then the plan is made again (a fill is only needed where the mask shows void-filled pixels). The fetcher waits 0.2 s between requests. A source that fails three times is skipped for that run.

**Observed availability risk [meas].**
- The Hessian WCS answered HTTP 502 for every request during the second fetch of this session (about an hour after the first, successful one). The evaluation therefore uses the blocks from the first fetch, which have no overlap pixel.
- The IGN WMS-R once returned errors that the first fetcher version mistook for "no data". That is fixed (see the server-error rule above).
- All endpoints are public services without a service-level agreement.

## 3. Method: the robust road-height estimator (`dem.robust_road_height`)

**1. Corridor samples** (`collect_samples`). Every 5 m along the driving line, each source is sampled across the road:
- Copernicus at ±15 m and its fill mask at the same points;
- TINITALY at ±5 and ±10 m;
- IGN at ±3 and ±6 m;
- the 2 m and 2.5 m LiDAR sources at ±2 and ±4 m.

Each sample is moved to the road axis with the source's own cross slope (smoothed over 50 m). It then estimates the road height on a locally planar cross-section.

**2. Prior weight per sample** is P / σ².
- σ by source: LiDAR 0.5 m, IGN 0.7 m, TINITALY 3.5 m, Copernicus 2 m (10 m on void-filled pixels), NASADEM 5 m.
- σ grows with the local slope times the pixel size, and with the lateral offset times the slope.
- P = exp(−½ (offset / pixel)²).

Global DSM fills are moved to the Copernicus datum by the *mode* of their difference on TanDEM-X pixels, which ignores the canopy tail. Terrain models keep their national datum; the measured modes were +1.9 m (TINITALY), −0.4…+0.1 m (IGN), +0.6 m (Bavaria) and +1.1 m (swissALTI3D).

**3. Plausibility weight** against the current profile, by iteratively reweighted least squares. The weight is Cauchy, 1 / (1 + (r/c)²), with graduated non-convexity:
- the scale c runs over the passes (8, 4, 2, 1, 1) × σ;
- c is at least 1 m × the pass multiplier;
- the start is the per-station weighted median, so a far-off source cannot pull the first fit towards itself.

A DSM sample **below** the profile is tolerated k_up = 4 times more than one above, because trees and roofs only raise a DSM. This replaces the lower quantile. In rugged terrain the asymmetry fades to symmetric, because there the DSM errs both ways (gorges, sea). The final c also tightens there, from 1.5 to 1.0 σ.

**4. Continuity prior.** The profile minimises Σ w (z − f)² + Σ λᵢ (Δ²f)ᵢ. The second term is a penalised spline: λᵢ = W · (ℓᵢ / 5 m)⁴, solved banded (scipy `solveh_banded`). Tunnels and bridges (plus 15 m) get no data weight; they are bridged linearly as before, and the ±18 % clamp is applied at the end.

**5. Terrain-adaptive stiffness.** ℓᵢ = 60 m · (100 / 60)^rᵢ. The ruggedness r ∈ [0, 1] is the soft OR, smoothed over 100 m, of three measures:
- Copernicus cross slope: 0.3 → 0, 0.9 → 1;
- local DEM noise, as in P13: 3 m → 0, 10 m → 1;
- the share of void-filled pixels × 2.

In rugged terrain the spline is stiffer *between* the consensus hits. Samples that pass the plausibility test (high weight) still pin it, so it does not blur everything. In gentle terrain it stays soft, so short real ramps survive.

**6. Policy** (`profile_multi`).
- Where a terrain model has data on more than half of a station's samples, the profile is the robust estimate.
- Elsewhere it is Copernicus with its void-filled pixels replaced by NASADEM (DEM_STUDY §4), followed by the unchanged P13 filter.
- The two are feathered over 100 m.
- With no extra source cached at all, the output is **exactly** today's P13 profile (tested).
- `dem.MULTI_SOURCE = False` switches the whole thing off.

**How the parameters were chosen.**
- The structure and the candidate (ℓ 60 / 100, k_up 4, c 1.5 / 1.0, slope 0.3–0.9) were picked in the prototype on Amalfi and three Drôme routes. That was before the 13 extra hold-out routes were assembled.
- The pipeline sweep (`pipe_eval.py sweep`) on the same four training routes ranks a fixed ℓ = 80 m slightly higher on the training set: 3.42 / 2.81 against 3.84 / 2.72 m.
- The adaptive variant was kept anyway, and this is stated openly: the training set has no gentle route, so it cannot identify the gentle-terrain stiffness.
- On the hold-out set, which includes the gentle Hessian routes, the adaptive variant is clearly better (§4).

**What was tried and not adopted.**
- **Robust estimator with global DSMs only** (Copernicus + NASADEM, prototype): training ascent/descent error 6.6 m at best (most settings 7–10 m), against 6.2 m for fill + P13. Not adopted.
- **"Consensus dispersion" as the ruggedness measure** (how badly the samples agree around a first fit): no better than the terrain measure (prototype, training 6.38 against 6.28). Not adopted.
- **AW3D30 as a second fill:** helps (DEM_STUDY), but its terms are unverified.

## 4. Measurements

**Metrics.** As in DEM_STUDY §3.1:
- per 5 km segment, mean |ascent − ref| and |descent − ref| with 3 m hysteresis ("ad" = their mean);
- seg std = mean over segments of std(profile − ref);
- total ascent error, grade sign flips per km (50 m grade, 1 % dead band) and maximum 50 m grade.

**References.** Amalfi: Strava route, pipeline positions. All others: barometric Van Gestel tracks with their own GPS positions; tunnels and bridges are not flagged on the 13 new routes.

**Split.**
- Training (parameter choice): Amalfi, Col de Grimone 1, Col de Pennes, CdP Aucelon.
- Hold-out: Roanne, Rousset, Pontaix (as in DEM_STUDY), plus 13 routes new in this study:
  - Drôme: Grimone 2, Menée 1/2, Source 1/2/3, Valdrôme 1/2, Barnave, Petit Menglonnais;
  - Hesse: Marburg–Lahntal, Rimberg–Kronenberg, Wetterhöhe–Katzenbach.

Every number below comes from the pipeline code itself (`pipe_eval.py full`), with data fetched through `demsrc`.

**Group means.** Each cell is ad / seg std in m.

| Strategy | Training (4) | Hold-out (16) | Hold-out France (13) | Hold-out Hesse (3) |
|---|---|---|---|---|
| Today (P13 on Copernicus) | 6.34 / 5.21 | 4.09 / 2.93 | 3.55 / 2.76 | 6.40 / 3.70 |
| Fusion: Cop, FLM fill → NASADEM, P13 (no terrain model) | 6.11 / 4.35 | 4.11 / 2.93 | 3.59 / 2.75 | 6.40 / 3.70 |
| Fusion: national DTM + P13 (DEM_STUDY §4, the "source fusion alone") | **3.70** / **2.70** | 3.01 / 2.04 | **2.99** / 2.15 | 3.11 / 1.60 |
| **Robust, terrain-adaptive (adopted)** | 3.84 / 2.72 | **2.86** / **1.95** | 3.05 / **2.07** | 2.04 / 1.44 |
| Robust, fixed ℓ 60 m (k_up 2) | 4.66 / 2.90 | 2.83 / 1.95 | 3.04 / 2.07 | 1.91 / 1.43 |
| Robust, fixed ℓ 80 m (k_up 2) | 3.58 / 2.81 | 3.21 / 2.00 | 3.11 / 2.09 | 3.62 / 1.62 |
| Robust, fixed ℓ 100 m (k_up 2) | 3.74 / 2.79 | 4.06 / 2.11 | 3.52 / 2.15 | 6.43 / 1.96 |

The fixed variants with k_up 4 differ by at most 0.25 m (`summary.md`).

**Shape and Amalfi.** The first three columns are means over the 20 usable routes.

| Strategy | Mean abs. total-ascent error | Flips/km minus reference | Mean max. grade | Amalfi km 20–45: asc err / std | Amalfi total ascent (ref 936 m) |
|---|---|---|---|---|---|
| Today (P13 on Copernicus) | 3.3 % | −0.15 | 11.3 % | 13.8 / 10.1 m | 985 m |
| Fusion: national DTM + P13 | 2.5 % | −0.24 | 9.7 % | **6.2** / 6.4 m | 941 m |
| Robust, terrain-adaptive (adopted) | **1.9 %** | −0.26 | 8.6 % | 7.7 / 6.4 m | 917 m |
| Robust, fixed ℓ 60 m | 2.7 % | −0.22 | 8.9 % | 10.3 / 7.7 m | 1009 m |
| Robust, fixed ℓ 80 m | 2.3 % | −0.32 | 8.2 % | 5.1 / 7.0 m | 953 m |

**Reading.**
- **Against today:** better on every route with a terrain model except four. Those are Grimone 2 (+1.6 m; today's 0.0 m there is suspiciously good), Source 2 (+1.2 m), Menée 2 (+0.5 m) and Pontaix (+0.1 m).
- **Against the source fusion alone:**
  - better on the hold-out mean (2.86 vs 3.01 m; 1.95 vs 2.04 m) and on the Hessian routes (2.0 vs 3.1 m);
  - level on France (3.05 vs 2.99 m ad, 2.07 vs 2.15 m std);
  - slightly worse on the training mean (3.84 vs 3.70 m), because Aucelon (4.7 vs 3.7 m) and Grimone 1 (2.3 vs 1.4 m) are worse;
  - on Amalfi the 5 km ascent/descent error is better (4.8 vs 5.3 m), but the cliff stretch km 20–45 is worse (7.7 vs 6.2 m), and total ascent is 917 against the reference 936 m (fusion 941 m).

  So it **wins or ties overall**, but it is not better everywhere.
- **Against fixed stiffness:**
  - ℓ 60 m: level on the hold-out set, but on Amalfi it adds 92 m of false ascent and its km 20–45 error is 10.3 m;
  - ℓ 80 m: good on the cliffs but flattens the gentle Hessian hills (3.6 vs 2.0 m);
  - ℓ 100 m: worse everywhere.
- **Overfitting guard:** the hold-out routes outnumber the training routes 4 to 1, the training routes did not move, and the main decision (adaptive) is the one that does better on the hold-out set.

**Short real ramps** (`pipe_eval.py ramp60` / `ramp25`). A Gaussian bump (A = 4 m) is added to every source and to the reference, at three places each on Marburg (gentle), Roanne and Rousset. The table gives the share of its height kept at the crest.

| Filter | σ 60 m (≈ 250 m ramp) | σ 25 m (≈ 100 m) |
|---|---|---|
| P13 (lower quantile + Gaussian) | 0.48 (Marburg 0.35) | 0.17 (Marburg 0.06) |
| Robust, fixed ℓ 80 m | 0.45 (Marburg 0.40) | 0.14 (0.11) |
| **Robust, terrain-adaptive** | **0.57 (Marburg 0.58)** | **0.18 (0.17)** |

Bumps of about 100 m are still mostly removed by every variant. The DEMs' own errors live on that scale too (correlation length 125–325 m, ELEVATION_ANALYSIS), so this is a deliberate trade-off.

**Unchanged where no terrain model exists.** "Fusion: Cop, FLM fill → NASADEM" is what the app now does outside the covered countries. It equals today's filter on routes without void-filled pixels. On Amalfi it gives 6.1 / 3.8 m and km 20–45 8.5 m, against 7.4 / 4.8 m and 13.8 m today.

## 5. Validation status per source, honestly

1. **France (IGN):** 16 barometric routes, all in the Drôme. No route in the Alps, the north or Corsica.
2. **Italy (TINITALY):** Amalfi only, against Strava, which is not ground truth. No second Italian route.
3. **Bavaria:** the only track found is `DE_Haustrails.gpx` (RoomSports, 2016). It is an MTB ride on forest trails: the GPS positions lie metres off the trails, and the track sits 10 m above DGM1 with a std of 6.9 m. Every strategy scores 17–25 m on it, so it says nothing about the DEM. It is reported apart (`summary.md`) and left out of all means.
4. **Hesse:** 3 routes around Marburg. The Wetterhöhe and Rimberg routes are partly in forest.
5. **Switzerland, Austria, South Tyrol, NRW: no reference route.**
   - These are LiDAR terrain models of the same kind as IGN and Hesse, so the same σ was assumed.
   - Only the download, reading, georeferencing and plausible heights were checked: Gotthard and Bavaria end-to-end, plus 2–5 km smoke segments.
   - A video with GPS, or a barometric track, from these regions would close the gap.

## 6. App behaviour

- **The profile under the video** is computed as before, as soon as the Copernicus tiles are there.
- **Offer of more detail:** afterwards the app asks the pipeline offline (`dem-plan`) whether national or regional blocks exist for the route. If so, it shows "Genauere Höhendaten verfügbar: <sources> (ca. X MB)" with a "Laden" button.
- **After that download** (`dem_download` with the project → `dem-fetch`), the profile is recomputed. The stamp `dem/.extras-updated` makes older profiles stale.
- **Incyclist export dialog:** shows the extra sources and their size. With "Fehlende Höhendaten beim Export laden" the export fetches them after the Copernicus tiles. If a source fails, the export still runs, with a note.
- **Attribution** lists only the sources actually used:
  - GPX `<metadata><desc>` and `rsm:attribution`;
  - `rsm:elevation` (for example `copernicus-glo30+fr_rgealti`);
  - the summary `elevation.sources`;
  - `video2gpx.json` `sources`;
  - LIESMICH ("Höhen: …" per source);
  - the Kartendaten page lists every source and its licence; Settings › About has a short line.
- **Settings › Kartendaten › Höhendaten:** one row per source directory, with its size and a "Löschen" button.

## 7. Open

- Reference routes for CH, AT, South Tyrol, NRW and Bavaria. A second Italian route.
- A fetcher for Slovenia, Trentino and the other open German Länder (§2).
- AW3D30: read and check the JAXA terms. If they allow it, enable it as a second fill (DEM_STUDY: Amalfi km 20–45 8.5 → 6.0 m with the mean of the two fills).
- Profiles computed before this change are reused until the result or the extra data change. A changed pipeline hash does not invalidate them yet.
- Not yet run in the real app: the "Genauere Höhendaten" note and its download, and the export dialog line. The browser mock does not simulate extras.
