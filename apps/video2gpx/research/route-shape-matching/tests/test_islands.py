# SPDX-License-Identifier: AGPL-3.0-or-later
"""Island refinement (rsm.pipeline.islands, GOTTHARD_DIAGNOSIS sections 4 and 7): islands, open parts (bridges, tails), the decision rule."""
from types import SimpleNamespace

import numpy as np

from rsm.hmm import seq
from rsm.pipeline import config as C, islands as I


def test_island_mask_needs_agreement_posterior_usable_landmarks():
    T_ = 300
    st = SimpleNamespace(t=np.arange(T_, dtype=float))
    near = np.ones(T_, bool); near[:60] = False                       # start on another road
    p = np.ones(T_); p[150:155] = 0.5                                  # posterior dip splits 60-149 / 155-299
    us = np.ones(T_); us[200:210] = 0.3                                # odometry failure splits 155-199 / 210-299
    lm_ok = np.ones(T_, bool)
    curved = lambda i, j: 400.0 if i <= 120 <= j else 0.0               # the curved road is at 120 s
    n_lm = lambda i, j: 2 if i >= 210 else 0                           # the last one has two landmarks
    isl = I.island_mask(st, near, p, us, lm_ok, curved, n_lm)
    assert not isl[:60].any() and isl[60:150].all() and not isl[150:210].any() and isl[210:].all()
    lm_ok[100:105] = False                                             # an unexplained landmark: 60-99 (no curve) is no island any more
    isl = I.island_mask(st, near, p, us, lm_ok, curved, n_lm)
    assert not isl[60:105].any() and isl[105:150].all()


def test_parts_bridges_and_tails():
    t = np.arange(100, dtype=float)
    isl = np.zeros(100, bool); isl[30:50] = True; isl[60:80] = True
    parts = I.parts_of(isl, t)
    assert parts == [("start", 0, 30), ("bridge", 49, 60), ("end", 79, 99)]
    assert I.parts_of(np.zeros(100, bool), t) == []


def test_decide_landmarks_then_nats_else_search_uncertain():
    h = lambda name, u, s: dict(name=name, unexplained=u, score=s)
    # (1) fewer unexplained landmarks wins even with a lower score (Gotthard: the bypass leaves the two right turns unexplained)
    assert I.decide([h("search", 0, -100.0), h("local", 2, -60.0)]) == (0, False)
    assert I.decide([h("search", 2, -60.0), h("local", 0, -100.0)]) == (1, False)
    # (2) same landmarks: >= LOCAL_ACCEPT_NATS better
    assert I.decide([h("search", 0, -100.0), h("local", 0, -100.0 + C.LOCAL_ACCEPT_NATS + 1)]) == (1, False)
    # (3) otherwise the search route, uncertain because the other one is close
    assert I.decide([h("search", 0, -100.0), h("local", 0, -98.0)]) == (0, True)
    assert I.decide([h("search", 0, -100.0), h("local", 0, -120.0)]) == (0, False)


def test_slice_steps_scales_distance_only():
    s = np.arange(0, 400.0, 4.0)
    st = seq.make_steps([dict(t=s / 8.0, s=s, th=np.zeros_like(s))], d0=15.0)
    sl = I.slice_steps(st, 3, 10, 1.5)
    assert sl.T == 8 and np.allclose(sl.mu, st.mu[3:11] * 1.5) and np.allclose(sl.t, st.t[3:11])


def test_new_config_values_rerun_only_their_steps(tmp_path, monkeypatch):
    """odometry failure handling reruns route_search on (it builds the steps), more road classes / islands rerun refine on; motion, rotation and map never"""
    from rsm.pipeline.cli import Run, parse_args
    vid, pbf = tmp_path / "v.mp4", tmp_path / "p.pbf"
    vid.write_bytes(b"x"); pbf.write_bytes(b"y")
    run = Run(parse_args(["run", "--video", str(vid), "--bbox", "1,2,3,4", "--pbf", str(pbf), "--out", str(tmp_path / "o")]))
    base = dict(video=str(vid), bbox=dict(south=1, west=2, north=3, east=4), pbf=str(pbf), vehicle="auto", offset_m=None, start_time=None, traffic_side="auto", decoys=0,
                start_tol_m=150.0, hint_buffer_m=300.0, hint_fallback="auto")
    h0 = run.hashes(base)
    first = {"route_search": ["ODO_FAIL_ON", "ODO_FAIL_USABLE", "ODO_FAIL_WIN_S", "ODO_FAIL_MIN_S", "ODO_FAIL_MERGE_S", "ODO_NB_S", "ODO_GAP_MU_X", "ODO_GAP_REL", "ODO_GAP_UPPER",
                              "GAP_SYS_REL", "ODO_LOW_USABLE", "ODO_LOW_WIN_S", "ODO_LOW_REL", "VERDICT_MOTOR_POST", "VEH_K_MOTOR", "VEH_V90_MOTOR", "VEH_K_BIKE", "VEH_V90_BIKE", "VERDICT_MOTOR_SAME"],
             "refine": ["LOCAL_ISL_ON", "LOCAL_ISL_CONF", "LOCAL_ISL_USABLE", "LOCAL_ISL_MIN_LM", "LOCAL_ISL_CURVE_M", "LOCAL_ISL_CURVE_DEG", "LOCAL_ISL_REACH_X",
                        "LOCAL_ISL_REACH_MAX_M", "LOCAL_ISL_K", "LOCAL_ISL_ALT_WIN", "LOCAL_ISL_SHAPE_REL", "LOCAL_ISL_SCALES", "LOCAL_ISL_SCALE_SD", "LOCAL_EXT_CLASSES_MOTOR", "LOCAL_EXT_CLASSES_BIKE",
                        "LOCAL_EXT_MIN_S", "LOCAL_EXT_BUF_M", "LOCAL_EXT_NATS_PER_KM"],
             None: ["TRUNC_MIN_S", "TRUNC_FRAC"]}                         # a status of the motion step only: no rerun
    steps = list(C.STEPS)
    for step, names in first.items():
        for nm in names:
            v = getattr(C, nm)
            with monkeypatch.context() as m:
                if not isinstance(v, bool):                                # the values count while their feature is on
                    m.setattr(C, "LOCAL_ISL_ON", True); m.setattr(C, "ODO_FAIL_ON", True); m.setattr(C, "VERDICT_MOTOR_POST", True)
                ref = run.hashes(base)
                new = (not v) if isinstance(v, bool) else (v + ("x",) if isinstance(v[0], str) else tuple(x * 1.1 for x in v)) if isinstance(v, tuple) else v * 1.5 + 1
                m.setattr(C, nm, new)
                h1 = run.hashes(base)
            for s_ in steps:
                same = step is None or steps.index(s_) < steps.index(step)
                assert (h1[s_] == ref[s_]) == same, (nm, s_)
    assert run.hashes(base) == h0


def test_motor_posterior_only_when_auto_said_bike_and_kappa_says_motor(tmp_path):
    import json
    from rsm.pipeline import steps_b
    (tmp_path / "rotation").mkdir()
    (tmp_path / "motion").mkdir()
    (tmp_path / "motion" / "summary.json").write_text(json.dumps(dict(v_nom_p90=5.0)))   # real p90 = 5 x kappa: kappa 1.2 -> 6 m/s, a bike
    res = dict(kappa=2.0, f_eff=300.0)
    for veh, k, fires in ((dict(requested="car", effective="car"), 2.0, False), (dict(requested="auto", effective="bike"), 1.2, False)):
        (tmp_path / "rotation" / "vehicle.json").write_text(json.dumps(veh))
        assert steps_b.motor_posterior(tmp_path, {}, None, None, [], None, dict(res, kappa=k), None, None) is None
