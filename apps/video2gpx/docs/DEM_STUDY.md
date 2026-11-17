# Better elevation models: candidates and measurements (13 Nov 2026)

Follow-up to [ELEVATION_ANALYSIS.md](ELEVATION_ANALYSIS.md). Which open DEMs give a better road profile than Copernicus GLO-30?
Each usable model was turned into a profile with the **same positions and the same filter as the pipeline** (`dem.profile`, 5 m
grid, tunnels and bridges interpolated) and scored against a reference **per 5 km segment**. Labels: **[doc]** = documented by the
provider, **[meas]** = measured here, **[unv]** = from memory or third parties, not verified. The pipeline is unchanged.

Prototype (git-ignored): `research/route-shape-matching/work/dem-study/`
- `code/fetch.py`: windows from the open COG mirrors.
- `code/points.py`: OpenTopoData and Terrarium.
- `code/ign.py`: IGN WMS-R.
- `code/make_cases.py`: GPS reference cases.
- `code/evaluate.py`: per-source table.
- `code/combos.py` and `code/flm_fusion.py`: fusion variants.
- `code/summary.py`: cross-route table.

It runs with its own venv (`.venv`, rasterio 1.5 / GDAL 3.12).

## 1. Key findings

1. **The cause behind the Amalfi km 20 to 45 is now known [meas].** Copernicus ships a fill mask (`FLM`, in `AUXFILES/` next to every
   DEM tile on the same S3 bucket, about 0.2 MB per tile):
   - On km 20 to 45, **62 % of the road samples are not TanDEM-X** but void fill: FLM 3 = ASTER (26 %) and 5 = SRTM30 (34 %).
     Elsewhere on the route it is 15 %. These are radar shadow and layover on the cliffs.
   - Mean |Cop − Strava| is **3.4 m on TanDEM-X pixels (FLM 2) and 15.7 to 17.7 m on filled pixels**.
   - The editing mask `EDM` = 2 ("infill from external data") marks the same pixels; Spearman with the error is 0.70 in 250 m bins.
   - The same thing happens on Col de Grimone: 17 % filled (gorge walls), and Copernicus is worst there of all French routes.
2. **A LiDAR national DTM beats every global model clearly [meas].** IGN RGE ALTI on 6 Drôme routes gives a mean per-segment std of
   **1.9 m vs 3.9 m** for Copernicus. On Col de Grimone it is 1.0 vs 8.6 m, with a 5 km ascent error of 1.5 vs 10 m.
3. **TINITALY (Italy, 10 m) is not LiDAR: it is better than Copernicus only where Copernicus is filled [meas].**
   - TINITALY alone halves the noisy-stretch ascent error (6.9 vs 13.8 m) but adds 10 to 15 m blobs on clean stretches (seg. std 5.7 vs 4.8 m).
   - **Copernicus with the filled pixels replaced by TINITALY** is best on the 5 km ascent error (4.1 vs 7.5 m; noisy stretch 6.2 vs 13.8 m).
   - The 3-way median (TINITALY, Cop, NASADEM) has a slightly lower seg. std (3.5 vs 4.1 m) and descent error (5.1 vs 6.5 m), but it is a
     blend tuned on one route (§3.2).
4. **The best global fallback is Copernicus with its filled pixels replaced by mean(AW3D30, NASADEM)** [meas, 7 routes]. Mean
   per-segment std falls from 4.01 to 3.33 m. Unfilled routes are unchanged by construction. The "bare-earth" products (FABDEM, GEDTM30,
   EU_DTM) do **not** fix the problem, because they are corrections of the same Copernicus or SRTM heights.

## 2. Candidates

Sizes are per 1° tile unless stated otherwise. "App use" means: can an AGPL app download it on demand per area, cache it and
show attribution. NC licences are treated as incompatible (an NC clause restricts users in ways AGPL redistribution cannot carry).

| Source | Coverage | Res. | Type | Vertical accuracy [doc] | Licence / attribution | Access (no login) | Size per area | App use |
|---|---|---|---|---|---|---|---|---|
| **Copernicus GLO-30** (today) | global | 1″ (≈30 m) | DSM | < 4 m LE90 abs. [doc] | Copernicus DEM licence, free incl. commercial, attribution (already in `dem.py`) | AWS S3 open COG | 15–19 MB | yes (in use) |
| **Cop GLO-30 FLM / EDM / HEM masks** | global | 1″ | masks | – | as above | same bucket `…/AUXFILES/` | FLM 0.2 MB, EDM 0.2 MB, HEM 17–51 MB | **yes, FLM recommended** |
| **AW3D30** v3/v4 (JAXA) | global | 1″ | DSM (optical stereo, no radar shadow) | ≈ 5 m RMSE [doc/unv] | free of charge incl. commercial per JAXA page; redistribution wording **not verified**; credit JAXA | official download needs registration; **public mirror** OpenTopography S3 (`opentopography.s3.sdsc.edu/raster/AW3D30/`, no-sign) | 6.8 MB (int16 LZW COG) | yes for download from the mirror; terms to confirm |
| **NASADEM** | 60° S–60° N | 1″ | DSM (SRTM reprocessed) | ≈ 5–9 m [unv] | NASA, public domain | LP DAAC needs Earthdata login; **OpenTopography mirror** no-sign | 4.8 MB (int16 DEFLATE COG) | yes |
| SRTM GL1 v3 | 60° S–60° N | 1″ | DSM | 16 m LE90 spec [doc] | public domain | OT mirror; Terrarium tiles | ≈ 5 MB | yes, but NASADEM supersedes it |
| FABDEM v1-2 | global | 1″ | DTM (ML on Cop) | ≈ 2.9 m RMSE vs LiDAR [unv, authors] | **CC BY-NC-SA 4.0** | data.bris.ac.uk, 10°×10° zips (1.9 GB for N40E010; a single tile is read by range request) | tile size not checked | **no** (NC) |
| GEDTM30 v1.2 (OpenGeoHub) | global | 1″ | DTM (ML, ICESat-2/GEDI) | RMSE 10.7 m vs GNSS [doc, PeerJ 2025] | CC BY 4.0 | one 432 GB global COG on the OT mirror; Zenodo | range reads only | yes, but measured no gain |
| EU_DTM v0.3 (OpenGeoHub) | Europe | 30 m (EPSG:3035) | DTM (ML) | fit RMSE ≈ 6.5 m [doc] | CC BY 4.0 | one COG on the OT mirror | range reads | yes, but measured worse |
| EU-DEM v1.1 | EEA39 | 25 m | DSM-like (SRTM+ASTER) | ≈ 7 m RMSE [doc/unv] | Copernicus Land, free, attribution | Land portal needs login; OpenTopoData public API (1000 calls a day) | – | not for offline; measured worst |
| Mapzen Terrarium | global | z14 ≈ 7 m px | resampled SRTM / others | as source | mixed open, attribution list | AWS open PNG tiles | ≈ 75 KB/tile | measured poor |
| Open-Meteo elevation | global | 90 m (Cop GLO-90) | DSM | – | CC BY 4.0 [unv] | API | – | no (coarser than today) |
| **TINITALY 1.1** (INGV) | Italy | 10 m (UTM32) | DTM (TIN from contours, spot heights, some LiDAR) | RMSE ≈ 3.5–4 m, worse on steep slopes [doc/unv] | **CC BY 4.0**, citation: Tarquini et al. (2023), INGV, doi:10.13127/tinitaly/1.1 | direct zips per 50×50 km tile (`tinitaly.pi.ingv.it/data_1.1/wNNNNN_s10/…zip`), also WCS/WMS | **63 MB zip / 96 MB float32** per tile (Amalfi: `w45095`) | yes; heavy per area |
| Italy PCN / MASE LiDAR 1–2 m | coasts and rivers | 1–2 m | DTM | dm | on request, WMS view only [doc] | no open download | – | no |
| Campania regional DTM/DSM LiDAR | parts | 1–2 m | DTM / DSM | dm | INSPIRE record found; no open WCS found | – | – | no (not found) |
| **IGN RGE ALTI** (France) | France | 1 m (served at any res.) | DTM (LiDAR HD where flown, else photogrammetry) | ≈ 0.2 m on LiDAR, up to metres elsewhere [doc/unv] | **Licence Ouverte 2.0 (Etalab)**, attribution "IGN" | Géoplateforme WMS-R `data.geopf.fr/wms-r`, layer `ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES`, `image/x-bil;bits=32`, max 5010 px, no key | 16 MB per 10×10 km at 5 m (float32, uncompressed) | yes |
| Bayern DGM1 | Bavaria | 1 m | DTM LiDAR | dm | CC BY 4.0 (open since 2023) [doc, third-party sources] | 1 km GeoTIFF tiles, geodaten.bayern.de/opengeodata, metalink | ≈ 1–4 MB/km² | yes [not tested] |
| swissALTI3D | Switzerland | 0.5 / 2 m | DTM LiDAR | dm | OGD, free incl. commercial, attribution "swisstopo" | STAC API data.geo.admin.ch, 1 km tiles | 2 m: ≈ 1 MB/km² [unv] | yes [not tested] |
| Austria ALS DGM | Austria | 10 m (federal), 1 m (states) | DTM LiDAR | dm | CC BY 4.0 (data.gv.at) [unv] | downloads per state | – | probably [not tested] |
| Spain MDT05 / MDT02 (IGN/CNIG) | Spain | 5 / 2 m | DTM LiDAR | dm | CC BY 4.0 [unv] | CNIG download centre (licence acceptance); INSPIRE WCS [unv] | – | probably [not tested] |

**How others do it [doc/unv].**
- **Strava**: a crowd-sourced barometric basemap, with a public DEM where it has no data (see ELEVATION_ANALYSIS §2).
- **Garmin Connect**: "elevation corrections" from an undisclosed DEM. Komoot does not publish its source. Forum users assume DEMs,
  partly corrected from activities [unv].
- None of them is reproducible without their data. A national LiDAR DTM is the closest open equivalent to barometric truth.

## 3. Measurements

### 3.1 Metrics

- **Positions**: the pipeline's grid on Amalfi (refined OSM line plus the 1.6 m lane offset). On the 6 Drôme routes the GPS track is used,
  because those references are GPS tracks.
- **Reference**: on Amalfi, the Strava route interpolated at the projected point. On Drôme, the track's own elevation (barometric per
  the earlier study; the files say "GPS Track Editor").
- **asc/desc err**: mean |ascent or descent per 5 km segment − reference| with 3 m hysteresis.
- **seg std**: mean over segments of std(profile − reference), i.e. the RMS after removing each segment's offset.
- **std km 20–45**: std of the filtered (raw) error on Amalfi km 20–45.
- **corr**: 1/e length of the residual autocorrelation on km 20–45, after removing each segment's mean.

Bilinear sampling everywhere. Disk footprints r = 5/10/20 m and E/N shifts of ±30 m changed nothing for TINITALY or Copernicus
(raw std within 0.2 m), so registration is fine.

### 3.2 Amalfi (62 km, Strava reference: ascent 936 m)

| Source / strategy | asc / desc err (m) | asc err km 20–45 | seg std | std km 20–45 filt. (raw) | std rest filt. (raw) | corr (m) | total up |
|---|---|---|---|---|---|---|---|
| Copernicus GLO-30 (today) | 7.5 / 7.3 | 13.8 | 4.8 | 10.1 (21.0) | 3.3 (6.6) | 380 | 985 |
| FABDEM | 7.1 / 5.3 | 11.3 | 4.5 | 9.2 (19.9) | 3.1 (6.3) | 315 | 966 |
| GEDTM30 | 7.3 / 9.4 | 14.4 | 4.8 | 9.2 (19.3) | 3.8 (6.3) | 320 | 968 |
| EU_DTM | 9.4 / 11.2 | 12.2 | 5.5 | 10.0 (19.5) | 4.7 (7.7) | 290 | 1040 |
| AW3D30 | 7.6 / 9.7 | 11.9 | 4.8 | 8.0 (16.7) | 6.8 (8.9) | 295 | 956 |
| NASADEM | 6.3 / 7.5 | 9.8 | 4.5 | 6.8 (18.2) | 4.0 (7.7) | 290 | 970 |
| SRTM GL1 | 7.3 / 10.0 | 11.3 | 5.2 | 8.9 (20.9) | 4.5 (9.0) | 305 | 1012 |
| EU-DEM 25 m (OpenTopoData, 20 m spacing) | 19.5 / 19.9 | 24.1 | 7.4 | 11.0 (22.3) | 6.5 (10.4) | 285 | 1192 |
| Terrarium z14 | 16.8 / 16.8 | 21.9 | 8.0 | 11.3 (24.2) | 7.2 (11.8) | 295 | 1154 |
| TINITALY 10 m | 5.8 / 7.5 | 6.9 | 5.7 | 7.5 (11.3) | 5.7 (8.2) | 340 | 977 |
| **Cop, filled px → TINITALY** | **4.1** / 6.5 | **6.2** | 4.1 | 6.4 (10.8) | 3.6 (6.7) | 340 | 941 |
| Cop, filled px → mean(AW3D30, NASADEM) | 5.9 / 6.4 | 8.5 | 3.8 | 6.0 (15.0) | 4.0 (6.5) | 275 | 935 |
| median(TINITALY, Cop, NASADEM) | 4.8 / 5.1 | 6.6 | 3.5 | 5.3 (14.9) | 3.2 (6.1) | 250 | 929 |

**What this shows.**
- Only TINITALY cuts the *raw* error on the cliffs (11 vs 21 m). The fusions then let the filter do the rest.
- The error length scale stays 250 to 380 m for all sources. The remaining error is still climb-sized, so no filter will remove it.
- Strava is not ground truth (ELEVATION_ANALYSIS §2). Differences under about 1 m between strategies are noise.

**Per segment for "Cop, filled → TINITALY"** (ascent ref/ours, descent ref/ours, std):
- km 20–25: 109/101, 47/31, 10.0
- km 25–30: 62/68, 50/59, 4.9
- km 35–40: 141/129, 57/44, 5.8
- km 40–45: 144/144, 22/25, 4.3. Today this segment is 144/173.

All other segments are within 13 m.

### 3.3 Cross-check: 6 Drôme routes (Vallée de la Roanne and neighbours) with barometric GPS references

Each cell is (asc+desc err)/2 / seg std, in m. The last column is the mean over all 7 routes (France only in brackets).

| Strategy | Amalfi | Roanne | Aucelon | Grimone | Pennes | Rousset | Pontaix | mean |
|---|---|---|---|---|---|---|---|---|
| Copernicus (today) | 7.4/4.8 | 5.3/2.3 | 4.9/3.3 | 9.1/8.6 | 4.0/4.1 | 3.1/2.5 | 1.1/2.5 | 5.0 / 4.01 (4.6 / 3.88) |
| FABDEM | 6.2/4.5 | 3.5/2.2 | 5.6/2.9 | 8.4/8.8 | 5.0/4.2 | 2.8/2.5 | 3.5/2.1 | 5.0 / 3.89 |
| GEDTM30 | 8.4/4.8 | 3.7/2.0 | 6.8/2.7 | 6.9/7.2 | 6.5/4.3 | 3.4/2.9 | 2.6/2.1 | 5.5 / 3.71 |
| AW3D30 | 8.7/4.8 | 2.7/2.1 | 6.4/4.2 | 6.7/3.9 | 5.7/4.4 | 2.6/2.9 | 2.6/2.2 | 5.1 / 3.49 |
| NASADEM | 6.9/4.5 | 5.0/2.9 | 4.5/4.3 | 8.5/6.2 | 5.0/4.7 | 4.2/3.1 | 1.5/2.7 | 5.1 / 4.07 |
| median of 5 global | 6.4/4.3 | 4.7/1.9 | 4.1/3.3 | 7.7/7.8 | 3.7/4.1 | 2.6/2.5 | 1.1/2.2 | 4.3 / 3.71 |
| Cop, filled → AW3D30 | 8.2/4.6 | 5.2/2.3 | 4.9/3.3 | 6.2/4.0 | 4.0/4.1 | 3.0/2.5 | 1.1/2.4 | 4.7 / 3.31 |
| **Cop, filled → mean(AW3D30, NASADEM)** | 6.1/3.8 | 5.2/2.2 | 4.9/3.3 | 7.5/5.1 | 4.0/4.1 | 3.1/2.5 | 1.1/2.4 | 4.6 / 3.33 (4.3 / 3.25) |
| **National DTM** (TINITALY / IGN RGE ALTI) | 6.6/5.7 | 3.2/1.1 | 3.7/2.0 | 1.4/1.0 | 4.4/3.7 | 2.6/2.0 | 1.6/1.4 | 3.4 / 2.42 (**2.8 / 1.87**) |
| Cop, filled → national DTM | 5.3/4.1 | 3.8/2.0 | 4.9/3.3 | 3.3/1.8 | 4.0/4.1 | 2.7/2.5 | 1.0/2.4 | 3.6 / 2.88 |

Filled share of the road per route: Amalfi 38 %, Grimone 20 %, Roanne 6 %, Rousset 3 %, Pontaix 2 %, Aucelon and Pennes 0 %.

**Caveat.** IGN fits Grimone at 1.0 m. That is suspiciously good, and it could mean the "GPS Track Editor" reference was itself
corrected from a DEM. Even without Grimone, IGN is best or equal on 5 of 6 routes.

## 4. Recommendation

1. **Everywhere, at low cost: download the Copernicus FLM mask with each tile and replace void-filled pixels.**
   - The fill uses mean(AW3D30, NASADEM) from the OpenTopography public mirror, about 12 MB more per 1° tile, but only for tiles where
     the route has filled pixels.
   - Measured: seg std 4.0 → 3.3 m over 7 routes, Amalfi km 20–45 ascent error 13.8 → 8.5 m, no change where nothing is filled.
2. **Countries with an open LiDAR DTM: use the national DTM outright, with Copernicus only as nodata fallback.**
   - Tested: France, IGN RGE ALTI through WMS-R; seg std 3.9 → 1.9 m.
   - Next candidates, not tested: Bavaria DGM1, swissALTI3D, Austria, Spain MDT. Add each only after a reference route confirms it.
3. **Countries whose national DTM is not LiDAR (Italy, TINITALY): use it only on Copernicus-filled pixels.** Amalfi 5 km ascent error
   7.5 → 4.1 m. TINITALY costs 63 MB per 50×50 km tile, so make it optional ("high-accuracy elevation for Italy").
4. **Do not use** FABDEM (NC licence), GEDTM30, EU_DTM, EU-DEM, Terrarium or Open-Meteo: no gain, or worse.
5. The 3-way median (national, Cop, NASADEM) is slightly better on Amalfi but worse on Grimone (7.3/6.1). Do not adopt it.

## 5. Implementation sketch for `dem.py` (not implemented)

- **Sources as a registry**: `Source(name, kind, covers(bbox), tiles(bbox), fetch(tile, dst), sample(lat, lon), attribution)`.
  - `kind` is one of `base` (Copernicus), `fill` (AW3D30, NASADEM), `dtm_full` (IGN, later DGM1 and swissALTI3D) and `dtm_fill` (TINITALY).
  - Coverage is a country polygon or bbox list shipped with the app. A coarse Natural Earth polygon, a few KB, is enough.
- **Selection per route bbox**:
  1. Copernicus DEM + FLM.
  2. If a `dtm_full` source covers a sample, take it there.
  3. Otherwise, where FLM ∉ {1, 2}, take `dtm_fill` if present, else mean(AW3D30, NASADEM).
  4. Weights are feathered with a Gaussian of 30 m on the 5 m grid, as in the prototype (`w = clip(2·gauss(filled), 0, 1)`).
  5. Before blending, align vertical datums: shift each secondary source by median(z_cop − z_src) over the route's TanDEM-X samples
     (FLM 2). Measured offsets are small (Cop −0.7, TINITALY −0.9, NASADEM −0.6, AW3D30 −5.5 m vs Strava), but a step at every
     transition would count as ascent.
- **Filter**: unchanged. Clean sources lower the local noise, so the existing noise-adaptive branch adapts by itself (measured above with
  the unchanged filter).
- **Reader**:
  - FLM is uint8 DEFLATE with predictor 2. NASADEM is int16 DEFLATE. AW3D30 is int16 **LZW**, which needs an LZW decoder (own,
    about 40 lines, or `tifffile`/`imagecodecs`).
  - TINITALY is a stripped, uncompressed UTM32 GeoTIFF and IGN is raw BIL in Lambert-93. Convert both on download into the cache's
    own tiled float32 format, and sample through pyproj.
- **Cache**: `dem/<source>/<tile>.tif` beside today's Copernicus tiles, with the same once-per-area download and a size estimate shown
  before the download. IGN: request only the 10 km blocks touched by the route (16 MB raw each, about 5 MB deflated). TINITALY: one 50 km
  zip, keep only the window, cropped to the route bbox plus 1 km.
- **Attribution** (GPX metadata, export dialog, About):
  - "Copernicus DEM GLO-30 © DLR/Airbus…" (existing).
  - "ALOS AW3D30 © JAXA".
  - "NASADEM: NASA JPL".
  - "TINITALY 1.1, Tarquini et al. 2023, INGV, CC BY 4.0, doi:10.13127/tinitaly/1.1".
  - "RGE ALTI® © IGN, Licence Ouverte 2.0".
  - Only the sources actually used are listed.

## 6. Effort and risk

| Step | Effort | Risk |
|---|---|---|
| FLM download + fill with mean(AW3D30, NASADEM) | 1.5–2 days incl. LZW/int16 reader, tests, PIPELINE_CLI | OpenTopography's S3 bucket is a research mirror, not a contracted endpoint: fair use, may change. Fallback: NASADEM alone (public domain). AW3D30 redistribution terms not verified |
| IGN RGE ALTI source (France) | 1 day | Géoplateforme availability or limits; quality outside LiDAR HD areas varies |
| TINITALY (Italy, fill only) | 1 day | 63 MB per tile download; tested on one route only, against Strava, which is not truth |
| Further national DTMs (DE-BY, CH, AT, ES) | 0.5–1 day each + one reference route each | licences marked [unv] must be checked first |

**Not verified.**
- No second Italian route.
- No route with real ground truth on a filled stretch (references are Strava or barometric GPS).
- AW3D30 and Spain/Austria licence details.
- Mittenwald was not used: no reference elevation was checked.

## 7. Downloads made for this study

All open, no login, no payment. The only data sent out were route coordinates of public roads, to OpenTopoData.

| File / request | Source | Size |
|---|---|---|
| `w45095_s10.zip` (TINITALY 1.1 tile) | tinitaly.pi.ingv.it/data_1.1/ | 63.1 MB |
| `Copernicus_DSM_COG_10_N40_00_E014_00_{EDM,FLM,HEM,WBM}.tif` | copernicus-dem-30m.s3.amazonaws.com …/AUXFILES/ | 0.20 + 0.20 + 16.8 + 0.08 MB |
| `Copernicus_DSM_COG_10_N44_00_E005_00_{EDM,FLM,HEM}.tif` | same | 0.39 + 0.39 + 51.4 MB |
| Windowed range reads, Amalfi bbox (COP30, AW3D30, NASADEM, SRTM GL1, EU_DTM, GEDTM30 from opentopography.s3.sdsc.edu; FABDEM N40E014 from data.bris.ac.uk zip by range request) | as listed | 19.3 MB transferred |
| Same for Drôme bbox (N44E005, FABDEM zip N40E000-N50E010) | as listed | 62.4 MB transferred |
| IGN RGE ALTI, 9 blocks 10×10 km at 5 m, float32 BIL | data.geopf.fr/wms-r | 144 MB |
| Terrarium z14, 30 PNG tiles | s3.amazonaws.com/elevation-tiles-prod | 2.2 MB |
| OpenTopoData `eudem25m`, `mapzen`: 2 × 3126 points (32 requests each) | api.opentopodata.org | < 1 MB |

Total about 360 MB of data, plus the rasterio/pyproj/pillow wheels from PyPI for the study venv.
