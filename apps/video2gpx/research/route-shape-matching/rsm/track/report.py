# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tables (markdown) and figures from work/track/res/<tag>_<video>.pkl.   python -m rsm.track.report [dev|test|all]"""
from __future__ import annotations

import json
import pickle
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import uniform_filter1d

from rsm.plaus import data
from rsm.quanta import gps

from . import anchors as A
from . import consensus as C
from . import experiment as X
from . import fig, graphs, run, score

WORK = graphs.WORK
RES = WORK / "res"
FIGS = WORK / "figs"
LABEL = {"col-de-grimone-1": "Grimone (DEV)", "vallee-de-roanne": "Roanne (DEV)", "col-de-rousset": "Rousset (TEST)"}
WRONG = ("rank25", "random", "ctl_shuffle", "ctl_mirror")


def load(tag, v):
    with open(RES / f"{tag}_{v}.pkl", "rb") as fh:
        return pickle.load(fh)


def good_run(r, cp=C.CParams()) -> float:
    """seconds of the continuous locally-fitting stretch that contains the anchor (post hoc statistic: not part of the frozen decision)"""
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


def good_share(r, cp=C.CParams()) -> float:
    return float((uniform_filter1d(r.inc, cp.g_win, mode="nearest") <= cp.g_thr).mean())


def pct(x, d=0):
    return "n/a" if x is None or not np.isfinite(x) else f"{100*x:.{d}f} %"


def group_table(o) -> str:
    L = ["| group | routes | anchor within 60 m of GPS | cost per km (median, p10-p90) | on road <= 30 m (median / mean / max) | <= 100 m (median) | on the correct edge, +-40 s (median) | junction decisions correct (all / on-route) | jumps / off-map reconnects per route | seconds |",
         "|---|---|---|---|---|---|---|---|---|---|"]
    names = {"dec": "true anchors: plaus decisions", "rank25": "wrong: stage-A rank 2-5", "random": "wrong: random road positions", "ctl_mirror": "wrong: accepted mirror-control candidates",
             "ctl_shuffle": "wrong: accepted shuffle-control candidates", "mirror_dec": "CONTROL: video mirrored, true anchors", "foreign_map": "CONTROL: other video's map, random anchors"}
    for g, d in o["groups"].items():
        s = X.summarize(d["rows"])
        if not s:
            continue
        on = f"{100*s['on30_med']:.0f} / {100*s['on30_mean']:.0f} / {100*s['on30_max']:.0f} %" if "on30_med" in s else "n/a (other map)"
        o100 = (pct(s.get("on100_med")) + " | " + pct(s.get("on_road_med"))) if "on100_med" in s else "n/a | n/a"
        j = f"{100*s['junc_share']:.0f} % / {100*s['junc_on_route_share']:.0f} %" if "junc_share" in s and np.isfinite(s["junc_on_route_share"]) else (f"{100*s['junc_share']:.0f} % / n/a" if "junc_share" in s else "n/a")
        L.append(f"| {names.get(g, g)} | {s['n']} | {pct(s['anchor_ok'])} | {s['cpk_med']:.0f} ({s['cpk_p10']:.0f}-{s['cpk_p90']:.0f}) | {on} | {o100} | {j} | {s['jumps_mean']:.1f} / {s['off_mean']:.1f} | {d['seconds']:.0f} |")
    return "\n".join(L)


def separation(o) -> dict:
    true = [r["route"] for r in o["groups"]["dec"]["rows"]]
    wr = [r["route"] for g in WRONG if g in o["groups"] for r in o["groups"][g]["rows"]]
    wr_all = wr + [r["route"] for g in ("mirror_dec", "foreign_map") if g in o["groups"] for r in o["groups"][g]["rows"]]
    d = dict(n_true=len(true), n_wrong=len(wr))
    tc, wc = np.array([r.cost_per_km for r in true]), np.array([r.cost_per_km for r in wr])
    d.update(auc_cpk=C.auc(tc, wc), cpk_true_med=float(np.median(tc)), cpk_wrong_med=float(np.median(wc)), cpk_true_range=(float(tc.min()), float(tc.max())), cpk_wrong_range=(float(wc.min()), float(wc.max())),
             wrong_below_true_median=float((wc < np.median(tc)).mean()))
    tg, wg = [good_run(r) for r in true], [good_run(r) for r in wr]
    d.update(auc_goodrun=C.auc([-x for x in tg], [-x for x in wg]), goodrun_true_med=float(np.median(tg)), goodrun_wrong_med=float(np.median(wg)), goodrun_wrong_p90=float(np.percentile(wg, 90)),
             goodrun_wrong_max=float(np.max(wg)), goodrun_true_min=float(np.min(tg)))
    tsh, wsh = [good_share(r) for r in true], [good_share(r) for r in wr]
    d.update(goodshare_true_med=float(np.median(tsh)), goodshare_wrong_med=float(np.median(wsh)))
    return d


def consensus_table(o, T) -> str:
    L = ["| pool | routes | clusters | best cluster: anchors (of which plaus decisions / anchor within 60 m of GPS) | 2nd | support ratio best : 2nd | cost per km best / 2nd | decided route (lowest cost in best cluster): on road <= 30 m | junctions correct | stitched route: coverage / on road <= 30 m of all time / of decided time |",
         "|---|---|---|---|---|---|---|---|---|---|"]
    for p, i in o["consensus"].items():
        c = i["clusters"]
        st = X.stitched_score(i, T)
        c2 = f"{c[1]['n']} ({c[1]['n_dec']} / {c[1]['n_anchor_ok']})" if len(c) > 1 else "none"
        cg = f"{c[0]['cpk_mean']:.0f} / {c[1]['cpk_mean']:.0f}" if len(c) > 1 else f"{c[0]['cpk_mean']:.0f} / -"
        ratio = f"{i['support_ratio']:.1f}" if np.isfinite(i["support_ratio"]) else "inf (no 2nd cluster)"
        ls = i["lead_score"]
        L.append(f"| {p} | {i['n_routes']} | {i['n_clusters']} | {c[0]['n']} ({c[0]['n_dec']} / {c[0]['n_anchor_ok']}) | {c2} | {ratio} | {cg} | {pct(ls['on30'])} | {pct(ls['junc_share'])} | "
                 f"{pct(st['coverage'])} / {pct(st['on30_of_all'])} / {pct(st['on30_of_decided'])} |")
    return "\n".join(L)


def breaks(route, T, seq, min_s=30.0, thr=100.0):
    """intervals (video s) where the route is > thr m from GPS for at least min_s; each with its cause (vms gap / bad vms heading / neither)"""
    d = T.dist(route.t, route.xy)
    ok = (route.t >= T.t0) & (route.t <= T.t1)
    bad = (d > thr) & ok
    out = []
    i = 0
    n = len(bad)
    while i < n:
        if bad[i]:
            j = i
            while j + 1 < n and bad[j + 1]:
                j += 1
            if route.t[j] - route.t[i] >= min_s:
                out.append((float(route.t[i]), float(route.t[j])))
            i = j + 1
        else:
            i += 1
    gaps = [(a.t[-1], b.t[0]) for a, b in zip(seq.segs[:-1], seq.segs[1:])]
    res = []
    for a, b in out:
        near_gap = max([g1 - g0 for g0, g1 in gaps if g0 - 15 <= a <= g1 + 15 or g0 - 15 <= b <= g1 + 15] or [0.0])
        res.append(dict(t0=a, t1=b, gap_s=near_gap))
    return res


def vms_heading_rms(video, tracks, T, ta, tb, rho0, win=60.0) -> float:
    """median over 60 s windows inside [ta, tb] of the rms (deg) of vms heading (rho0-scaled, free offset) against the GPS heading -- GPS used here only to explain a failure"""
    vals = []
    for x in tracks:
        for a in np.arange(max(ta, x["t"][0]), min(tb, x["t"][-1]) - win + 1e-9, win):
            m = (x["t"] >= a) & (x["t"] < a + win)
            if m.sum() < 10:
                continue
            y = np.interp(x["t"][m], T.gc["t"], T.gc["theta"])
            r = (y - y[0]) - rho0 * (x["th"][m] - x["th"][m][0])
            r = r - r.mean()
            vals.append(float(np.degrees(np.sqrt(np.mean(r ** 2)))))
    return float(np.median(vals)) if vals else np.nan


def nojump_share(r) -> float:
    """share of the tracked video time in the jump-free stretch that contains the anchor"""
    jt = r.t[(r.flag & 2) > 0]
    lo = jt[jt < r.anchor_t].max() if (jt < r.anchor_t).any() else r.t[0]
    hi = jt[jt > r.anchor_t].min() if (jt > r.anchor_t).any() else r.t[-1]
    return float((hi - lo) / max(r.t[-1] - r.t[0], 1e-9))


def failure_table(o, T, S) -> str:
    lead_i = o["consensus"]["P1_decisions"]["clusters"][0]["best"]
    rows = o["groups"]["dec"]["rows"]
    r = rows[lead_i]["route"]
    br = breaks(r, T, S["sf"])
    L = ["| from (s) | to (s) | length (s) | vms gap (> 8 s) near the start | median 60 s rms of vms heading against GPS heading in the interval (deg) | route stays > 100 m off until the end of video? |", "|---|---|---|---|---|---|"]
    for b in br[:14]:
        rms = vms_heading_rms(o["video"], S["tracks"], T, b["t0"], b["t1"], o["cal"]["rho0"])
        L.append(f"| {b['t0']:.0f} | {b['t1']:.0f} | {b['t1']-b['t0']:.0f} | {'%.0f s' % b['gap_s'] if b['gap_s'] > 8 else 'no'} | {rms:.0f} | {'yes' if b['t1'] >= T.t1 - 30 or b['t1'] >= r.t[-1] - 6 else 'no'} |")
    return "\n".join(L) + f"\n\n({len(br)} intervals of at least 30 s with the decided route more than 100 m from the GPS; the first 14 are listed)"


def make(tag: str, vids, log=print):
    FIGS.mkdir(parents=True, exist_ok=True)
    sfx = "_v2" if tag.startswith("v2") else ""
    md = []
    for v in vids:
        o = load(tag, v)
        S = run.setup(v)
        T = score.Truth(v, S["g"], S["fw"])
        md.append(f"### {LABEL[v]}\n")
        md.append(f"calibration from the accepted plaus fits (video only): angle scale rho0 {o['cal']['rho0']:.3f} (f = {449/o['cal']['rho0']:.0f}), distance scale kappa0 {o['cal']['kappa0']:.3f} ({o['cal']['n']} windows); "
                  f"vms segments {o['n_segments']}, vms time {o['vms_s']:.0f} s of {o['t_range'][1]:.0f} s; tracking area half-width {o['area']['radius_m']/1000:.1f} km; run time {o['seconds']:.0f} s\n")
        md.append(group_table(o) + "\n")
        sep = separation(o)
        md.append("Separation of true and wrong anchors (wrong = rank 2-5, random, accepted control candidates):\n")
        md.append(f"- cost per km: true median {sep['cpk_true_med']:.0f} (range {sep['cpk_true_range'][0]:.0f}-{sep['cpk_true_range'][1]:.0f}, n={sep['n_true']}), wrong median {sep['cpk_wrong_med']:.0f} "
                  f"(range {sep['cpk_wrong_range'][0]:.0f}-{sep['cpk_wrong_range'][1]:.0f}, n={sep['n_wrong']}); AUC (P[true cost < wrong cost]) {sep['auc_cpk']:.2f}; share of wrong routes cheaper than the true median {pct(sep['wrong_below_true_median'])}")
        md.append(f"- post hoc statistic, seconds of the continuous locally fitting stretch around the anchor: true median {sep['goodrun_true_med']:.0f} (min {sep['goodrun_true_min']:.0f}), wrong median {sep['goodrun_wrong_med']:.0f} "
                  f"(p90 {sep['goodrun_wrong_p90']:.0f}, max {sep['goodrun_wrong_max']:.0f}); AUC {sep['auc_goodrun']:.2f}; share of time locally fitting: true {pct(sep['goodshare_true_med'])}, wrong {pct(sep['goodshare_wrong_med'])}\n")
        nj = [nojump_share(r["route"]) for r in o["groups"]["dec"]["rows"]]
        md.append(f"- share of video time tracked without a jump (stretch around the anchor, true anchors): median {pct(np.median(nj))}, min {pct(np.min(nj))}\n")
        md.append(consensus_table(o, T) + "\n")
        md.append("Where the decided route (lowest cost in the best cluster of pool P1) leaves the GPS line:\n")
        md.append(failure_table(o, T, S) + "\n")
        # figures
        i1 = o["consensus"]["P1_decisions"]
        lead = o["groups"]["dec"]["rows"][i1["clusters"][0]["best"]]["route"]
        at = [r["anchor"] for r in o["groups"]["dec"]["rows"]]
        aw = [r["anchor"] for g in ("rank25", "random") for r in o["groups"][g]["rows"]][:60]
        cnt = fig.map_fig(v, S["g"], T, lead, at, aw, i1["stitched"], FIGS / f"map_{v}{sfx}.png", f"{LABEL[v]}: decided whole route (anchor at t = {lead.anchor_t:.0f} s), GPS reference, anchors, quantum dots")
        gaps = [(a.t[-1], b.t[0]) for a, b in zip(S["sf"].segs[:-1], S["sf"].segs[1:])]
        fig.cost_fig(v, o["groups"], gaps, FIGS / f"cost_{v}{sfx}.png", f"{LABEL[v]}: step cost over video time")
        sc = dict(junction_events=score.junctions(lead, T)["events"])
        fig.junction_fig(v, S["g"], S["fw"], T, lead, sc, S["sf"], o["cal"]["rho0"], FIGS / f"junction_{v}{sfx}.png", f"{LABEL[v]}: junction decision of the decided route")
        md.append(f"Quantum dots on the decided route: {cnt['n_map']} map quanta (turns of the route >= 45 deg), {cnt['n_vid']} video quanta (vms turns >= 45 deg in the tracked time), {cnt['n_pair']} matched pairs.\n")
        md.append(f"Figures: `figs/map_{v}{sfx}.png`, `figs/cost_{v}{sfx}.png`, `figs/junction_{v}{sfx}.png`.\n")
        log("done", v)
    (WORK / f"tables_{tag}.md").write_text("\n".join(md))


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which in ("dev", "all"):
        make("dev", X.DEV)
    if which in ("test", "all"):
        make("test", X.TEST)
    if which in ("v2", "all"):
        make("v2_dev", X.DEV)
        make("v2_test", X.TEST)
