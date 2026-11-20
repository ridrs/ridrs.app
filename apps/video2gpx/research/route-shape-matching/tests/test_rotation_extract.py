# SPDX-License-Identifier: AGPL-3.0-or-later
"""The rotation step as interpretation (docs/CONCEPT_extraction.md phase 3): the far-band window fits from the stored `rot` stream of `extract/`,
and A25, the focus-of-expansion column x0 of the heading series from the road fit."""
import json
import os

import numpy as np
import pytest

from rsm.angle import farfeat
from rsm.pipeline import config as C, steps_a as SA
from rsm.pipeline.vmsx import extract as EX, interpret as VI
from rsm.pipeline.vmsx.decode import probe
from tests.test_insight import _encode, _world

N_FRAMES = 300                                 # 10 s at 30 fps, the turning synthetic road (yaw rate 0.12 rad/s)
HZ = 150.0


@pytest.fixture(scope="module")
def video(tmp_path_factory):
    os.environ["RSM_HWACCEL"] = "0"
    p = tmp_path_factory.mktemp("rx") / "road.mp4"
    _encode(p, _world(N_FRAMES))
    return p


@pytest.fixture(scope="module")
def ex(video):
    d = video.parent / "extract"
    EX.extract(str(video), d, workers=1, hwaccel=False)
    return d


def _setup(video):
    info = probe(str(video))
    F = C.FAR
    k = max(2, int(round(F["k_s"] * info.fps)))
    n_win = int(info.duration * info.fps / k) - 1
    p = farfeat.Params(min_inl=F["min_inl"], band_off=C.ROT_BAND_OFF_VMS)
    ends = SA.band_ends(HZ, 360, p, F["band_step"], F["n_bands"])
    return info, k, n_win, p, ends


@pytest.fixture(scope="module")
def reference(video):
    """the band fits of today's rotation step on the decoded frames (one chunk)"""
    info, k, n_win, p, _ = _setup(video)
    F = C.FAR
    SA._G.update(video=str(video), info=info, k=k, H=360, f=C.F_FAR, p=p, horizon=HZ, min_inl=F["min_inl"], band_step=F["band_step"], n_bands=F["n_bands"])
    _, out, _ = SA._chunk((0, n_win))
    return out


def test_the_band_fits_from_the_stored_points_follow_todays_fits(video, ex, reference):
    _, k, n_win, p, ends = _setup(video)
    got = VI.rotation_windows(VI.Points(ex, streams=("rot",)), ends, p, C.F_FAR, C.FAR["min_inl"], n_win, chunk_w=n_win, fields=SA.FIELDS, why=SA.WHY)
    NF = len(SA.FIELDS)
    assert got.shape == reference.shape
    ok_g, ok_r = got[:, 0, NF].astype(bool), reference[:, 0, NF].astype(bool)
    assert ok_g.mean() > 0.9 and ok_r.mean() > 0.9
    both = ok_g & ok_r
    A_g, A_r = got[both, 0, 0], reference[both, 0, 0]
    assert np.median(A_g / A_r) == pytest.approx(1.0, abs=0.05)              # yaw per window
    assert np.median(np.abs(A_g - A_r)) < 0.3                                # px per window of k frames


def test_the_window_fits_do_not_depend_on_the_workers(video, ex):
    """the generator is seeded per chunk (1000 + its first window, as steps_a._chunk): any number of workers gives the same fits"""
    _, k, n_win, p, ends = _setup(video)
    P = VI.Points(ex, streams=("rot",))
    a = VI.rotation_windows(P, ends, p, C.F_FAR, C.FAR["min_inl"], n_win, chunk_w=10, fields=SA.FIELDS, why=SA.WHY, workers=1)
    b = VI.rotation_windows(P, ends, p, C.F_FAR, C.FAR["min_inl"], n_win, chunk_w=10, fields=SA.FIELDS, why=SA.WHY, workers=3)
    assert np.array_equal(a, b, equal_nan=True)


def test_a_band_with_too_few_stored_points_gives_no_fit(video, ex):
    """a band with fewer stored points than min_inl (here a band of one row): the window keeps 'few corners' and draws nothing from the generator"""
    _, k, n_win, p, _ = _setup(video)
    got = VI.rotation_windows(VI.Points(ex, streams=("rot",)), [1.0], p, C.F_FAR, C.FAR["min_inl"], n_win, chunk_w=n_win, fields=SA.FIELDS, why=SA.WHY)
    NF = len(SA.FIELDS)
    assert not got[:, 0, NF].any() and (got[:, 0, NF + 3] == SA.WHY.index("few corners")).all() and (got[:, 0, NF + 1] == 0).all()


def test_points_load_only_the_streams_asked_for(ex):
    P = VI.Points(ex, streams=("rot",))
    assert not any(key.startswith(("des_", "raw_")) for key in P.z if key != "raw_idx") and "rot_x" in P.z and "raw_idx" in P.z


# ------------------------------------------------------------------ A25: x0 from the road fit
def _csv(tmp_path, s, c, rms):
    p = tmp_path / "motion.csv"
    rows = ["frame,time,corners,tracked,inliers,rms_px,s,c,yaw,pitch,roll,diff,rel_speed,alts,pick"]
    for i, (a, b, r) in enumerate(zip(s, c, rms)):
        rows.append(f"{i + 1},{i / 30:.4f},100,100,80,{r},{a},{b},0,0,0,1,{a * 30},,")
    p.write_text("\n".join(rows) + "\n")
    return p


def test_x0_is_the_median_focus_column_of_the_clean_road_fits(tmp_path):
    """A25 (E2): the far bands' heading takes x0 = median of -c / s over the clean pairs (speed above X0_MIN_S, rms at most X0_MAX_RMS)"""
    rng = np.random.default_rng(0)
    s = rng.uniform(2e-4, 6e-4, 400)
    x0 = 17.0 + rng.normal(0, 2.0, 400)
    c = -s * x0
    rms = np.full(400, 0.4)
    s[:50], c[:50] = 2e-5, 1e-3                                              # standing still: -c/s means nothing
    rms[50:100], c[50:100] = 1.5, -s[50:100] * 200                           # bad fits
    assert SA.road_x0(str(_csv(tmp_path, s, c, rms))) == pytest.approx(17.0, abs=0.5)


def test_x0_falls_back_when_too_few_pairs_are_clean(tmp_path):
    assert SA.road_x0(str(_csv(tmp_path, [2e-5] * 50, [1e-3] * 50, [0.4] * 50))) is None


def test_the_overlay_shows_the_stored_points_of_the_far_window(video, ex, tmp_path, monkeypatch):
    """a run from the extraction: insight.far_window takes the window's points from extract/ and reproduces the stored band fits"""
    from rsm.pipeline import insight as I
    info, k, n_win, p, ends = _setup(video)
    d = tmp_path / "run"
    (d / "rotation").mkdir(parents=True)
    (d / "motion").mkdir()
    import shutil
    shutil.copytree(ex, d / "extract")
    arr = VI.rotation_windows(VI.Points(ex, streams=("rot",)), ends, p, C.F_FAR, C.FAR["min_inl"], n_win, chunk_w=max(10, int(round(C.FAR["chunk_s"] * info.fps / k))),
                              fields=SA.FIELDS, why=SA.WHY)
    NF = len(SA.FIELDS)
    idx = np.arange(n_win)
    meta = dict(video="video", f=C.F_FAR, k=k, fps=info.fps, horizon=HZ, band_off=p.band_off, n_windows=int(n_win), n_ok=0, wall_s=0.0, band_ends=ends, source="extract")
    np.savez(d / "rotation" / "win_video_base.npz", idx=idx, ta=idx * k / info.fps, tb=(idx + 1) * k / info.fps, fields=np.array(SA.FIELDS), data=arr[:, :, :NF],
             ok=arr[:, :, NF].astype(bool), n_pts=arr[:, :, NF + 1], n_inl=arr[:, :, NF + 2], why=arr[:, :, NF + 3], meta=json.dumps(meta))
    monkeypatch.setattr(SA, "ffmpeg_frames", lambda *a, **kw: pytest.fail("the overlay of an extracted run decodes no frames"))
    for t in (1.0, 5.0, 9.0):
        r = I.far_window(d, str(video), dict(extract=dict(version=EX.VERSION)), t, info)
        assert r["agree"], [b for b in r["bands"] if not b["agree"]]
        assert r["points_from"] == "extract" and any(b["ok"] for b in r["bands"])
        b = next(b for b in r["bands"] if b["ok"])
        assert len(b["points"]) == b["n_pts"] and sum(q[4] for q in b["points"]) == b["n_inl"]
