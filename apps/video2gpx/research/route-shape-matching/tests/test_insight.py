# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.pipeline.insight (the analysis viewer, docs/FEATURE_analysis_insight.md Part A): the series of a run and the points of one frame / window.

The central check: `frame` tracks the frame pair and far-feature window at time t again and must give exactly the csv row and the window fit the steps stored.
"""
import json
import math
import pickle
import subprocess
from pathlib import Path

import numpy as np
import pytest

from rsm.pipeline import config as C, insight as I

FPS, W, H = 30, 640, 360


# ------------------------------------------------------------------ a synthetic run for `series`
def _fake_run(d: Path, n=120, v=10.0, weak=((40, 48), (90, 100))):
    """a route of alternating bends, ridden at v m/s; the video measures it (yaw, speed, far windows), except in `weak` where the confidence is low:
    the first stretch has no road-flow fit at all (motion cause), the second sits in a vms gap"""
    for sub in ("refine", "motion", "rotation", "route_search"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    s_end = n * v + 200
    sg = np.arange(0.0, s_end, 5.0)
    kappa = 0.02 * np.sin(sg / 120.0)                                   # 1/m, left positive
    psi = np.concatenate([[0.0], np.cumsum(0.5 * (kappa[1:] + kappa[:-1]) * 5.0)])
    xy = np.column_stack([np.concatenate([[0.0], np.cumsum(5 * np.cos(0.5 * (psi[1:] + psi[:-1])))]), np.concatenate([[0.0], np.cumsum(5 * np.sin(0.5 * (psi[1:] + psi[:-1])))])])
    t = np.arange(n, dtype=float)
    s = 20.0 + v * t
    conf = np.full(n, 0.99)
    in_gap = np.zeros(n, bool)
    for a, b in weak:
        conf[a:b] = 0.1
    in_gap[weak[1][0]:weak[1][1]] = True
    np.savez(d / "refine" / "result.npz", t=t, s=s, s_sd=np.full(n, 6.0), conf=conf, extrap=np.zeros(n, bool), in_gap=in_gap, sg=sg, xy=xy, tunnel=np.zeros(len(sg), bool),
             crs="EPSG:32632")
    pickle.dump(dict(kappa=1.0, f_eff=450.0, post=dict(t=np.arange(0, n, 3.0), p_vit=np.full(len(np.arange(0, n, 3.0)), 0.99), p_max=np.full(len(np.arange(0, n, 3.0)), 0.99))),
                open(d / "route_search" / "route.pkl", "wb"))
    # the video: yaw rate = kappa(s) v, in px per pair at f = 450
    tp = (np.arange(1, int(n * FPS)) - 0.5) / FPS
    sp = 20.0 + v * tp
    yaw_rate = np.interp(sp, sg, kappa) * v                                 # rad/s
    rows = ["frame,time,corners,tracked,inliers,rms_px,s,c,yaw,pitch,roll,diff,rel_speed"]
    k_nom = C.F360 * 1.1
    for i, (tt, w) in enumerate(zip(tp, yaw_rate), start=1):
        if weak[0][0] <= tt < weak[0][1]:
            rows.append(f"{i},{tt:.4f},40,8,0,,,,,,,1.0,")
        else:
            rows.append(f"{i},{tt:.4f},300,200,120,0.4,{v / k_nom / FPS:.6e},0,{w * 450.0 / FPS:.4f},0,0,1.0,{v / k_nom:.6e}")
    (d / "motion" / "motion.csv").write_text("\n".join(rows) + "\n")
    (d / "motion" / "motion.json").write_text(json.dumps(dict(fps=float(FPS), duration=float(n), height=H, width=W, step=1, horizon=150.0, horizon_vms=150.0, roi=[160, 349], road_width=0.8)))
    # far windows: k frames each
    k = 8
    nw = int(n * FPS / k) - 1
    idx = np.arange(nw)
    ta, tb = idx * k / FPS, (idx + 1) * k / FPS
    wy = np.interp(20.0 + v * 0.5 * (ta + tb), sg, kappa) * v * (k / FPS) * 450.0           # px per window
    data = np.zeros((nw, 3, 10))
    data[:, :, 0] = wy[:, None]
    data[:, :, 4] = 0.2
    ok = np.ones((nw, 3), bool)
    for a, b in weak:
        ok[(ta >= a) & (tb <= b)] = False
    np.savez(d / "rotation" / "win_video_base.npz", idx=idx, ta=ta, tb=tb, fields=np.array(["A", "B", "C", "e", "sA", "sB", "sC", "corrAC", "sigma", "xspread"]), data=data, ok=ok,
             n_pts=np.where(ok, 150.0, 20.0), n_inl=np.where(ok, 100.0, 5.0), why=np.where(ok, 0.0, 1.0), meta=json.dumps(dict(f=450.0, k=k, fps=float(FPS), n_windows=nw, horizon=150.0, band_off=-5.0, band_ends=[100.0, 120.0, 140.0])))
    (d / "rotation" / "cuts.json").write_text(json.dumps(dict(cuts=[], candidates=[], intro_end=None)))
    (d / "refine" / "summary.json").write_text(json.dumps(dict(local=dict(accept_tested=[]))))
    return dict(kappa=kappa, sg=sg, s=s)


def test_series_curvature_of_video_and_map_agree_on_a_consistent_run(tmp_path):
    _fake_run(tmp_path)
    S = I.series(tmp_path)
    n = S["n"]
    assert n == 120 and all(len(S[k]) == n for k in ("t", "kappa_video", "kappa_map", "kappa_diff", "speed_fused", "speed_vms", "yaw", "conf", "usable", "far_ok"))
    kv, km = (np.array([np.nan if x is None else x for x in S[k]]) for k in ("kappa_video", "kappa_map"))
    ok = np.isfinite(kv) & np.isfinite(km)
    ok[35:55] = False
    ok[85:105] = False                     # the weak parts have no video measurement
    assert ok.sum() > 40
    assert np.corrcoef(kv[ok], km[ok])[0, 1] > 0.95                        # same sign and shape: left positive in both
    assert abs(np.polyfit(km[ok], kv[ok], 1)[0] - 1.0) < 0.1               # and the same scale (the effective focal length is applied)
    sp = np.array(S["speed_fused"])
    assert abs(np.median(sp) - 10.0) < 0.1


def test_series_lists_weak_stretches_with_measured_causes(tmp_path):
    _fake_run(tmp_path)
    S = I.series(tmp_path)
    st = S["stretches"]
    assert len(st) == 2
    a, b = st
    assert 39 <= a["t0"] <= 41 and 47 <= a["t1"] <= 49 and a["kind"] == "low" and a["dur"] >= 7
    ids = [c["id"] for c in a["causes"]]
    assert "motion" in ids and all(c["text"] and c["value"] is not None for c in a["causes"] if c["id"] != "none")
    motion = next(c for c in a["causes"] if c["id"] == "motion")
    assert motion["value"] < C.ODO_LOW_USABLE * 100 and motion["limit"] == C.ODO_LOW_USABLE * 100   # the value is measured and below its limit
    assert "gap" in [c["id"] for c in b["causes"]]
    json.dumps(S)                                                           # serialisable (NaN became null)


def test_series_weak_stretch_merge_and_minimum_length():
    t = np.arange(60, dtype=float)
    conf = np.full(60, 0.99)
    conf[10:20] = 0.1
    conf[22:30] = 0.1                       # 2 s of good in between: one stretch
    conf[40:42] = 0.1                       # 2 s: too short to list
    nan = np.full(60, np.nan)
    X = dict(t=t, s=t * 10, conf=conf, sd=np.full(60, 5.0), extrap=np.zeros(60, bool), in_gap=np.zeros(60, bool), tunnel=np.zeros(60, bool), fail=np.zeros(60, bool),
             cut=np.zeros(60, bool), usable=np.ones(60), inl=np.full(60, 100.0), far_ok=np.ones(60), why=np.zeros(60, int), p_vit=nan, p_max=nan, local=np.zeros(60, int),
             v_vms=nan, v_fused=np.full(60, 10.0), inl_run=100.0, v=np.full(60, 10.0), k_v=nan, k_m=nan, diff=np.zeros(60), intro=None, cuts_list=[])
    st = I.stretches({}, X)
    assert len(st) == 1 and st[0]["t0"] == 10 and st[0]["t1"] == 30


def test_window_rate_is_the_heading_change_per_metre():
    # a circle of radius 100 m ridden at 5 m/s: heading grows by s / R, the rate over any window is 1 / R
    t = np.arange(0.0, 200.0)
    dist = 5.0 * t
    k = I.window_rate(t, dist / 100.0, dist, 15.0)
    assert np.allclose(k[10:-10], 0.01, atol=1e-9) and np.isnan(k[0]) and np.isnan(k[-1])


def test_map_heading_is_left_positive_and_unwrapped():
    sg = np.arange(0.0, 400.0, 10.0)
    ang = sg / 50.0                                                         # a left-hand circle of R = 50 m, more than a full turn
    xy = np.column_stack([50 * np.sin(ang), 50 * (1 - np.cos(ang))])
    mid, psi = I.map_heading(sg, xy)
    assert psi[-1] - psi[0] > 6.0 and np.all(np.diff(psi) > 0)


# ------------------------------------------------------------------ frame: the same numbers as the steps
def _world(n_frames, yaw_rate=0.12, v=7.0, yh=150, f=450.0, h=1.2):
    """grey frames of a textured ground plane and a textured sky seen from a camera that drives forward and turns"""
    import cv2
    rng = np.random.default_rng(3)
    tex = cv2.GaussianBlur(rng.integers(0, 256, (1024, 1024)).astype(np.float32), (0, 0), 1.3)
    tex = np.clip(128 + (tex - tex.mean()) * 5.0, 0, 255).astype(np.float32)
    sky = cv2.GaussianBlur(rng.integers(0, 256, (512, 2048)).astype(np.float32), (0, 0), 1.5)
    sky = np.clip(128 + (sky - sky.mean()) * 5.0, 0, 255).astype(np.float32)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    cx = W / 2
    for n in range(n_frames):
        t, psi = n / FPS, yaw_rate * n / FPS
        yn = np.maximum((yy - yh) / f, 1e-3)
        zg = h / yn
        xg = (xx - cx) / f * zg
        xw = xg * math.cos(psi) + zg * math.sin(psi)
        zw = -xg * math.sin(psi) + zg * math.cos(psi) + v * t
        ground = cv2.remap(tex, (xw * 40).astype(np.float32), (zw * 40).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
        fade = np.exp(-zg / 80.0)
        ground = 128 + (ground - 128) * fade
        az = np.arctan((xx - cx) / f) + psi
        sk = cv2.remap(sky, (az * 900 + 1024).astype(np.float32), ((yh - yy) * 1.5 + 256).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
        yield np.where(yy > yh, ground, sk).clip(0, 255).astype(np.uint8)


def _encode(path: Path, frames):
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-crf", "12", "-g", "30",
                          "-pix_fmt", "yuv420p", str(path)], stdin=subprocess.PIPE)
    for fr in frames:
        p.stdin.write(fr.tobytes())
    p.stdin.close()
    assert p.wait() == 0


@pytest.fixture(scope="module")
def synth_run(tmp_path_factory):
    """a 4 s video, analysed by the real vms pass and the real far-feature chunk; the run directory holds their stored outputs"""
    import os
    os.environ["RSM_HWACCEL"] = "0"
    from rsm.angle import farfeat
    from rsm.pipeline import steps_a as SA
    from rsm.pipeline.vmsx import motion as vm
    from rsm.pipeline.vmsx.decode import probe
    d = tmp_path_factory.mktemp("synth") / "out"
    (d / "motion").mkdir(parents=True)
    (d / "rotation").mkdir()
    video = d.parent / "road.mp4"
    _encode(video, _world(120))
    stats = vm.analyse(str(video), str(d / "motion" / "motion.csv"), height=360, step=1, horizon=150.0, hwaccel=False, progress=False)
    (d / "motion" / "motion.json").write_text(json.dumps(stats))
    info = probe(str(video))
    F = C.FAR
    k = max(2, int(round(F["k_s"] * info.fps)))
    n_win = int(info.duration * info.fps / k) - 1
    hz, off = farfeat.band_horizon(stats, C.ROT_BAND_OFF_VMS, farfeat.Params.band_off)
    p = farfeat.Params(min_inl=F["min_inl"], band_off=off)
    SA._G.update(video=str(video), info=info, k=k, H=360, f=C.F_FAR, p=p, horizon=hz, min_inl=F["min_inl"], band_step=F["band_step"], n_bands=F["n_bands"])
    cw = max(10, int(round(F["chunk_s"] * info.fps / k)))
    assert n_win <= cw                                                    # one chunk: the generator is seeded 1000 and runs through all windows
    w0, out, _ = SA._chunk((0, n_win))
    NF = len(SA.FIELDS)
    idx = np.arange(0, n_win)
    meta = dict(video="video", f=C.F_FAR, k=k, fps=info.fps, horizon=hz, band_off=off, n_windows=int(n_win), n_ok=int(np.nansum(out[:, 0, NF])), wall_s=0.0,
                band_ends=SA.band_ends(hz, 360, p, F["band_step"], F["n_bands"]))
    np.savez(d / "rotation" / "win_video_base.npz", idx=idx, ta=idx * k / info.fps, tb=(idx + 1) * k / info.fps, fields=np.array(SA.FIELDS), data=out[:, :, :NF], ok=out[:, :, NF].astype(bool),
             n_pts=out[:, :, NF + 1], n_inl=out[:, :, NF + 2], why=out[:, :, NF + 3], meta=json.dumps(meta))
    return dict(d=d, video=video, n_ok=meta["n_ok"], k=k, n_win=n_win)


def test_frame_reproduces_the_stored_vms_row_and_far_window(synth_run):
    d, video = synth_run["d"], synth_run["video"]
    assert synth_run["n_ok"] > 0, "the synthetic far windows must fit, else the comparison is empty"
    for t in (0.9, 1.7, 2.6):                                          # a pair after the destatic filter has warmed up, in the middle, near the end
        r = I.frame(d, t, str(video))
        m, f = r["motion"], r["rotation"]
        assert "error" not in m and "error" not in f
        assert m["agree"], m.get("diff")                               # exactly the csv row of the step (every column as text)
        assert m["row"] == m["stored"] and m["fit"] is not None and m["fit"]["inliers"] >= 10
        assert len(m["points"]) == m["tracked"] and sum(p[4] for p in m["points"]) == m["fit"]["inliers"]
        assert f["agree"], [b for b in f["bands"] if not b["agree"]]   # every band: same point count, same ok, same A B C e within 0.05 px
        assert any(b["ok"] for b in f["bands"])
        b = next(b for b in f["bands"] if b["ok"])
        assert abs(b["A"] - b["stored"]["A"]) < 1e-9 and b["n_inl"] == b["stored"]["n_inl"]
        assert len(b["points"]) == b["n_pts"] and sum(p[4] for p in b["points"]) == b["n_inl"]
    assert r["seconds"] < 30


def test_frame_marks_a_mismatch_instead_of_hiding_it(synth_run, tmp_path):
    d, video = synth_run["d"], synth_run["video"]
    import shutil
    dd = tmp_path / "out"
    shutil.copytree(d, dd)
    mj = json.loads((dd / "motion" / "motion.json").read_text())
    mj["horizon_vms"] = mj["horizon_vms"] + 40                          # other parameters than the run had
    (dd / "motion" / "motion.json").write_text(json.dumps(mj))
    r = I.frame(dd, 1.7, str(video), ("motion",))
    assert r["motion"]["agree"] is False and r["motion"]["diff"]
    assert "rotation" not in r


def test_frame_part_failing_does_not_hide_the_other(synth_run, tmp_path):
    import shutil
    dd = tmp_path / "out"
    shutil.copytree(synth_run["d"], dd)
    (dd / "rotation" / "win_video_base.npz").unlink()
    r = I.frame(dd, 1.7, str(synth_run["video"]))
    assert "error" in r["rotation"] and r["motion"]["agree"]


def test_rng_replay_matches_the_chunk_generator():
    """the generator of window i is the chunk's generator after the draws of the windows before it (what the stored point counts say)"""
    F = dict(C.FAR)
    n_pts = np.array([[120, 0, 45], [20, 80, 80], [0, 0, 31]], float)
    z = {"n_pts": n_pts}
    rng = np.random.default_rng(1000)
    for row in n_pts[:3]:
        for n in row:
            if n >= F["min_inl"]:
                for _ in range(80):
                    rng.choice(int(n), 3, replace=False)
    mine = I._replay_rng(z, 3, 8, 30.0, F)
    assert mine.integers(1 << 30) == rng.integers(1 << 30)
