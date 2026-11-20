# SPDX-License-Identifier: AGPL-3.0-or-later
"""The extraction of the image side (vmsx.extract, docs/CONCEPT_extraction.md): assumption-free grid points of the whole frame, tracked once and stored,
so that the interpretation (horizon, road fit, rotation bands) runs without the video."""
import json
import os

import cv2
import numpy as np
import pytest

from rsm.pipeline import config as C
from rsm.pipeline.vmsx import extract as EX, motion as vm
from tests.test_insight import _encode, _world

N_FRAMES = 300                                 # 10 s at 30 fps
CHUNK_S = 4 * vm.WARM_FRAMES / 30.0            # the shortest chunk: 128 frames -> 2 chunks


@pytest.fixture(scope="module")
def video(tmp_path_factory):
    os.environ["RSM_HWACCEL"] = "0"
    p = tmp_path_factory.mktemp("ex") / "road.mp4"
    _encode(p, _world(N_FRAMES))
    return p


@pytest.fixture(scope="module")
def sequential(video, tmp_path_factory):
    d = tmp_path_factory.mktemp("seq") / "extract"
    meta = EX.extract(str(video), d, workers=1, hwaccel=False)
    return d, meta


# ------------------------------------------------------------------ grid detection
def _eig(img):
    return cv2.cornerMinEigenVal(img, EX.EIG_BLOCK, EX.EIG_KSIZE)


def test_each_cell_gives_at_most_two_points_the_second_apart_from_the_first():
    rng = np.random.default_rng(1)
    img = cv2.GaussianBlur(rng.integers(0, 256, (360, 640)).astype(np.uint8), (0, 0), 1.0)
    e = _eig(img)
    p, q = EX.detect(e, EX.THR["raw"])
    cell = (p[:, 1] // EX.CELL).astype(int) * 1000 + (p[:, 0] // EX.CELL).astype(int)
    _, n = np.unique(cell, return_counts=True)
    assert n.max() <= EX.NPTS and len(p) > 0.8 * (360 // EX.CELL) * (640 // EX.CELL)
    for c in np.unique(cell)[np.unique(cell, return_counts=True)[1] == 2]:
        a, b = p[cell == c]
        assert np.hypot(*(a - b)) >= EX.MIN_D
    assert (e[p[:, 1].astype(int), p[:, 0].astype(int)] >= EX.THR["raw"]).all()


def test_the_strongest_corner_of_a_cell_comes_first_and_carries_its_strength():
    rng = np.random.default_rng(2)
    img = cv2.GaussianBlur(rng.integers(0, 256, (64, 64)).astype(np.uint8), (0, 0), 1.0)
    e = _eig(img)
    p, q = EX.detect(e, EX.THR["raw"])
    v = e[p[:, 1].astype(int), p[:, 0].astype(int)]
    cell = (p[:, 1] // EX.CELL).astype(int) * 1000 + (p[:, 0] // EX.CELL).astype(int)
    for c in np.unique(cell):
        k = np.flatnonzero(cell == c)
        assert v[k[0]] == v[k].max()
    assert np.all(np.abs(EX.strength_value(q) / v - 1) < 2 ** (1 / 16) - 1 + 1e-6)


def test_a_flat_cell_gives_no_point():
    img = np.full((64, 64), 128, np.uint8)
    img[:16, :16] = np.random.default_rng(3).integers(0, 256, (16, 16))
    p, _ = EX.detect(_eig(img), EX.THR["raw"])
    assert len(p) > 0 and (p[:, 0] < 24).all() and (p[:, 1] < 24).all()


def test_the_grid_makes_no_assumption_about_the_scene():
    """the same picture gives the same points wherever a horizon or road would lie: detection reads only the eigenvalue map"""
    rng = np.random.default_rng(4)
    img = cv2.GaussianBlur(rng.integers(0, 256, (360, 640)).astype(np.uint8), (0, 0), 1.0)
    p1, q1 = EX.detect(_eig(img), EX.THR["raw"])
    p2, q2 = EX.detect(_eig(img.copy()), EX.THR["raw"])
    assert np.array_equal(p1, p2) and np.array_equal(q1, q2)
    assert p1[:, 1].min() < EX.CELL and p1[:, 1].max() > 360 - EX.CELL     # top and bottom rows of the frame alike


# ------------------------------------------------------------------ quantisation
def test_quantisation_round_trip():
    p0 = np.array([[12.3, 200.71], [639.9, 0.02]])
    fl = np.array([[0.123, -3.217], [-40.5, 0.0]])
    fb = np.array([0.05, 0.9])
    q = EX.quantise(p0, fl, fb)
    x, y, dx, dy, f = EX.dequantise(*q)
    assert np.abs(np.column_stack([x, y]) - p0).max() <= 1 / 64 + 1e-9
    assert np.abs(np.column_stack([dx, dy]) - fl).max() <= 1 / 128 + 1e-9
    assert np.abs(f - fb).max() <= 1 / 256 + 1e-9


# ------------------------------------------------------------------ the extraction of a video
def test_the_streams_of_a_video(video, sequential):
    d, meta = sequential
    z = EX.load(d)
    assert meta["pairs"] == N_FRAMES - 1 and list(z["idx"]) == list(range(1, N_FRAMES))
    k = meta["k"]
    assert k == max(2, int(round(C.FAR["k_s"] * 30.0)))
    n_win = int(N_FRAMES / k) - 1
    assert list(z["rot_w"]) == list(range(n_win))                         # window w: frames w k -> (w + 1) k, as steps_a.rotation
    for s in ("des", "raw", "rot"):
        assert z[f"{s}_fb"].max(initial=0) < 128                          # no FB error of 1 px or more, no failed track stored
        assert len(z[f"{s}_x"]) == z[f"{s}_count"].sum() == len(z[f"{s}_q"])
    assert len(z["des_count"]) == meta["pairs"] and len(z["rot_count"]) == n_win
    assert set(z["raw_idx"]) >= set(j for j in z["idx"] if j % EX.RAW_EVERY == 0)
    assert len(z["raw_count"]) == len(z["raw_idx"])
    assert np.median(z["des_count"]) > 300                                 # the textured synthetic world fills most cells


def test_the_frame_difference_is_the_one_of_pair_row(video, sequential):
    from rsm.pipeline.vmsx.decode import frames
    d, _ = sequential
    z = EX.load(d)
    fr = [f for _, f in frames(str(video), 360, duration=0.2, hwaccel=False)]
    want = float(np.mean(np.abs(fr[1][::4, ::4].astype(np.int16) - fr[0][::4, ::4].astype(np.int16))))
    assert z["diff"][0] == pytest.approx(want, abs=1e-3)


def test_the_stored_points_carry_the_road_speed(video, sequential, tmp_path):
    """a road fit from the stored destatic points of the road area follows the speed of today's analysis of the same video"""
    d, meta = sequential
    z = EX.load(d)
    st = vm.analyse(str(video), str(tmp_path / "m.csv"), hwaccel=False, progress=False, horizon=150.0)
    ref = np.genfromtxt(tmp_path / "m.csv", delimiter=",", names=True)["s"]
    W, H = meta["width"], meta["height"]
    top, bottom = st["roi"]
    tr = vm.Tracker(H, W, top, bottom, 150.0)
    got = []
    for i, (x, y, dx, dy, _) in enumerate(EX.iter_stream(z, "des")):
        m = tr.mask[np.clip(y.astype(int), 0, H - 1), np.clip(x.astype(int), 0, W - 1)] > 0
        p0, fl = np.column_stack([x, y])[m], np.column_stack([dx, dy])[m]
        fit = vm.fit_fixed_horizon(p0 + fl / 2, fl, W / 2, H / 2, 150.0, vm.MIN_RESIDUAL) if len(p0) >= vm.MIN_INLIERS else None
        got.append(fit.params[0] if fit is not None else np.nan)
    got = np.array(got)
    ok = np.isfinite(got) & np.isfinite(ref)
    assert ok.mean() > 0.95
    assert np.median(got[ok] / ref[ok]) == pytest.approx(1.0, abs=0.03)
    assert np.corrcoef(got[ok], ref[ok])[0, 1] > 0.9


def test_chunks_in_parallel_give_the_sequential_data(video, sequential, tmp_path):
    d, meta = sequential
    meta2 = EX.extract(str(video), tmp_path / "extract", workers=2, chunk_s=CHUNK_S, hwaccel=False)
    assert len(meta2["chunks"]) == 2 and meta2["parallel"]["fallback"] is None
    a, b = EX.load(d), EX.load(tmp_path / "extract")
    assert a.keys() == b.keys()
    for key in a:
        assert np.array_equal(a[key], b[key]), key


def test_the_meta_names_everything_that_shapes_the_data(sequential):
    _, meta = sequential
    on_disk = json.loads((sequential[0] / "extract.json").read_text())
    assert on_disk == json.loads(json.dumps(meta))
    assert meta["version"] == EX.VERSION and meta["opencv"] == cv2.__version__
    assert meta["params"] == EX.params(meta["k"])
    assert {"cell", "npts", "min_d", "thr", "eig_block", "eig_ksize", "q_xy", "q_flow", "q_fb", "q_strength", "k", "raw_every", "raw_low_min", "fb_max",
            "destatic_tau"} <= set(meta["params"])


def test_extraction_reads_no_horizon_or_road_setting():
    """guard: the extraction module never refers to the interpretation's settings (horizon, road area, bands)"""
    import tokenize
    code = " ".join(t.string for t in tokenize.generate_tokens(open(EX.__file__).readline) if t.type == tokenize.NAME)    # code only: no comments, no strings
    for word in ("horizon", "BELOW_HORIZON", "ROAD_WIDTH", "band_ends", "band_horizon", "Tracker", "fit_fixed_horizon"):
        assert word not in code.split(), word
