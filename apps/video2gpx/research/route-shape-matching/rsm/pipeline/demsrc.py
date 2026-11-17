# SPDX-License-Identifier: AGPL-3.0-or-later
"""Elevation sources beside the Copernicus GLO-30 base (which stays in the root of the DEM directory, downloaded by the app):
a registry of open global, national and regional DEMs, per-area on-demand download with a size estimate, a cache under
<dem_dir>/<source>/, sampling through pyproj. numpy + zlib + pyproj only (no GDAL).

Kinds:
- mask:  the Copernicus fill mask (FLM): which pixels are TanDEM-X and which are void fill (ASTER, SRTM, ...).
- fill:  global DSMs used where Copernicus is void-filled (NASADEM; AW3D30 is disabled until its terms are verified).
- dtm:   national / regional terrain models (LiDAR or contour-derived), used wherever they have data.

The route decides what is fetched: the blocks of each covering source that lie within PAD_M of the route (not the whole bbox).
A block the provider does not have (outside its area, 404, all nodata) gets a `.none` marker. Licences: see docs/ELEVATION_STRATEGY.md;
a source with status "unverified" is never enabled by default."""
from __future__ import annotations

import io
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .tiff import UA, HttpSource, Tiff, UnsupportedTiff

PAD_M = 60.0                 # blocks within this distance of the route are fetched (the corridor samples reach +-15 m)
TIMEOUT_S = 90.0
POLITE_S = 0.2               # pause between two block requests


class BytesSource:
    def __init__(self, b: bytes, name: str = "memory"):
        self.b, self.name = b, name

    def read(self, off: int, n: int) -> bytes:
        return self.b[off:off + n]

    def close(self):
        pass


class NoData(Exception):
    """the provider has no data for this block (outside its area)"""


def http_get(url: str, timeout: float = TIMEOUT_S, retries: int = 3) -> bytes:
    last = None
    for k in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (404, 410):                                   # the provider has no such file / block
                raise NoData(f"HTTP {e.code}") from e
            last = e
        except OSError as e:
            last = e
        time.sleep(1.5 * (k + 1))
    raise OSError(f"download failed: {url.split('?')[0]}: {last}")


_TR: dict = {}


def transformer(epsg: int, inverse: bool = False):
    from pyproj import Transformer
    k = (epsg, inverse)
    if k not in _TR:
        _TR[k] = Transformer.from_crs(epsg, 4326, always_xy=True) if inverse else Transformer.from_crs(4326, epsg, always_xy=True)
    return _TR[k]


def in_boxes(lon, lat, boxes) -> np.ndarray:
    lon, lat = np.asarray(lon, float), np.asarray(lat, float)
    m = np.zeros(len(lon), bool)
    for w, s, e, n in boxes:
        m |= (lon >= w) & (lon <= e) & (lat >= s) & (lat <= n)
    return m


def block_mean(a: np.ndarray, f: int) -> np.ndarray:
    """f x f block mean, NaN-aware (a pixel of the result is NaN only if all f*f inputs are)"""
    if f <= 1:
        return a.astype(np.float32)
    h, w = (a.shape[0] // f) * f, (a.shape[1] // f) * f
    b = a[:h, :w].reshape(h // f, f, w // f, f)
    with np.errstate(invalid="ignore"):
        cnt = np.isfinite(b).sum(axis=(1, 3))
        s = np.nansum(b, axis=(1, 3))
    return np.where(cnt > 0, s / np.maximum(cnt, 1), np.nan).astype(np.float32)


@dataclass
class Source:
    name: str
    title: str
    kind: str                       # mask | fill | dtm
    region: str
    res_m: float                    # stored resolution
    sigma_m: float                  # vertical noise at the road used by the estimator (prior)
    dsm: bool                       # surface model (trees, roofs only raise it)
    offsets: tuple                  # lateral corridor offsets (m) sampled by the estimator
    licence: str
    attribution: str
    status: str                     # verified | unverified
    coverage: list                  # lon/lat boxes (W, S, E, N): coarse, a block outside the real area becomes a `.none` marker
    est_block_bytes: int
    enabled: bool = True
    url: str = ""
    epsg: int = 4326
    block_m: float = 0.0
    note: str = ""
    extra: dict = field(default_factory=dict)

    # ---- blocks
    def covers(self, lon, lat) -> np.ndarray:
        return in_boxes(lon, lat, self.coverage)

    def blocks(self, lon, lat) -> list[str]:
        lon, lat = np.asarray(lon, float), np.asarray(lat, float)
        m = self.covers(lon, lat)
        if not m.any():
            return []
        x, y = transformer(self.epsg).transform(lon[m], lat[m])
        x, y = np.asarray(x, float), np.asarray(y, float)
        keys = set()
        pad = PAD_M / 111_320.0 if self.epsg == 4326 else PAD_M
        for dx in (-pad, 0.0, pad):
            for dy in (-pad, 0.0, pad):
                for k in self._keys(x + dx, y + dy):
                    keys.add(k)
        return sorted(keys)

    def _keys(self, x, y):
        return set(self.key_of(x, y))

    def key_of(self, x, y) -> list[str]:
        """the cache block of each point (source CRS)"""
        bx, by = np.floor(np.asarray(x) / self.block_m).astype(np.int64), np.floor(np.asarray(y) / self.block_m).astype(np.int64)
        return [f"{a}_{b}" for a, b in zip(bx.tolist(), by.tolist())]

    def path(self, d: Path, key: str) -> Path:
        return Path(d) / self.name / f"{key}.npz"

    def state(self, d: Path, key: str) -> str:
        p = self.path(d, key)
        if p.exists():
            return "present"
        if p.with_suffix(".none").exists():
            return "none"
        return "missing"

    # ---- download: returns bytes transferred
    def fetch(self, d: Path, key: str) -> int:
        dst = self.path(d, key)
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            z, x00, y00, res, nbytes = self.get_block(key, Path(d))
        except NoData:
            dst.with_suffix(".none").write_text(f"{self.name}: no data for block {key}\n")
            return 0
        if z is None or not np.isfinite(z).any():
            dst.with_suffix(".none").write_text(f"{self.name}: no data for block {key}\n")
            return nbytes
        tmp = dst.with_suffix(".part.npz")
        np.savez_compressed(tmp, z=z.astype(np.float32), x00=x00, y00=y00, res=res, epsg=self.epsg)
        os.replace(tmp, dst)
        return nbytes

    def get_block(self, key: str, d: Path):
        raise NotImplementedError

    def bbox(self, key: str):
        bx, by = (int(v) for v in key.split("_"))
        return bx * self.block_m, by * self.block_m, (bx + 1) * self.block_m, (by + 1) * self.block_m

    # ---- sampling
    def open(self, d: Path) -> "BlockSampler":
        return BlockSampler(self, Path(d))


class BlockSampler:
    """bilinear sampling of the cached blocks of one source; NaN where there is no block or no data"""

    def __init__(self, src: Source, d: Path):
        self.src, self.d = src, d
        self.cache: dict[str, tuple | None] = {}

    def _block(self, key):
        if key not in self.cache:
            p = self.src.path(self.d, key)
            if p.exists():
                with np.load(p) as f:
                    self.cache[key] = (f["z"], float(f["x00"]), float(f["y00"]), float(f["res"]))
            else:
                self.cache[key] = None
            if len(self.cache) > 96:
                self.cache.pop(next(iter(self.cache)))
        return self.cache[key]

    def sample(self, lat, lon) -> np.ndarray:
        lat, lon = np.asarray(lat, float), np.asarray(lon, float)
        out = np.full(len(lat), np.nan)
        m = self.src.covers(lon, lat)
        if not m.any():
            return out
        x, y = transformer(self.src.epsg).transform(lon[m], lat[m])
        x, y = np.asarray(x, float), np.asarray(y, float)
        keys = np.array(self.src.key_of(x, y))
        idx = np.flatnonzero(m)
        res = np.full(len(x), np.nan)
        for key in set(keys.tolist()):
            sel = keys == key
            B = self._block(key)
            if B is None:
                continue
            z, x00, y00, r = B
            fx, fy = (x[sel] - x00) / r, (y00 - y[sel]) / r
            c0 = np.clip(np.floor(fx).astype(np.int64), 0, z.shape[1] - 2); r0 = np.clip(np.floor(fy).astype(np.int64), 0, z.shape[0] - 2)
            ax, ay = np.clip(fx - c0, 0, 1), np.clip(fy - r0, 0, 1)
            res[sel] = (z[r0, c0] * (1 - ax) * (1 - ay) + z[r0, c0 + 1] * ax * (1 - ay) + z[r0 + 1, c0] * (1 - ax) * ay
                        + z[r0 + 1, c0 + 1] * ax * ay)
        out[idx] = res
        return out

    def close(self):
        self.cache.clear()


# ------------------------------------------------------------------ source kinds
class DegreeTiles(Source):
    """1 x 1 degree GeoTIFF files, kept as downloaded (`<tile>.tif`), read lazily with tiff.Tiff"""

    def _keys(self, x, y):
        return {self.extra["tile"](int(a), int(b)) for a, b in zip(np.floor(y).astype(int).tolist(), np.floor(x).astype(int).tolist())}

    def path(self, d, key):
        return Path(d) / self.name / f"{key}.tif"

    def fetch(self, d, key):
        dst = self.path(d, key)
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            b = http_get(self.url.format(key=key))
        except NoData:
            dst.with_suffix(".none").write_text(f"{self.name}: no tile {key} (sea or outside)\n")
            return 0
        if b[:4] not in (b"II*\0", b"MM\0*"):
            raise OSError(f"{self.name} {key}: not a TIFF")
        Tiff(BytesSource(b, key))                     # refuse a format we cannot read before it lands in the cache
        tmp = dst.with_suffix(".part")
        tmp.write_bytes(b)
        os.replace(tmp, dst)
        return len(b)

    def open(self, d):
        return TileSampler(self, Path(d))


class TileSampler:
    def __init__(self, src: DegreeTiles, d: Path):
        self.src, self.d, self.t = src, d, {}

    def sample(self, lat, lon, nearest: bool = False) -> np.ndarray:
        lat, lon = np.asarray(lat, float), np.asarray(lon, float)
        out = np.full(len(lat), np.nan)
        la, lo = np.floor(lat).astype(int), np.floor(lon).astype(int)
        for a, b in set(zip(la.tolist(), lo.tolist())):
            key = self.src.extra["tile"](a, b)
            if key not in self.t:
                p = self.src.path(self.d, key)
                self.t[key] = Tiff(p, clamp=True) if p.exists() else None
            T = self.t[key]
            if T is None:
                continue
            m = (la == a) & (lo == b)
            if nearest:
                c = np.rint((lon[m] - T.x00) / T.dx).astype(np.int64); r = np.rint((T.y00 - lat[m]) / T.dy).astype(np.int64)
                out[m] = T.pixel(r, c)
            else:
                out[m] = T.sample(lon[m], lat[m])
        return out

    def close(self):
        for T in self.t.values():
            if T is not None:
                T.close()


def _cop_tile(lat, lon):
    return f"Copernicus_DSM_COG_10_{'N' if lat >= 0 else 'S'}{abs(lat):02d}_00_{'E' if lon >= 0 else 'W'}{abs(lon):03d}_00"


def _deg(lat, lon, up=False):
    ns, ew = ("N" if lat >= 0 else "S"), ("E" if lon >= 0 else "W")
    if up:
        return f"{ns}{abs(lat):03d}{ew}{abs(lon):03d}"
    return f"{ns.lower()}{abs(lat):02d}{ew.lower()}{abs(lon):03d}"


class Wcs(Source):
    """OGC WCS 2.0.1 GetCoverage of one block as GeoTIFF (GeoServer, MapServer); extra: coverage, axes, params"""

    def get_block(self, key, d):
        x0, y0, x1, y1 = self.bbox(key)
        p = self.res_m                                                   # one stored pixel of overlap: bilinear never clamps inside the block
        x0, y0, x1, y1 = x0 - p, y0 - p, x1 + p, y1 + p
        ax, ay = self.extra.get("axes", ("E", "N"))
        q = [("SERVICE", "WCS"), ("VERSION", "2.0.1"), ("REQUEST", "GetCoverage"), ("COVERAGEID", self.extra["coverage"]), ("FORMAT", "image/tiff"),
             ("SUBSET", f"{ax}({x0:.0f},{x1:.0f})"), ("SUBSET", f"{ay}({y0:.0f},{y1:.0f})")] + list(self.extra.get("params", []))
        b = http_get(self.url + "?" + urllib.parse.urlencode(q))
        if b[:4] not in (b"II*\0", b"MM\0*"):                      # an exception report: a server problem, retried next time
            raise OSError(f"{self.name} {key}: not a GeoTIFF: {b[:160].decode('latin-1', 'replace')}")
        T = Tiff(BytesSource(b, key), clamp=True)
        z = T.window(0, 0, T.H, T.W)
        f = int(round(self.res_m / T.dx))
        if f > 1:
            z = block_mean(z, f)
            return z, T.x00 + (f - 1) * T.dx / 2, T.y00 - (f - 1) * T.dy / 2, T.dx * f, len(b)
        return z, T.x00, T.y00, T.dx, len(b)


class WmsBil(Source):
    """IGN Geoplateforme WMS-R, raw float32 BIL"""

    def get_block(self, key, d):
        x0, y0, x1, y1 = self.bbox(key)
        x0, y0, x1, y1 = x0 - self.res_m, y0 - self.res_m, x1 + self.res_m, y1 + self.res_m     # one pixel of overlap
        n = int(round((x1 - x0) / self.res_m))
        q = [("SERVICE", "WMS"), ("VERSION", "1.3.0"), ("REQUEST", "GetMap"), ("LAYERS", self.extra["layer"]), ("STYLES", ""), ("CRS", f"EPSG:{self.epsg}"),
             ("BBOX", f"{x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f}"), ("WIDTH", str(n)), ("HEIGHT", str(n)), ("FORMAT", "image/x-bil;bits=32")]
        b = http_get(self.url + "?" + urllib.parse.urlencode(q))
        if len(b) != n * n * 4:                                       # an exception report or a cut transfer: retried next time
            raise OSError(f"{self.name} {key}: unexpected response of {len(b)} bytes: {b[:160].decode('latin-1', 'replace')}")
        z = np.frombuffer(b, "<f4").reshape(n, n).astype(np.float32)
        z = np.where((z < -1000) | (z > 9000), np.nan, z)
        return z, x0 + self.res_m / 2, y1 - self.res_m / 2, self.res_m, len(b)


class TileTif(Source):
    """the provider's own tile files (1 km GeoTIFFs), resampled to res_m by a block mean. extra['url'](self, key, d) -> URL or None"""

    def get_block(self, key, d):
        u = self.extra["url"](self, key, d)
        if u is None:
            raise NoData("no tile")
        b = http_get(u)
        if b[:4] not in (b"II*\0", b"MM\0*"):
            raise OSError(f"{self.name} {key}: not a TIFF")
        T = Tiff(BytesSource(b, key), clamp=True)
        z = T.window(0, 0, T.H, T.W)
        f = max(1, int(round(self.res_m / T.dx)))
        z = block_mean(z, f)
        return z, T.x00 + (f - 1) * T.dx / 2, T.y00 - (f - 1) * T.dy / 2, T.dx * f, len(b)


class CogTiles(Source):
    """internal tiles of large remote COGs (range requests), one cache block per internal tile; extra['file'](x, y) -> (url, x_origin, y_origin)"""
    _open: dict = {}

    def key_of(self, x, y):
        out = []
        for xi, yi in zip(np.asarray(x).tolist(), np.asarray(y).tolist()):
            fid, fx, fy = self.extra["file"](xi, yi)
            out.append(f"{fid}_{int((xi - fx) // self.block_m)}_{int((fy - yi) // self.block_m)}")
        return out

    def get_block(self, key, d):
        fid, c, r = key.rsplit("_", 2)
        url = self.extra["url"](fid)
        T = CogTiles._open.get(url)
        if T is None:
            try:
                T = Tiff(HttpSource(url, TIMEOUT_S), clamp=False)
            except OSError as e:
                if "404" in str(e) or "403" in str(e):
                    raise NoData(str(e)) from e
                raise
            CogTiles._open[url] = T
        before = T.src.bytes_read
        tpx = int(round(self.block_m / T.dx))
        z = T.window(int(r) * tpx, int(c) * tpx, tpx, tpx)
        f = max(1, int(round(self.res_m / T.dx)))
        z = block_mean(z, f)
        x00 = T.x00 + int(c) * tpx * T.dx + (f - 1) * T.dx / 2
        y00 = T.y00 - int(r) * tpx * T.dy - (f - 1) * T.dy / 2
        return z, x00, y00, T.dx * f, T.src.bytes_read - before


# ------------------------------------------------------------------ provider-specific tile lookups
def _by_url(src, key, d):
    a, b = (int(v) for v in key.split("_"))
    return f"https://download1.bayernwolke.de/a/dgm/dgm1/{a}_{b}.tif"


def _nw_url(src, key, d):
    idx = Path(d) / src.name / "index.json"
    if not idx.exists():
        idx.parent.mkdir(parents=True, exist_ok=True)
        b = http_get(src.url + "index.json")
        tmp = idx.with_suffix(".part"); tmp.write_bytes(b); os.replace(tmp, idx)
    names = getattr(src, "_names", None)
    if names is None:
        j = json.loads(idx.read_text(encoding="utf-8"))
        names = {}
        for ds in j.get("datasets", []):
            for f in ds.get("files", []):
                n = f["name"]                                       # dgm1_32_280_5652_1_nw_2022.tif
                p = n.split("_")
                if len(p) >= 4 and n.endswith(".tif"):
                    names[f"{p[2]}_{p[3]}"] = n
        src._names = names
    n = names.get(key)
    return src.url + n if n else None


def _ch_url(src, key, d):
    a, b = (int(v) for v in key.split("_"))
    lon, lat = transformer(2056, inverse=True).transform((a + 0.5) * 1000.0, (b + 0.5) * 1000.0)
    q = urllib.parse.urlencode({"bbox": f"{lon - 0.001},{lat - 0.001},{lon + 0.001},{lat + 0.001}", "limit": 20})
    j = json.loads(http_get(f"{src.url}?{q}").decode("utf-8"))
    best = None
    for it in j.get("features", []):
        if not it["id"].endswith(f"_{a}-{b}"):
            continue
        for an, asset in it.get("assets", {}).items():
            if an.endswith(".tif") and "_2_2056_" in an:
                yr = it["id"].split("_")[1]
                if best is None or yr > best[0]:
                    best = (yr, asset["href"])
    return best[1] if best else None


def _at_file(x, y):
    E, N = int(x // 50000) * 50000, int(y // 50000) * 50000
    return f"N{N}E{E}", float(E), float(N + 50000)


# ------------------------------------------------------------------ the registry
EUROPE = [(-11.0, 34.0, 32.0, 72.0)]
SOURCES: dict[str, Source] = {}


def _reg(s: Source):
    SOURCES[s.name] = s
    return s


_reg(DegreeTiles(
    name="cop_flm", title="Copernicus DEM GLO-30 fill mask (FLM)", kind="mask", region="global", res_m=30, sigma_m=0, dsm=False, offsets=(0,),
    licence="Copernicus DEM licence (free use with attribution)", attribution="Copernicus DEM GLO-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA",
    status="verified", coverage=[(-180, -90, 180, 90)], est_block_bytes=300_000,
    url="https://copernicus-dem-30m.s3.amazonaws.com/{key}_DEM/AUXFILES/{key}_FLM.tif", extra=dict(tile=_cop_tile)))
_reg(DegreeTiles(
    name="nasadem", title="NASADEM (SRTM reprocessed)", kind="fill", region="60 S - 60 N", res_m=30, sigma_m=5.0, dsm=True, offsets=(-15, 0, 15),
    licence="public domain (NASA)", attribution="NASADEM: NASA JPL (2020), public domain; served by the OpenTopography mirror",
    status="verified", coverage=[(-180, -60, 180, 60)], est_block_bytes=16_000_000,
    url="https://opentopography.s3.sdsc.edu/raster/NASADEM/NASADEM_be/NASADEM_HGT_{key}.tif", extra=dict(tile=lambda a, b: _deg(a, b))))
_reg(DegreeTiles(
    name="aw3d30", title="ALOS World 3D-30m (AW3D30)", kind="fill", region="global", res_m=30, sigma_m=5.0, dsm=True, offsets=(-15, 0, 15),
    licence="JAXA terms of use (free of charge; redistribution / derived-data wording NOT verified)", attribution="AW3D30 (c) JAXA",
    status="unverified", enabled=False, coverage=[(-180, -90, 180, 90)], est_block_bytes=20_000_000,
    url="https://opentopography.s3.sdsc.edu/raster/AW3D30/AW3D30_global/ALPSMLC30_{key}_DSM.tif", extra=dict(tile=lambda a, b: _deg(a, b, True)),
    note="the JAXA terms page could not be read (script-rendered); measured useful as a second fill (DEM_STUDY), enable only after checking the terms"))
_reg(WmsBil(
    name="fr_rgealti", title="IGN RGE ALTI (France)", kind="dtm", region="France", res_m=5.0, sigma_m=0.7, dsm=False, offsets=(-6, -3, 0, 3, 6),
    licence="Licence Ouverte 2.0 (Etalab)", attribution="RGE ALTI (c) IGN, Licence Ouverte 2.0", status="verified",
    coverage=[(-5.2, 42.3, 8.3, 51.1), (8.5, 41.3, 9.6, 43.1)], est_block_bytes=1_000_000, url="https://data.geopf.fr/wms-r",
    epsg=2154, block_m=2500.0, extra=dict(layer="ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES")))
_reg(Wcs(
    name="it_tinitaly", title="TINITALY 1.1 (Italy, INGV)", kind="dtm", region="Italy", res_m=10.0, sigma_m=3.5, dsm=False, offsets=(-10, -5, 0, 5, 10),
    licence="CC BY 4.0", attribution="TINITALY 1.1, Tarquini et al. (2023), INGV, CC BY 4.0, doi:10.13127/tinitaly/1.1", status="verified",
    coverage=[(6.6, 36.6, 18.6, 47.1)], est_block_bytes=850_000, url="https://tinitaly.pi.ingv.it/TINItaly_1_1/wcs", epsg=32632, block_m=5000.0,
    extra=dict(coverage="TINItaly_1_1__tinitaly_dem", params=[("GEOTIFF:COMPRESSION", "DEFLATE"), ("GEOTIFF:TILING", "true"),
                                                               ("GEOTIFF:TILEWIDTH", "256"), ("GEOTIFF:TILEHEIGHT", "256")])))
_reg(Wcs(
    name="it_bz_dtm", title="DTM 2.5 m South Tyrol (LiDAR, Autonomous Province of Bolzano)", kind="dtm", region="South Tyrol", res_m=2.5, sigma_m=0.5,
    dsm=False, offsets=(-5, -2.5, 0, 2.5, 5), licence="CC0 1.0", attribution="DTM 2.5 m (c) Autonome Provinz Bozen - Suedtirol, CC0 1.0", status="verified",
    coverage=[(10.38, 46.21, 12.48, 47.10)], est_block_bytes=700_000, url="https://geoservices9.civis.bz.it/geoserver/ows", epsg=25832, block_m=1250.0,
    extra=dict(coverage="p_bz-Elevation__DigitalTerrainModel-2.5m", params=[("GEOTIFF:COMPRESSION", "DEFLATE"), ("GEOTIFF:TILING", "true"),
                                                                          ("GEOTIFF:TILEWIDTH", "256"), ("GEOTIFF:TILEHEIGHT", "256")])))
_reg(TileTif(
    name="ch_swissalti3d", title="swissALTI3D 2 m (Switzerland, swisstopo)", kind="dtm", region="Switzerland, Liechtenstein", res_m=2.0, sigma_m=0.5,
    dsm=False, offsets=(-4, -2, 0, 2, 4), licence="swisstopo free geodata (OGD): free use incl. commercial, source reference mandatory",
    attribution="swissALTI3D (c) swisstopo", status="verified", coverage=[(5.95, 45.81, 10.50, 47.81)], est_block_bytes=1_100_000,
    url="https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissalti3d/items", epsg=2056, block_m=1000.0, extra=dict(url=_ch_url)))
_reg(CogTiles(
    name="at_als_dtm", title="ALS DTM Austria 1 m (BEV)", kind="dtm", region="Austria", res_m=2.0, sigma_m=0.5, dsm=False, offsets=(-4, -2, 0, 2, 4),
    licence="CC BY 4.0", attribution="ALS DTM (c) BEV - Bundesamt fuer Eich- und Vermessungswesen, CC BY 4.0", status="verified",
    coverage=[(9.53, 46.84, 10.0, 47.6), (10.0, 46.37, 13.0, 47.75), (13.0, 46.37, 17.17, 48.2), (12.75, 47.75, 17.17, 49.02)], est_block_bytes=160_000, epsg=3035, block_m=256.0,
    url="https://data.bev.gv.at/download/ALS/DTM/20250915/", extra=dict(file=_at_file,
                                                                       url=lambda fid: f"https://data.bev.gv.at/download/ALS/DTM/20250915/ALS_DTM_CRS3035RES50000m{fid}.tif")))
_reg(TileTif(
    name="de_by_dgm1", title="DGM1 Bavaria (LiDAR)", kind="dtm", region="Bavaria", res_m=2.0, sigma_m=0.5, dsm=False, offsets=(-4, -2, 0, 2, 4),
    licence="CC BY 4.0", attribution="DGM1 (c) Bayerische Vermessungsverwaltung - www.geodaten.bayern.de, CC BY 4.0", status="verified",
    coverage=[(8.97, 47.27, 13.84, 50.57)], est_block_bytes=2_500_000, epsg=25832, block_m=1000.0, url="https://download1.bayernwolke.de/a/dgm/dgm1/",
    extra=dict(url=_by_url)))
_reg(Wcs(
    name="de_he_dgm1", title="DGM1 Hesse (LiDAR, served at 2 m)", kind="dtm", region="Hesse", res_m=2.0, sigma_m=0.5, dsm=False, offsets=(-4, -2, 0, 2, 4),
    licence="Datenlizenz Deutschland - Zero - 2.0", attribution="DGM1 (c) Hessische Verwaltung fuer Bodenmanagement und Geoinformation (HVBG), dl-de/zero-2-0",
    status="verified", coverage=[(7.77, 49.39, 10.24, 51.66)], est_block_bytes=1_000_000, url="https://inspire-hessen.de/raster/dgm1/ows", epsg=25832,
    block_m=1000.0, extra=dict(coverage="he_dgm1_2")))
_reg(TileTif(
    name="de_nw_dgm1", title="DGM1 North Rhine-Westphalia (LiDAR)", kind="dtm", region="North Rhine-Westphalia", res_m=2.0, sigma_m=0.5, dsm=False,
    offsets=(-4, -2, 0, 2, 4), licence="Datenlizenz Deutschland - Zero - 2.0", attribution="DGM1 (c) Geobasis NRW, dl-de/zero-2-0", status="verified",
    coverage=[(5.86, 50.32, 7.9, 52.53), (7.9, 51.0, 9.46, 52.53), (7.9, 50.7, 8.3, 51.0)], est_block_bytes=2_400_000, epsg=25832, block_m=1000.0,
    url="https://www.opengeodata.nrw.de/produkte/geobasis/hm/dgm1_tiff/dgm1_tiff/", extra=dict(url=_nw_url),
    note="the first use downloads the tile index (about 3.6 MB)"))

# known open candidates that are NOT implemented (listed in docs/ELEVATION_STRATEGY.md): Slovenia (ARSO LiDAR), Trentino (PAT LiDAR, ASC zips),
# Lower Saxony, Baden-Wuerttemberg, Saxony, Thuringia, Brandenburg, Saxony-Anhalt, Rhineland-Palatinate, Schleswig-Holstein, Mecklenburg-Vorpommern.


def enabled_sources(names=None) -> list[Source]:
    env = os.environ.get("RSM_DEM_SOURCES")
    if names is None and env:
        names = [n.strip() for n in env.split(",") if n.strip()]
    if names is not None:
        return [SOURCES[n] for n in names if n in SOURCES]
    return [s for s in SOURCES.values() if s.enabled and s.status == "verified"]


def plan(lat, lon, dem_dir, names=None) -> dict:
    """which blocks of which sources the route needs, and which are in the cache. Offline (no request)."""
    lat, lon = np.asarray(lat, float), np.asarray(lon, float)
    items, by = [], {}
    srcs = enabled_sources(names)
    filled = None                                         # route points on void-filled Copernicus pixels (None: mask not cached yet)
    mask = SOURCES["cop_flm"]
    if dem_dir and all(mask.state(Path(dem_dir), k) != "missing" for k in mask.blocks(lon, lat)):
        v = mask.open(Path(dem_dir)).sample(lat, lon, nearest=True)
        filled = ~np.isin(np.nan_to_num(v, nan=0).astype(int), (0, 1, 2))
    for s in srcs:
        if s.kind == "fill":                             # a fill is only needed where Copernicus is void-filled
            if filled is not None and not filled.any():
                continue
            ks = s.blocks(lon[filled], lat[filled]) if filled is not None else s.blocks(lon, lat)
        else:
            ks = s.blocks(lon, lat)
        if not ks:
            continue
        for k in ks:
            st = s.state(Path(dem_dir), k) if dem_dir else "missing"
            items.append(dict(source=s.name, block=k, state=st, bytes=s.est_block_bytes if st == "missing" else 0))
        by[s.name] = dict(title=s.title, kind=s.kind, region=s.region, blocks=len(ks), conditional=bool(s.kind == "fill" and filled is None), missing=sum(1 for i in items if i["source"] == s.name and i["state"] == "missing"),
                          missing_bytes=int(sum(i["bytes"] for i in items if i["source"] == s.name and i["state"] == "missing")), licence=s.licence, attribution=s.attribution, status=s.status)
    miss = [i for i in items if i["state"] == "missing"]
    return dict(sources=by, items=items, missing_blocks=len(miss), missing_bytes=int(sum(i["bytes"] for i in miss)), exact=False)


def fetch(lat, lon, dem_dir, names=None, progress=None, cancel=None) -> dict:
    """download the missing blocks (sequentially, politely): the fill mask first, then a fresh plan for the rest (a fill source is only needed
    where the mask shows void-filled pixels). Errors of one source do not stop the others; they are reported."""
    done, nbytes, errors = 0, 0, {}
    first = [i for i in plan(lat, lon, dem_dir, names)["items"] if i["state"] == "missing" and SOURCES[i["source"]].kind == "mask"]
    total = None
    for phase in (0, 1):
        todo = first if phase == 0 else [i for i in plan(lat, lon, dem_dir, names)["items"] if i["state"] == "missing"]
        if phase == 1:
            total = done + len(todo)
        for i in todo:
            if cancel and cancel():
                return dict(ok=False, cancelled=True, fetched=done, bytes=nbytes, errors=errors)
            s = SOURCES[i["source"]]
            if s.name in errors and errors[s.name]["count"] >= 3:      # a source that keeps failing is skipped for this run
                continue
            try:
                time.sleep(POLITE_S)
                nbytes += s.fetch(Path(dem_dir), i["block"])
                done += 1
            except (OSError, UnsupportedTiff, ValueError) as e:
                er = errors.setdefault(s.name, dict(count=0, last=""))
                er["count"] += 1; er["last"] = str(e)[:300]
            if progress:
                progress(done, total if total is not None else len(first), nbytes, i)
    return dict(ok=not errors, fetched=done, of=total or done, bytes=nbytes, errors=errors)


class Multi:
    """samplers of the sources present for an area"""

    def __init__(self, dem_dir, names=None):
        self.d = Path(dem_dir)
        self.src = {s.name: s for s in enabled_sources(names)}
        self.samplers = {}

    def sampler(self, name):
        if name not in self.samplers:
            self.samplers[name] = self.src[name].open(self.d)
        return self.samplers[name]

    def sample(self, name, lat, lon) -> np.ndarray:
        if name not in self.src:
            return np.full(len(np.asarray(lat)), np.nan)
        return self.sampler(name).sample(lat, lon)

    def flm(self, lat, lon) -> np.ndarray:
        """Copernicus fill-mask class per point (nearest pixel); 0 where the mask is not available"""
        if "cop_flm" not in self.src:
            return np.zeros(len(np.asarray(lat)), np.uint8)
        v = self.sampler("cop_flm").sample(lat, lon, nearest=True)
        return np.nan_to_num(v, nan=0).astype(np.uint8)

    def close(self):
        for s in self.samplers.values():
            s.close()
