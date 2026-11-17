# SPDX-License-Identifier: AGPL-3.0-or-later
"""Extra elevation sources (rsm.pipeline.tiff, demsrc) and the multi-source road-height estimator (dem.robust_road_height,
dem.profile_multi). Synthetic data only, no network."""
import struct
import zlib

import numpy as np
import pytest

from rsm.pipeline import dem as D, demsrc as S, tiff as T


def lzw_encode(data: bytes) -> bytes:
    """TIFF LZW encoder (MSB-first, early change), only for the tests"""
    out, acc, nacc = bytearray(), 0, 0
    table = {bytes((i,)): i for i in range(256)}
    nbits, nxt = 9, 258

    def put(code):
        nonlocal acc, nacc
        acc = (acc << nbits) | code; nacc += nbits
        while nacc >= 8:
            nacc -= 8; out.append((acc >> nacc) & 0xFF)
    put(256)
    w = b""
    for ch in data:
        wc = w + bytes((ch,))
        if wc in table:
            w = wc; continue
        put(table[w])
        table[wc] = nxt; nxt += 1
        if nxt in (512, 1024, 2048):                     # the decoder widens one code later than it fills its table ("early change")
            nbits += 1
        if nxt >= 4094:
            put(256); table = {bytes((i,)): i for i in range(256)}; nbits, nxt = 9, 258
        w = bytes((ch,))
    if w:
        put(table[w])
    put(257)
    if nacc:
        out.append((acc << (8 - nacc)) & 0xFF)
    return bytes(out)


def write_tiff(path, a, x0, y0, d, *, big=False, tiled=True, comp=8, pred=1, transform=False, epsg=25832, block=16, nodata=None):
    """a small GeoTIFF writer for the tests: classic / BigTIFF, tiles / strips, uint8 / int16 / float32, compression 1 / 5 / 8, predictor 1 / 2"""
    H, W = a.shape
    dt = a.dtype
    bits, fmt = dt.itemsize * 8, (3 if dt.kind == "f" else 2 if dt.kind == "i" else 1)
    blobs = []
    if tiled:
        th = tw = block
        for r in range(0, H, th):
            for c in range(0, W, tw):
                t = np.zeros((th, tw), dt); t[:min(th, H - r), :min(tw, W - c)] = a[r:r + th, c:c + tw]
                blobs.append(t)
    else:
        th, tw = block, W
        for r in range(0, H, th):
            blobs.append(a[r:r + th])
    raw = []
    for t in blobs:
        t = t.astype(dt.newbyteorder("<"))
        if pred == 2:
            t = np.concatenate([t[:, :1], np.diff(t, axis=1)], axis=1).astype(t.dtype)
        b = t.tobytes()
        raw.append(zlib.compress(b) if comp == 8 else lzw_encode(b) if comp == 5 else b)
    tags = {256: (3, [W]), 257: (3, [H]), 258: (3, [bits]), 259: (3, [comp]), 262: (3, [1]), 277: (3, [1]), 284: (3, [1]), 317: (3, [pred]), 339: (3, [fmt]),
            34735: (3, [1, 1, 0, 2, 1025, 0, 1, 1, 3072, 0, 1, epsg])}
    if transform:
        tags[34264] = (12, [d, 0, 0, x0, 0, -d, 0, y0, 0, 0, 0, 0, 0, 0, 0, 1])
    else:
        tags[33550] = (12, [d, d, 0.0]); tags[33922] = (12, [0.0, 0.0, 0.0, x0, y0, 0.0])
    if nodata is not None:
        tags[42113] = (2, list(f"{nodata}\0".encode()))
    ot = 16 if big else 4
    if tiled:
        tags[322], tags[323], tags[324], tags[325] = (3, [tw]), (3, [th]), (ot, [0] * len(raw)), (ot, [len(b) for b in raw])
    else:
        tags[278], tags[273], tags[279] = (3, [th]), (ot, [0] * len(raw)), (ot, [len(b) for b in raw])
    fc = {2: ("B", 1), 3: ("H", 2), 4: ("I", 4), 12: ("d", 8), 16: ("Q", 8)}
    es, lim = (20, 8) if big else (12, 4)
    hdr = 16 if big else 8
    n = len(tags)
    ifd = hdr + (8 if big else 2) + es * n + (8 if big else 4)
    payload = bytearray()
    ext = {}
    for tag in sorted(tags):
        typ, v = tags[tag]
        if fc[typ][1] * len(v) > lim:
            ext[tag] = ifd + len(payload); payload += b"\0" * (fc[typ][1] * len(v))
    data0 = ifd + len(payload)
    offs, o = [], data0
    for b in raw:
        offs.append(o); o += len(b)
    tags[324 if tiled else 273] = (ot, offs)
    payload = bytearray(); entries = b""
    for tag in sorted(tags):
        typ, v = tags[tag]
        ch, sz = fc[typ]
        packed = struct.pack("<" + ch * len(v), *v)
        cnt = struct.pack("<Q" if big else "<I", len(v))
        if len(packed) > lim:
            entries += struct.pack("<HH", tag, typ) + cnt + struct.pack("<Q" if big else "<I", ifd + len(payload)); payload += packed
        else:
            entries += struct.pack("<HH", tag, typ) + cnt + packed.ljust(lim, b"\0")
    head = (b"II" + struct.pack("<HHHQ", 43, 8, 0, hdr)) if big else (b"II" + struct.pack("<HI", 42, hdr))
    body = head + (struct.pack("<Q", n) if big else struct.pack("<H", n)) + entries + b"\0" * (8 if big else 4) + bytes(payload) + b"".join(raw)
    path.write_bytes(body)


@pytest.mark.parametrize("kw", [dict(comp=5), dict(comp=8, pred=2, dtype="i2"), dict(comp=1, tiled=False, dtype="i2"), dict(big=True, comp=5),
                                dict(comp=5, tiled=False, transform=True), dict(comp=8, pred=2, dtype="u1")])
def test_tiff_reader_layouts_codecs_and_types(tmp_path, kw):
    kw = dict(kw)
    dt = kw.pop("dtype", "f4")
    rng = np.random.default_rng(5)
    a = rng.normal(400, 120, (37, 29))
    a = np.clip(a, 0, 255).astype(dt) if dt == "u1" else a.astype(dt)
    p = tmp_path / "x.tif"
    write_tiff(p, a, 600000.0, 5200000.0, 2.0, **kw)
    t = T.Tiff(p)
    assert t.epsg == 25832 and t.W == 29 and t.H == 37
    assert np.array_equal(t.window(0, 0, 37, 29), a.astype(np.float32))
    # centre of pixel (0, 0) and bilinear between pixel centres
    assert t.x00 == 600001.0 and t.y00 == 5199999.0
    v = t.sample([600001.0 + 2 * 3.5], [5199999.0 - 2 * 4.0])[0]
    assert v == pytest.approx(0.5 * (float(a[4, 3]) + float(a[4, 4])), abs=1e-3)


def test_tiff_reader_nodata_and_outside_is_nan(tmp_path):
    a = np.full((8, 8), 100.0, np.float32); a[2, 2] = -9999
    write_tiff(tmp_path / "n.tif", a, 0.0, 16.0, 2.0, nodata=-9999, block=8)
    t = T.Tiff(tmp_path / "n.tif", clamp=False)
    assert np.isnan(t.pixel(np.array([2]), np.array([2]))[0]) and np.isnan(t.sample([-50.0], [8.0])[0]) and t.pixel(np.array([0]), np.array([0]))[0] == 100
    (tmp_path / "b.tif").write_bytes(b"II+\0\x04\0\0\0" + b"\0" * 8)              # BigTIFF with a wrong offset size: refused
    with pytest.raises(T.UnsupportedTiff):
        T.Tiff(tmp_path / "b.tif")


def test_lzw_decoder_handles_table_resets():
    rng = np.random.default_rng(2)
    data = bytes(rng.integers(0, 256, 30000, dtype=np.uint8)) + b"ab" * 5000          # random part forces 12-bit codes and a Clear
    assert T.lzw_decode(lzw_encode(data)) == data


class FakeSrc(S.Source):
    """a terrain model on a 100 m block grid in UTM 32N, height = 0.01 * easting (a plane), no data west of easting 500000"""
    calls = 0

    def get_block(self, key, d):
        FakeSrc.calls += 1
        x0, y0, x1, y1 = self.bbox(key)
        if x1 <= 500000:
            raise S.NoData("outside")
        n = int(self.block_m / self.res_m)
        xc = x0 + self.res_m / 2 + self.res_m * np.arange(n)
        z = np.tile((0.01 * xc).astype(np.float32), (n, 1))
        return z, x0 + self.res_m / 2, y1 - self.res_m / 2, self.res_m, z.nbytes


def _fake():
    return FakeSrc(name="fake_dtm", title="fake", kind="dtm", region="test", res_m=2.0, sigma_m=0.5, dsm=False, offsets=(-4, -2, 0, 2, 4), licence="test",
                   attribution="fake (c)", status="verified", coverage=[(5.0, 45.0, 12.0, 48.0)], est_block_bytes=1000, epsg=32632, block_m=100.0)


def test_source_plan_fetch_cache_and_sampling(tmp_path, monkeypatch):
    from pyproj import Transformer
    src = _fake()
    monkeypatch.setitem(S.SOURCES, "fake_dtm", src)
    monkeypatch.setattr(S, "POLITE_S", 0.0)
    to_ll = Transformer.from_crs(32632, 4326, always_xy=True)
    xs = np.linspace(499850, 500350, 60); ys = np.full(60, 5_200_050.0)          # crosses the data edge at easting 500000
    lon, lat = (np.asarray(v) for v in to_ll.transform(xs, ys))
    p = S.plan(lat, lon, tmp_path, names=["fake_dtm"])
    assert p["sources"]["fake_dtm"]["blocks"] == p["missing_blocks"] > 0 and p["missing_bytes"] == 1000 * p["missing_blocks"]
    r = S.fetch(lat, lon, tmp_path, names=["fake_dtm"])
    assert r["ok"] and r["fetched"] == p["missing_blocks"]
    assert any(f.suffix == ".none" for f in (tmp_path / "fake_dtm").iterdir())              # the blocks west of the edge
    assert S.plan(lat, lon, tmp_path, names=["fake_dtm"])["missing_blocks"] == 0
    n0 = FakeSrc.calls
    S.fetch(lat, lon, tmp_path, names=["fake_dtm"])
    assert FakeSrc.calls == n0                                                                # cached: nothing is requested again
    z = S.Multi(tmp_path, ["fake_dtm"]).sample("fake_dtm", lat, lon)
    east = xs > 500010
    assert np.allclose(z[east], 0.01 * xs[east], atol=0.02) and np.isnan(z[xs < 499990]).all()


def test_fill_source_only_planned_where_copernicus_is_void_filled(tmp_path):
    lat, lon = np.linspace(44.40, 44.41, 50), np.full(50, 5.5)
    p = S.plan(lat, lon, tmp_path, names=["cop_flm", "nasadem"])
    assert p["sources"]["nasadem"]["conditional"]                                             # mask not there yet: maybe needed
    (tmp_path / "cop_flm").mkdir()
    a = np.full((40, 40), 2, np.uint8)                                                        # all TanDEM-X
    write_tiff(tmp_path / "cop_flm" / "Copernicus_DSM_COG_10_N44_00_E005_00.tif", a, 5.0, 45.0, 0.025, epsg=4326, block=16)
    assert "nasadem" not in S.plan(lat, lon, tmp_path, names=["cop_flm", "nasadem"])["sources"]
    a[:, :] = 5                                                                               # SRTM fill under the route
    write_tiff(tmp_path / "cop_flm" / "Copernicus_DSM_COG_10_N44_00_E005_00.tif", a, 5.0, 45.0, 0.025, epsg=4326, block=16)
    q = S.plan(lat, lon, tmp_path, names=["cop_flm", "nasadem"])
    assert q["sources"]["nasadem"]["blocks"] == 1 and not q["sources"]["nasadem"]["conditional"]


def test_registry_licences_and_defaults():
    on = {s.name for s in S.enabled_sources()}
    assert {"cop_flm", "nasadem", "fr_rgealti", "it_tinitaly", "ch_swissalti3d", "at_als_dtm", "de_by_dgm1", "de_he_dgm1", "de_nw_dgm1", "it_bz_dtm"} <= on
    assert "aw3d30" not in on and S.SOURCES["aw3d30"].status == "unverified"                  # unverified terms: never on by default
    for s in S.SOURCES.values():
        assert s.licence and s.attribution and "NC" not in s.licence


# ------------------------------------------------------------------ estimator
def _samples(n=1200, seed=0, canopy=True, cliff=False, dtm=True):
    """a road: flat, a 6 % climb, flat (5 m grid); Copernicus DSM with canopy (only ever too high) and, on a 'cliff' stretch, void-filled pixels
    off by +-25 m; a terrain model with 0.3 m noise"""
    rng = np.random.default_rng(seed)
    s = np.arange(n) * 5.0
    true = 300 + D.gauss(np.clip(s - 1500, 0, 1500) * 0.06, 20.0)          # vertical curves of about 100 m, as on a real road
    cop = true[:, None] + rng.normal(0, 1.0, (n, 3))
    if canopy:
        cop += (rng.random((n, 3)) < 0.3) * rng.uniform(5, 15, (n, 3))
    flm = np.full((n, 3), 2, np.uint8)
    if cliff:
        a, b = 600, 800
        cop[a:b] += np.repeat(25 * np.sign(np.sin(np.arange(b - a) / 15.0))[:, None], 3, 1)
        flm[a:b] = 5
    S_ = {"cop": dict(z=cop, o=np.array(D.COP_OFFSETS), sigma=D.COP_SIGMA_M, dsm=True, px=30.0), "flm": flm}
    if dtm:
        S_["fake_dtm"] = dict(z=true[:, None] + rng.normal(0, 0.3, (n, 5)), o=np.array([-4, -2, 0, 2, 4.0]), sigma=0.5, dsm=False, px=2.0, kind="dtm")
    return s, true, S_


def test_without_extra_sources_the_profile_is_the_p13_profile():
    s, true, S_ = _samples(dtm=False)
    tu = br = np.zeros(len(s), bool)
    z, st = D.profile_multi(s, S_, tu, br)
    z13, _ = D.profile(s, S_["cop"]["z"][:, 1], tu, br)
    assert np.array_equal(z, z13) and st["strategy"] == "p13" and st["sources_used"] == ["copernicus"]


def test_robust_estimator_follows_the_terrain_model_and_ignores_canopy_and_cliff_errors():
    s, true, S_ = _samples(cliff=True)
    tu = br = np.zeros(len(s), bool)
    z, st = D.profile_multi(s, S_, tu, br)
    assert st["strategy"] == "robust-multi" and "fake_dtm" in st["sources_used"]
    assert np.abs(z - true).max() < 1.5                                       # the DSM errors (canopy, +-25 m fill) do not pull it
    up, _ = D.ascent_descent(z)
    assert abs(up - 90.0) < 3.0                                               # the 90 m climb, nothing invented


def test_robust_estimator_down_weights_canopy_above_the_road_in_gentle_terrain():
    s, true, S_ = _samples(dtm=False)
    gap = np.zeros(len(s), bool)
    mean_bias = float(np.median(S_["cop"]["z"].mean(1) - true))              # canopy: 30 % of the samples 5..15 m too high
    f0, _ = D.robust_road_height(S_, gap, np.zeros(len(s)))                  # gentle: asymmetric (DSM errs upward)
    f1, _ = D.robust_road_height(S_, gap, np.ones(len(s)))                   # rugged: symmetric
    assert np.median(f0 - true) < 0.7 * mean_bias and np.median(f0 - true) < np.median(f1 - true)


def test_rugged_terrain_gets_the_stiffer_spline():
    s, true, S_ = _samples(dtm=True, canopy=False)
    rng = np.random.default_rng(9)
    S_["fake_dtm"]["z"] = S_["fake_dtm"]["z"] + rng.normal(0, 3.0, S_["fake_dtm"]["z"].shape)
    gap = np.zeros(len(s), bool)
    f0, _ = D.robust_road_height(S_, gap, np.zeros(len(s)))
    f1, _ = D.robust_road_height(S_, gap, np.ones(len(s)))
    rough = lambda f: float(np.std(np.diff(f, 2)))
    assert rough(f1) < rough(f0)


def test_export_elevation_uses_cached_sources_and_names_them(tmp_path, monkeypatch):
    from pyproj import Transformer
    from rsm.pipeline import export as X
    src = _fake()
    monkeypatch.setitem(S.SOURCES, "fake_dtm", src)
    monkeypatch.setattr(S, "POLITE_S", 0.0)
    monkeypatch.setattr(S, "enabled_sources", lambda names=None: [src] if names is None or "fake_dtm" in names else [])
    a = np.full((40, 40), 4900.0, np.float32)                                    # Copernicus: a flat 4900 m, 100 m off the terrain model
    write_tiff(tmp_path / (D.tile_name(46, 9) + ".tif"), a, 9.0, 47.0, 0.025, epsg=4326, block=16)
    xs = np.arange(500100.0, 502100.0, 5.0)
    lon, lat = (np.asarray(v) for v in Transformer.from_crs(32632, 4326, always_xy=True).transform(xs, np.full(len(xs), 5_200_050.0)))
    grid = np.arange(len(xs)) * 5.0
    no = np.zeros(len(xs), bool)
    z0, _, st0 = X.corrected_elevation(tmp_path, lat, lon, grid, no, no)          # nothing cached yet: Copernicus with the P13 filter
    assert st0["sources_used"] == ["copernicus"] and abs(np.median(z0) - 4900) < 1 and st0["attribution"] == D.ATTRIB_DEM
    S.fetch(lat, lon, tmp_path, names=["fake_dtm"])
    z1, _, st1 = X.corrected_elevation(tmp_path, lat, lon, grid, no, no)
    assert "fake_dtm" in st1["sources_used"] and st1["strategy"] == "robust-multi" and "fake (c)" in st1["attribution"]
    assert np.abs(z1 - 0.01 * xs)[50:-50].max() < 1.0                            # follows the terrain model (0.01 * easting)


def test_cli_dem_plan_and_fetch_parse():
    from rsm.pipeline.cli import parse_args
    a = parse_args(["dem-plan", "--out", "o", "--dem-dir", "d", "--sources", "fr_rgealti,cop_flm"])
    b = parse_args(["dem-fetch", "--out", "o"])
    assert a.cmd == "dem-plan" and a.sources == "fr_rgealti,cop_flm" and b.cmd == "dem-fetch" and b.dem_dir is None


# ------------------------------------------------------------------ diagnostics for the app's elevation stage (elevation_diag)
def test_diag_leaves_the_profile_unchanged_and_has_valid_weights():
    import json
    from rsm.pipeline import export as X
    s, true, S_ = _samples(cliff=True)
    n = len(s)
    tu = br = np.zeros(n, bool)
    z0, st0 = D.profile_multi(s, S_, tu, br)
    dg: dict = {}
    z1, st1 = D.profile_multi(s, S_, tu, br, diag=dg)
    assert np.array_equal(z0, z1) and json.dumps(st0, default=str) == json.dumps(st1, default=str)     # the estimator does not see the diagnostics
    gap = np.zeros(n, bool)
    rug = np.linspace(0, 1, n)
    f0, _ = D.robust_road_height(S_, gap, rug)
    e: dict = {}
    f1, _ = D.robust_road_height(S_, gap, rug, diag=e)
    assert np.array_equal(f0, f1) and e["w"].shape == e["cau"].shape == (n, 8) and e["cau"].min() >= 0 and e["cau"].max() <= 1
    dg["S"] = S_
    d = X.elevation_diag(dg, z1, st1)
    json.dumps(d)
    assert d["version"] == 2 and d["n"] == n and d["ds"] == 5.0
    for k in ("z_p13", "rug", "filled", "gap", "w_dtm"):
        assert len(d[k]) == n
    assert [x["name"] for x in d["sources"]] == ["copernicus", "fake_dtm"] and [x["colour"] for x in d["sources"]] == [0, 1]
    for x in d["sources"]:
        assert len(x["z"]) == len(x["w"]) == len(x["sh"]) == n
        assert min(v for v in x["w"] if v is not None) >= 0 and max(v for v in x["w"] if v is not None) <= 1
    sh = np.array([x["sh"] for x in d["sources"]], float)
    assert np.allclose(sh.sum(0), 1.0, atol=0.03)                                    # the shares add up to the whole height
    assert d["strategy_share"]["robust"] > 0.9 and abs(sum(d["source_share"].values()) - 1.0) < 0.03
    assert sum(d["filled"][600:800]) == 200 and sum(d["filled"][:600]) == 0         # the void-filled stretch
    cop, dtm = d["sources"][0]["w"], d["sources"][1]["w"]
    assert np.mean(cop[600:800]) < np.mean(dtm[600:800])                             # the estimator trusts the terrain model on the cliff stretch
    assert d["max_grade_pct"] < 8 and abs(d["ascent_m"] - 90) < 3 and d["ascent_p13_m"] > 0


def test_diag_without_extra_sources_has_no_weights():
    from rsm.pipeline import export as X
    s, true, S_ = _samples(dtm=False)
    n = len(s)
    dg: dict = {}
    z, st = D.profile_multi(s, S_, np.zeros(n, bool), np.zeros(n, bool), diag=dg)
    dg["S"] = S_
    d = X.elevation_diag(dg, z, st)
    assert d["strategy_share"] == {"robust": 0.0, "p13": 1.0} and d["sources"][0]["w"] is None and d["sources"][0]["sh"][0] == 1.0
    assert np.array_equal(np.array(d["z_p13"]), np.round(z, 1))                      # without extra sources the profile is the P13 one


def test_plan_reports_the_missing_bytes_per_source(tmp_path):
    lat, lon = np.array([44.5, 44.51]), np.array([5.5, 5.51])
    q = S.plan(lat, lon, tmp_path, names=["cop_flm", "nasadem"])
    assert q["sources"]["cop_flm"]["missing_bytes"] == sum(i["bytes"] for i in q["items"] if i["source"] == "cop_flm" and i["state"] == "missing") > 0
    assert sum(v["missing_bytes"] for v in q["sources"].values()) == q["missing_bytes"]
