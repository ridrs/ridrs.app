# SPDX-License-Identifier: AGPL-3.0-or-later
"""v2 against v3 and ablations on Grimone, Roanne, Rousset (ALL THREE ARE DEVELOPMENT DATA: no blind test).

python -m rsm.track2.exp run <video> <config> [--light]      -> work/track2/res/<config>_<video>.pkl
configs: v2, v3, and ablations (see CONFIGS).  GPS enters only in scoring.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import pickle
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from scipy.ndimage import uniform_filter1d

from . import anchors as A
from . import calib
from . import combine as K
from . import consensus as C
from . import graphs, run, score, tracker

WORK = graphs.WORK
RES = WORK / "res"
VIDEOS = ("vallee-de-roanne", "col-de-grimone-1", "col-de-rousset")
FOREIGN = {"col-de-rousset": "col-de-grimone-1", "col-de-grimone-1": "vallee-de-roanne", "vallee-de-roanne": "col-de-grimone-1"}
CODE_FILES = ("graphs", "vtrack", "tracker", "route", "anchors", "score", "consensus", "combine", "calib", "run", "exp")
WRONG = ("rank25", "random", "ctl_shuffle", "ctl_mirror")

V2 = tracker.v2_params()
V3 = tracker.Params()
# name: (params, speed fit, combiner)
CONFIGS = {
    "v2": (V2, False, "stitch"),
    "v3": (V3, True, "chain"),
    "v3-no-speed": (V3, False, "chain"),
    "v3-no-stretch": (dataclasses.replace(V3, stretch=False), True, "chain"),
    "v3-no-utdesign": (dataclasses.replace(V3, ut_design=False, gap_ut_min=8.0, gap_stop_min=8.0), True, "chain"),
    "v3-no-chain": (V3, True, "stitch"),
    "v2+speed": (V2, True, "stitch"),
    "v2+stretch": (dataclasses.replace(V2, stretch=True), False, "stitch"),
    "v2+utdesign": (dataclasses.replace(V2, ut_design=True, gap_ut_min=5.0, gap_stop_min=3.0), False, "stitch"),
    "v2+chain": (V2, False, "chain"),
    # tracker-intrinsic diagnosis (used with the GPS-fed runs)
    "v3-beam1000": (dataclasses.replace(V3, beam=1000, gap_beam=1000), False, "chain"),
    "v3-qu1": (dataclasses.replace(V3, q_u=1.0), False, "chain"),
    "v3-qu4": (dataclasses.replace(V3, q_u=4.0), False, "chain"),
    "v3-noeps": (dataclasses.replace(V3, eps_on=False), False, "chain"),
    "v3-qeps1": (dataclasses.replace(V3, q_eps=0.001), False, "chain"),
    "v3-kap5": (dataclasses.replace(V3, kap_dev=0.05), False, "chain"),
    "v3-utm12": (dataclasses.replace(V3, ut_pen_move=12.0), False, "chain"),
    "v3-utm99": (dataclasses.replace(V3, ut_pen_move=99.0), False, "chain"),
    "v3-uts99": (dataclasses.replace(V3, ut_pen_stop=99.0), False, "chain"),
    "v3-sb0": (dataclasses.replace(V3, sb_stop=0.0), False, "chain"),
    "v3-ws03": (dataclasses.replace(V3, w_str=0.3), False, "chain"),
    "v3-ws01": (dataclasses.replace(V3, w_str=0.1), False, "chain"),
    "v3-ws5": (dataclasses.replace(V3, w_str=5.0, cap_str=40.0), False, "chain"),
    "v3-ws20": (dataclasses.replace(V3, w_str=20.0, cap_str=160.0), False, "chain"),
    "v3-ws3": (dataclasses.replace(V3, w_str=3.0, cap_str=24.0), False, "chain"),
    "v3-ws8": (dataclasses.replace(V3, w_str=8.0, cap_str=64.0), False, "chain"),
    "v3-wc1": (dataclasses.replace(V3, w_c=1.0), False, "chain"),
}


def code_hash() -> str:
    h = hashlib.sha256()
    for n in CODE_FILES:
        h.update((Path(__file__).parent / f"{n}.py").read_bytes())
    return h.hexdigest()


def good_run(r, cp=C.CParams()) -> float:
    lc = uniform_filter1d(r.inc, cp.g_win, mode="nearest")
    ia = int(np.flatnonzero(r.dirn == 0)[0])
    g = lc <= cp.g_thr
    if not g[ia]:
        return 0.0
    f = ia
    while f + 1 < len(g) and g[f + 1]:
        f += 1
    b = ia
    while b - 1 >= 0 and g[b - 1]:
        b -= 1
    return float(r.t[f] - r.t[b])


def compose(src, grid_t, routes, fill_holes=True):
    """pseudo route (t, E, U, xy, flag) from a time grid assignment src (route index or -1): rows of the chosen routes inside the assigned intervals"""
    t_l, E_l, U_l, xy_l, fl_l, inc_l = [], [], [], [], [], []
    n = len(grid_t)
    i = 0
    while i < n:
        if src[i] < 0:
            i += 1
            continue
        j = i
        while j + 1 < n and src[j + 1] == src[i]:
            j += 1
        r = routes[src[i]]
        m = (r.t >= grid_t[i]) & (r.t < grid_t[j] + C.GRID_S)
        t_l.append(r.t[m]); inc_l.append(r.inc[m]); E_l.append(r.E[m]); U_l.append(r.U[m]); xy_l.append(r.xy[m])
        f = r.flag[m].copy()
        if len(f):
            f[0] |= 64  # a switch of route breaks the junction statistics
        fl_l.append(f)
        i = j + 1
    if not t_l:
        return None
    return SimpleNamespace(t=np.concatenate(t_l), E=np.concatenate(E_l), U=np.concatenate(U_l), xy=np.vstack(xy_l), flag=np.concatenate(fl_l), inc=np.concatenate(inc_l))


def score_pseudo(p, T):
    if p is None or len(p.t) < 3:
        return dict(on30=0.0, on100=0.0, on_road=0.0, junc_correct=0, junc_wrong=0, junc_off=0, covered=0.0)
    o = np.argsort(p.t, kind="stable")
    q = SimpleNamespace(t=p.t[o], E=p.E[o], U=p.U[o], xy=p.xy[o], flag=p.flag[o])
    sc = score.score_route(q, T)
    ok = (q.t >= T.t0) & (q.t <= T.t1)
    cov = float(score.weights(q.t)[ok].sum() / max(T.t1 - T.t0, 1.0))
    return dict(on30=sc["on30"] * cov, on100=sc["on100"] * cov, on_road=sc["on_road"] * cov, junc_correct=sc["junc_correct"], junc_wrong=sc["junc_wrong"], junc_off=sc["junc_off"], covered=cov,
                on30_of_decided=sc["on30"], on_road_of_decided=sc["on_road"])


def decide(routes, S, T, how, cp=C.CParams()):
    """-> dict of scores of the decided/combined route of this pool; how = 'stitch' (v2: best cluster, locally best good member) or 'chain' (v3)"""
    if len(routes) < 2:
        return {}
    cl = C.cluster(routes, cp)
    top = cl["clusters"][0]
    lead_i = min(top, key=lambda i: cl["cpk"][i])
    out = dict(n_routes=len(routes), n_clusters=len(cl["clusters"]), top_size=len(top), second_size=len(cl["clusters"][1]) if len(cl["clusters"]) > 1 else 0, lead_i=lead_i)
    sc = score.score_route(routes[lead_i], T)
    out["lead"] = {k: sc[k] for k in ("on30", "on100", "on_road", "junc_correct", "junc_wrong", "junc_off")}
    tt, x, y, src = C.stitched(routes, top, cl["grid"])
    pst = compose(src, tt, routes)
    out["stitch"] = score_pseudo(pst, T)
    t0 = time.time()
    ch = K.combine(routes, S, cp, grid=cl["grid"])
    out["chain_seconds"] = time.time() - t0
    src_f = ch["src"]
    out["chain"] = score_pseudo(compose(src_f, ch["t"], routes), T)
    xf, yf, sf_ = K.fill(ch, routes)
    out["chain_filled"] = score_pseudo(compose(sf_, ch["t"], routes), T)
    out["chain_src"] = (ch["t"], src_f, sf_)
    out["chain_n_pieces"] = ch.get("n_pieces", 0)
    out["final"] = out["chain_filled"] if how == "chain" else out["stitch"]
    out["final_decided"] = out["chain"] if how == "chain" else out["stitch"]
    return out


def auc_stats(true_r, wrong_r):
    ct = [r.cost_per_km for r in true_r]; cw = [r.cost_per_km for r in wrong_r]
    gt = [good_run(r) for r in true_r]; gw = [good_run(r) for r in wrong_r]
    return dict(n_true=len(ct), n_wrong=len(cw), cpk_true=float(np.median(ct)) if ct else np.nan, cpk_wrong=float(np.median(cw)) if cw else np.nan,
                auc_cost=C.auc(ct, cw), good_true=float(np.median(gt)) if gt else np.nan, good_wrong=float(np.median(gw)) if gw else np.nan,
                auc_good=C.auc([-g for g in gt], [-g for g in gw]), wrong_cheaper=float(np.mean(np.array(cw) < np.median(ct))) if ct and cw else np.nan)


GROUPS = {"heading": ("b",), "drift": ("r",), "angle_scale": ("rho",), "straight_stretch": ("stretch", "du", "eps"), "gap_snap": ("gap_snap",), "jump": ("jump",),
          "innovation": ("innov",), "other_events": ("branch", "other")}


def comp_split(routes):
    """mean cost per km in each component group"""
    if not routes:
        return {}
    ix = {n: i for i, n in enumerate(tracker.COMP)}
    out = {}
    for g, names in GROUPS.items():
        out[g] = float(np.mean([sum(r.comp[:, ix[n]].sum() for n in names) / max(r.km, 1e-6) for r in routes]))
    out["total"] = float(np.mean([r.cost_per_km for r in routes]))
    return out


def run_config(video: str, name: str, light=False, log=print, tag=None) -> dict:
    prm, speed_fit, how = CONFIGS[name]
    t00 = time.time()
    S = run.setup(video, prm=prm)
    T = score.Truth(video, S["g"], S["fw"], log=log)
    grp = run.groups_for(S, video)
    names = ("dec", "rank25", "random") if light else ("dec", "rank25", "random", "ctl_mirror", "ctl_shuffle")
    out = dict(video=video, config=name, how=how, code_hash=code_hash(), vms_s=float(sum(s.t[-1] - s.t[0] for s in S["sf"].segs)))
    sec = 0.0
    routes = {}
    if speed_fit:
        # calibration pass: the stretch cost is relaxed so that the tracker can follow the distance scale (the realised ratio is what is measured)
        ctx0 = S["ctx"]
        S["ctx"] = dataclasses.replace(ctx0, prm=dataclasses.replace(prm, w_str=min(prm.w_str, 1.0), cap_str=min(prm.cap_str, 8.0)))
        r1, s1 = run.track_all(S, grp["dec"], log=lambda *a: None)
        S["ctx"] = ctx0
        sec += s1
        rr = [r for r in r1 if r is not None]
        X, R, W = calib.window_ratios(rr, S)
        a, b, nwin, tab = calib.fit(X, R, W)
        a = float(np.clip(a, -0.06, 0.06)); b = float(np.clip(b, -0.01, 0.06))
        out["speed_fit"] = dict(a=a, b=b, n_windows=nwin, bins=tab, knee=prm.speed_knee)
        prm = dataclasses.replace(prm, speed_a=0.0, speed_b=b)  # only the slope is applied; the intercept a is reported (the scale state eps absorbs it)
        S["ctx"] = dataclasses.replace(S["ctx"], prm=prm)
    out["prm"] = {k: v for k, v in dataclasses.asdict(prm).items() if not isinstance(v, tuple)}
    for g in names:
        if grp.get(g):
            rs, s = run.track_all(S, grp[g], log=lambda *a: None)
            routes[g] = [(a_, r) for a_, r in zip(grp[g], rs) if r is not None]
            sec += s
    out["track_seconds"] = sec
    lab = {g: [T.anchor_ok(a_) for a_, _ in routes[g]] for g in routes}
    true_r = [r for (a_, r), ok in zip(routes["dec"], lab["dec"]) if ok]
    wrong_r = [r for g in WRONG for (a_, r) in routes.get(g, [])] + [r for (a_, r), ok in zip(routes["dec"], lab["dec"]) if not ok]
    out["anchors"] = dict(n_dec=len(routes["dec"]), n_dec_true=len(true_r))
    out["sep"] = auc_stats(true_r, wrong_r)
    out["comp_true"] = comp_split(true_r); out["comp_wrong"] = comp_split(wrong_r)
    out["P1"] = decide([r for _, r in routes["dec"]], S, T, how)
    poll = [r for g in routes for _, r in routes[g]]
    t0 = time.time()
    out["P2"] = decide(poll, S, T, how)
    out["P2_seconds"] = time.time() - t0
    if not light:
        # controls: mirrored video with the true anchors; foreign map with random anchors
        Sm = run.setup(video, prm=prm, mirror=True)
        rs, s = run.track_all(Sm, grp["dec"], log=lambda *a: None); sec += s
        rm = [r for r in rs if r is not None]
        cm = C.cluster(rm, C.CParams()) if len(rm) > 1 else None
        sm = [score.score_route(r, T)["on30"] for r in rm]
        out["ctl_mirror"] = dict(cpk=float(np.median([r.cost_per_km for r in rm])), on30=float(np.median(sm)), largest_cluster=len(cm["clusters"][0]) if cm else 1, n=len(rm))
        Sf = run.setup(video, map_video=FOREIGN[video], prm=prm, cal_video=video)
        anf = A.random_anchors(Sf["fw"], Sf["t0"], Sf["t1"], max(len(grp["dec"]), 20), seed=11, kind="foreign_random")
        rs, s = run.track_all(Sf, anf, log=lambda *a: None); sec += s
        rf = [r for r in rs if r is not None]
        cf = C.cluster(rf, C.CParams())
        out["ctl_foreign"] = dict(cpk=float(np.median([r.cost_per_km for r in rf])), largest_cluster=len(cf["clusters"][0]), n=len(rf), map_video=FOREIGN[video],
                                  cheaper_than_true=float(np.mean([r.cost_per_km < out["sep"]["cpk_true"] for r in rf])))
        rr_ = [r for _, r in routes.get("random", [])]
        out["ctl_random"] = dict(cpk=float(np.median([r.cost_per_km for r in rr_])), n=len(rr_), cheaper_than_true=float(np.mean([r.cost_per_km < out["sep"]["cpk_true"] for r in rr_])) if rr_ else np.nan)
        out["control_seconds"] = sum([s])
    out["seconds"] = time.time() - t00
    RES.mkdir(parents=True, exist_ok=True)
    keep = dict(out)
    with open(RES / f"{tag or name}_{video}.pkl", "wb") as fh:
        pickle.dump(dict(out=keep, routes=routes, anchors_label=lab, prm=prm), fh)
    log(f"{video} {name}: {out['seconds']:.0f} s")
    return out


def freeze(name="frozen.json"):
    from . import vtrack
    cal = {}
    for v in VIDEOS:
        try:
            d = pickle.load(open(RES / f"v3_{v}.pkl", "rb"))["out"]
            cal[v] = d.get("speed_fit", {})
        except FileNotFoundError:
            pass
    f = dict(frozen_at=time.strftime("%Y-%m-%d %H:%M:%S"), code_hash=code_hash(), code_files=list(CODE_FILES),
             params={k: (list(v) if isinstance(v, tuple) else v) for k, v in dataclasses.asdict(V3).items()},
             cluster_params=dataclasses.asdict(C.CParams()), combine_params=dataclasses.asdict(K.KParams()),
             annotation=dict(DWELL_MIN=vtrack.DWELL_MIN, DWELL_UTURN=vtrack.DWELL_UTURN, TURN_DEG=vtrack.TURN_DEG, UT_DEG=list(vtrack.UT_DEG), UT_M=vtrack.UT_M),
             procedure="pass 1 (calibration, stretch cost relaxed to w_str 1 / cap 8) on the plaus decisions -> slope b of the speed scale from the realised map/vms distance ratio "
                       "of 320 m windows of the tracked routes (calib.fit, clipped to -0.01..0.06; intercept reported, not applied) -> pass 2 with speed_b = b on all anchors "
                       "-> combine.combine (chain). No GPS in any step. Anchors: plaus decisions (anchors.py, plaus f1 frozen).",
             speed_fits_dev=cal, data_status="all three videos (Roanne, Grimone, Rousset) are DEVELOPMENT data for v3; no blind test has been done; "
                                              "the new GPS videos in the video-source folder were not opened",
             note="one parameter set for all videos; Params defaults = frozen values")
    (WORK / name).write_text(json.dumps(f, indent=1, default=float))
    return f


def main():
    cmd = sys.argv[1]
    if cmd == "freeze":
        print(json.dumps(freeze(), default=float)[:200])
        return
    if cmd == "run":
        video, name = sys.argv[2], sys.argv[3]
        run_config(video, name, light="--light" in sys.argv)


if __name__ == "__main__":
    main()
