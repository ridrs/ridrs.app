# SPDX-License-Identifier: AGPL-3.0-or-later
"""Scoring runs: GPS videos (variants a-d, GPX, distance to anchor, Rousset long segments), Amalfi (tunnel portals as truth, variant e leave-one-out, verify points),
robustness test (5 wrong anchors per bike video)."""
from __future__ import annotations

import json
import pickle

import numpy as np

from rsm.refine import analyse, evaluate, load, segment, tunnels
from rsm.refine import anchors as A

from . import core, gate, posterior, rts
from .run import BIKES, RES, WORK, score_gps, variants_at, write_gpx

MAIN = ["viterbi", "a_pm", "old_segment", "b_post", "c_ungated", "d_gated", "c0_ungated_nomerge", "d0_gated_nomerge"]
GPXV = ["a_pm", "b_post", "c_ungated", "d_gated"]


def fmt(r):
    c = r["correct_road"]
    return f"{c['abs_mean']:5.1f} med {c['abs_median']:4.1f} p90 {c['abs_p90']:5.1f} signed {c['signed_mean']:+5.1f} | w10/20/30 {c['w10']:.2f}/{c['w20']:.2f}/{c['w30']:.2f}"


def gate_stats(V) -> dict:
    an = V["_anchors"]
    why = {}
    for r in an["gate_rej"]:
        why[r["reason"]] = why.get(r["reason"], 0) + 1
    mr = {}
    for r in an["merge_rej_d"]:
        mr[r["reason"]] = mr.get(r["reason"], 0) + 1
    return dict(candidates=len(an["feats"]), gate_rejected=len(an["gate_rej"]), gate_reasons=why, merge_rejected_after_gate=len(an["merge_rej_d"]), merge_reasons=mr, final_gated=len(an["d"]),
                final_ungated=len(an["c"]), sig_gated_q=[float(x) for x in np.percentile([a.sig_s for a in an["d"]], [10, 50, 90])] if an["d"] else None)


def long_segments(S, top: int = 6) -> list[dict]:
    """the longest segments between consecutive merged ungated curve anchors (the old per-segment method's intervals) with error per variant inside"""
    v = S["v"]; acc = sorted(v.acc, key=lambda a: a.t)
    rows = []
    for a, b in zip(acc[:-1], acc[1:]):
        m = (S["tt"] > a.t) & (S["tt"] < b.t) & S["road"]
        if m.sum() < 10:
            continue
        rows.append(dict(t0=a.t, t1=b.t, L_map=b.s - a.s, n=int(m.sum()), **{k: dict(abs_mean=float(np.abs(S["res"][k]["err"][m]).mean()), abs_max=float(np.abs(S["res"][k]["err"][m]).max())) for k in MAIN if k in S["res"]}))
    rows.sort(key=lambda r: -r["L_map"])
    return rows[:top]


def gps_all(log=print):
    allr = {}
    for n in BIKES:
        S = score_gps(n)
        v, V = S["v"], S["V"]
        log(f"== {n}: correct-road samples {int(S['road'].sum())}/{len(S['tt'])}; candidates {len(v.cand)}; old-merge anchors {len(v.acc)}", flush=True)
        for k in MAIN:
            log(f"   {k:20s} {fmt(S['res'][k])}", flush=True)
        gs = gate_stats(V)
        log(f"   gating: {gs}", flush=True)
        ls = long_segments(S)
        for r in ls[:4]:
            log(f"   long segment {r['t0']:.0f}-{r['t1']:.0f} s, {r['L_map']:.0f} m: " + "  ".join(f"{k.split('_')[0]} {r[k]['abs_mean']:.0f}/{r[k]['abs_max']:.0f}" for k in ("viterbi", "a_pm", "old_segment", "b_post", "c_ungated", "d_gated")), flush=True)
        # anchors of the gated set vs GPS: accepted/rejected error
        tt, sg, road = S["tt"], S["s_gps"], S["road"]
        def aerr(lst):
            e = []
            for a in lst:
                i = int(np.clip(np.searchsorted(tt, a.t), 0, len(tt) - 1))
                if road[i]:
                    e.append(a.s - sg[i])
            return np.array(e)
        rej_err = aerr([r["anchor"] for r in V["_anchors"]["gate_rej"]])
        kept_err = aerr(V["_anchors"]["d"])
        gs["gps_check"] = dict(kept_n=int(len(kept_err)), kept_abs_median=float(np.median(np.abs(kept_err))), kept_gt30=int((np.abs(kept_err) > 30).sum()),
                               rej_n=int(len(rej_err)), rej_abs_median=float(np.median(np.abs(rej_err))) if len(rej_err) else None, rej_gt30=int((np.abs(rej_err) > 30).sum()))
        log(f"   anchor-vs-GPS check (scoring only): {gs['gps_check']}", flush=True)
        # k(t)
        ctx = v.ctx
        for k in GPXV:
            t = np.arange(np.ceil(ctx.t_step[0]), ctx.t_step[-1], 1.0)
            s = (ctx.s_baseline(t, "pm") if k == "a_pm" else (core.fuse(v, V["_anchors"]["c"] if k == "c_ungated" else (V["_anchors"]["d"] if k == "d_gated" else []), t)["s"]))
            write_gpx(WORK / f"{n}_{k}.gpx", v, t, s, f"{n} {k}", {"a_pm": "HMM posterior mean.", "b_post": "RTS fusion, posterior only.", "c_ungated": "RTS fusion, posterior + ungated curve anchors.", "d_gated": "RTS fusion, posterior + gated curve anchors."}[k])
        tk = np.arange(np.ceil(ctx.t_step[0]), ctx.t_step[-1], 1.0)
        fd = core.fuse(v, V["_anchors"]["d"], tk)
        kq = np.percentile(fd["k"] / ctx.kappa, [5, 25, 50, 75, 95])
        allr[n] = dict(res={k: {kk: vv for kk, vv in r.items() if kk != "err"} for k, r in S["res"].items()}, gate=gs, long=ls, cross=S["cross_stats"], k_rel_quantiles=kq.tolist(),
                       kappa=ctx.kappa, path_arc_over_nominal=float((ctx.s_vit[-1] - ctx.s_vit[0]) / (ctx.D(ctx.t_step[-1]) - ctx.D(ctx.t_step[0]))),
                       huber_anchor_downweighted_c=int((fd["w_anchor"] < 0.5).sum()), n_anchor_d=len(V["_anchors"]["d"]))
        pickle.dump(dict(tt=tt, s_gps=sg, road=road, err={k: r["err"] for k, r in S["res"].items()}, dist=S["dist"], acc=v.acc, gate_rej=V["_anchors"]["gate_rej"], merge_rej_d=V["_anchors"]["merge_rej_d"],
                         d=V["_anchors"]["d"], c=V["_anchors"]["c"], cand=v.cand, feats=V["_anchors"]["feats"], fd=dict(k=fd["k"], k_sd=fd["k_sd"], s_sd=fd["s_sd"], t=tk), kappa=ctx.kappa,
                         old_segs=segment.segments(v.acc, ctx.D, ctx.gapfrac, ctx.kappa), cross=S["cross"]), open(RES / f"gps_{n}.pkl", "wb"))
    json.dump(allr, open(RES / "gps_summary.json", "w"), indent=1, default=lambda o: float(o) if isinstance(o, (np.floating, np.integer)) else str(o))


def portal_truth(ctx):
    tsrc = tunnels.TunnelAnchors()
    tanc = tsrc.anchors(ctx)
    P = sorted([dict(tunnel=a.meta["tunnel"], portal=a.meta["portal"], t=a.t, s=a.s) for a in tanc], key=lambda p: p["t"])
    ratio = {i: r.get("len_ratio") for i, r in enumerate(tsrc.matched)}
    return tsrc, tanc, P, ratio


def portal_stats(e, P, ratio) -> dict:
    a = np.abs(e)
    ent = np.array([p["portal"] == "entry" for p in P]); cons = np.array([0.4 <= (ratio.get(p["tunnel"]) or 1.0) <= 2.5 for p in P])
    return dict(n=int(len(e)), abs_mean=float(a.mean()), abs_median=float(np.median(a)), abs_max=float(a.max()), signed_entry=float(e[ent].mean()), signed_exit=float(e[~ent].mean()),
                w10=float((a <= 10).mean()), w20=float((a <= 20).mean()), w30=float((a <= 30).mean()), consistent16_abs_mean=float(a[cons].mean()), consistent16_abs_median=float(np.median(a[cons])))


def amalfi(log=print):
    v = core.load_video("Amalfi")
    ctx = v.ctx
    tsrc, tanc, P, ratio = portal_truth(ctx)
    tp = np.array([p["t"] for p in P]); sp = np.array([p["s"] for p in P])
    log(f"portals {len(P)} ({len(tsrc.matched)} dark intervals); curve candidates {len(v.cand)}, old merge {len(v.acc)}", flush=True)
    V = variants_at(v, tp)
    err = {k: o["s"] - sp for k, o in V.items() if not k.startswith("_")}
    stats = {k: portal_stats(e, P, ratio) for k, e in err.items()}
    # (e) leave-one-out: both portals of a tunnel removed, the other tunnels + gated curves merged
    e_loo = np.full(len(P), np.nan); loo_info = []
    for i in sorted({p["tunnel"] for p in P}):
        keep = [a for a in tanc if a.meta["tunnel"] != i]
        gk, _, _ = gate.gate(v.cand, v.feat)
        acc, rj = A.merge(gk + keep, ctx.D, ctx.gapfrac, ctx.kappa, local_tol=analyse.LOCAL_TOL)
        idx = [k for k, p in enumerate(P) if p["tunnel"] == i]
        o = core.fuse(v, acc, tp[idx])
        e_loo[idx] = o["s"] - sp[idx]
        loo_info.append(dict(left_out=i, n_anchors=len(acc), portal_anchors_rejected_by_merge=sum(1 for r in rj if r["anchor"].kind == "tunnel_portal")))
    err["e_tunnels_LOO"] = e_loo; stats["e_tunnels_LOO"] = portal_stats(e_loo, P, ratio)
    # (e) without the merge step (the robust fusion alone decides): leave-one-out as above
    e_loo_n = np.full(len(P), np.nan)
    for i in sorted({p["tunnel"] for p in P}):
        keep = [a for a in tanc if a.meta["tunnel"] != i]
        gk, _, _ = gate.gate(v.cand, v.feat)
        idx = [k for k, p in enumerate(P) if p["tunnel"] == i]
        e_loo_n[idx] = core.fuse(v, sorted(gk + keep, key=lambda a: a.t), tp[idx])["s"] - sp[idx]
    err["e1_tunnels_LOO_nomerge"] = e_loo_n; stats["e1_tunnels_LOO_nomerge"] = portal_stats(e_loo_n, P, ratio)
    # curves unpruned by gating but with portals, LOO (ungated reference)
    e_loo_c = np.full(len(P), np.nan)
    for i in sorted({p["tunnel"] for p in P}):
        keep = [a for a in tanc if a.meta["tunnel"] != i]
        acc, rj = A.merge(list(v.cand) + keep, ctx.D, ctx.gapfrac, ctx.kappa, local_tol=analyse.LOCAL_TOL)
        idx = [k for k, p in enumerate(P) if p["tunnel"] == i]
        e_loo_c[idx] = core.fuse(v, acc, tp[idx])["s"] - sp[idx]
    err["e0_ungated_curves_tunnels_LOO"] = e_loo_c; stats["e0_ungated_curves_tunnels_LOO"] = portal_stats(e_loo_c, P, ratio)
    for k, s in stats.items():
        log(f"   {k:32s} abs mean {s['abs_mean']:5.1f} med {s['abs_median']:5.1f} max {s['abs_max']:6.1f} signed entry/exit {s['signed_entry']:+5.1f}/{s['signed_exit']:+5.1f} w10/20/30 {s['w10']:.2f}/{s['w20']:.2f}/{s['w30']:.2f} | consistent16 {s['consistent16_abs_mean']:.1f}/{s['consistent16_abs_median']:.1f}", flush=True)
    gs = gate_stats(V)
    # gate statistics against the features (no truth)
    log(f"   gating: {gs}", flush=True)
    # all tunnels in (NOT independent), for the GPX / reference
    t = np.arange(np.ceil(ctx.t_step[0]), ctx.t_step[-1], 1.0)
    gk, _, _ = gate.gate(v.cand, v.feat)
    a_all, rj_all = A.merge(gk + tanc, ctx.D, ctx.gapfrac, ctx.kappa, local_tol=analyse.LOCAL_TOL)
    s_all = core.fuse(v, a_all, t)["s"]
    write_gpx(WORK / "Amalfi_e_tunnels.gpx", v, t, s_all, "Amalfi e_tunnels", "RTS fusion, posterior + gated curve anchors + all 9 tunnels (portals NOT independent).")
    fits = {}
    for k in GPXV:
        an = V["_anchors"]["c"] if k == "c_ungated" else (V["_anchors"]["d"] if k == "d_gated" else [])
        o = core.fuse(v, an, t) if k != "a_pm" else dict(s=ctx.s_baseline(t, "pm"))
        fits[k] = o
        write_gpx(WORK / f"Amalfi_{k}.gpx", v, t, o["s"], f"Amalfi {k}", {"a_pm": "HMM posterior mean.", "b_post": "RTS fusion, posterior only.", "c_ungated": "RTS fusion, posterior + ungated curve anchors.", "d_gated": "RTS fusion, posterior + gated curve anchors."}[k])
    # best variant without tunnel anchors, by portal error (post hoc)
    cand_best = {k: stats[k]["abs_mean"] for k in ("a_pm", "b_post", "c_ungated", "d_gated")}
    best = min(cand_best, key=cand_best.get)
    vp = json.load(open(load.ROOT / "work" / "amalfi_cal" / "verify_points.json"))
    ts = np.array([p["t"] for p in vp], float)
    if best == "a_pm":
        sv = ctx.s_baseline(ts, "pm")
    else:
        an = V["_anchors"]["c"] if best == "c_ungated" else (V["_anchors"]["d"] if best == "d_gated" else [])
        sv = core.fuse(v, an, ts)["s"]
    ll = ctx.extra["g"].to_wgs84(ctx.path.xy_at(sv)); hd = ctx.path.heading_at(sv)
    pts = [dict(t=float(t_), lat=float(b[1]), lon=float(b[0]), heading=round(float(h), 1), arc_m=round(float(a), 1)) for t_, b, h, a in zip(ts, ll, hd, sv)]
    json.dump(pts, open(WORK / "amalfi_verify_points.json", "w"), indent=1)
    sd_ = core.fuse(v, V["_anchors"]["d"], ts)["s"]       # also the gated fusion (d), clearly labelled, for the side-by-side Street View comparison
    lld = ctx.extra["g"].to_wgs84(ctx.path.xy_at(sd_)); hdd = ctx.path.heading_at(sd_)
    json.dump([dict(t=float(t_), lat=float(b[1]), lon=float(b[0]), heading=round(float(h), 1), arc_m=round(float(a), 1)) for t_, b, h, a in zip(ts, lld, hdd, sd_)], open(WORK / "amalfi_verify_points_d_gated.json", "w"), indent=1)
    old = np.array([ctx.s_baseline(ts)])[0]
    log(f"best variant without tunnel anchors (by portal abs mean): {best} {cand_best}; verify points shift vs old Viterbi: median |{np.median(np.abs(sv - old)):.1f}| m, range {(sv - old).min():.0f}..{(sv - old).max():.0f}", flush=True)
    tk = np.arange(np.ceil(ctx.t_step[0]), ctx.t_step[-1], 1.0)
    fd = core.fuse(v, V["_anchors"]["d"], tk)
    out = dict(P=P, stats=stats, err=err, gate=gs, best=best, loo_info=loo_info, ratio=ratio, verify_shift=(sv - old).tolist(), n_all_in=len(a_all), kappa=ctx.kappa,
               k_rel_quantiles=np.percentile(fd["k"] / ctx.kappa, [5, 25, 50, 75, 95]).tolist(), huber_down=int((fd["w_anchor"] < 0.5).sum()), n_anchor_d=len(V["_anchors"]["d"]))
    json.dump(out, open(RES / "amalfi_summary.json", "w"), indent=1, default=lambda o: float(o) if isinstance(o, (np.floating, np.integer)) else str(o))
    pickle.dump(dict(out=out, d=V["_anchors"]["d"], c=V["_anchors"]["c"], cand=v.cand, acc=v.acc, gate_rej=V["_anchors"]["gate_rej"], merge_rej_d=V["_anchors"]["merge_rej_d"], feats=V["_anchors"]["feats"],
                     fd=dict(k=fd["k"], k_sd=fd["k_sd"], t=tk), kappa=ctx.kappa, old_segs=segment.segments(v.acc, ctx.D, ctx.gapfrac, ctx.kappa), P=P, err=err), open(RES / "amalfi.pkl", "wb"))


def robust(log=print, n_inject: int = 5, shift: float = 100.0, seeds=range(5)):
    """5 anchors of the candidate set get their arc shifted by +-100 m (alternating); three pipelines see the same wrong candidates:
    old = merge -> per-segment k_i; c = merge -> fusion; d = gate -> merge -> fusion. Features of a shifted anchor are recomputed at the shifted arc."""
    out = {}
    for n in BIKES:
        S0 = score_gps(n, with_extra=False)
        v = S0["v"]; ctx = v.ctx
        tt, sg, road = S0["tt"], S0["s_gps"], S0["road"]
        base_old = np.abs(S0["res"]["old_segment"]["err"])[road]; base_c = np.abs(S0["res"]["c_ungated"]["err"])[road]; base_d = np.abs(S0["res"]["d_gated"]["err"])[road]
        rows = []
        for seed in seeds:
            rng = np.random.default_rng(seed)
            # inject into anchors that lie on a scored stretch
            pool = [i for i, a in enumerate(v.cand) if road[int(np.clip(np.searchsorted(tt, a.t), 0, len(tt) - 1))]]
            pick = sorted(rng.choice(pool, n_inject, replace=False).tolist())
            cand = list(v.cand)
            for j, i in enumerate(pick):
                a = cand[i]
                cand[i] = A.Anchor(a.t, a.s + (shift if j % 2 == 0 else -shift), a.kind, a.quality, a.sig_t, a.sig_s, dict(a.meta, injected=True))
            inj_t = np.array([cand[i].t for i in pick])
            near = np.min(np.abs(tt[:, None] - inj_t[None, :]), 1) < 60.0   # within 60 s of an injected anchor
            r = {}
            acc_o, _ = A.merge(cand, ctx.D, ctx.gapfrac, ctx.kappa, local_tol=analyse.LOCAL_TOL)
            survive_o = sum(1 for a in acc_o if a.meta.get("injected"))
            e_o = np.abs(core.old_method(v, acc_o, tt) - sg)
            acc_c = acc_o
            e_c = np.abs(core.fuse(v, acc_c, tt)["s"] - sg)
            gk, rg, _ = gate.gate(cand, v.feat)
            acc_d, rm = A.merge(gk, ctx.D, ctx.gapfrac, ctx.kappa, local_tol=analyse.LOCAL_TOL)
            survive_d = sum(1 for a in acc_d if a.meta.get("injected"))
            gate_rej_inj = sum(1 for x in rg if x["anchor"].meta.get("injected"))
            e_d = np.abs(core.fuse(v, acc_d, tt)["s"] - sg)
            m = road
            # feature-blind injection: the wrong anchor looks as good as the original (gate sees the features of the true position), only its arc is moved
            gb, _, _ = gate.gate(v.cand, v.feat)
            inj = {round(cand[i].t, 3): cand[i].s for i in pick}
            gb = [A.Anchor(a.t, inj.get(round(a.t, 3), a.s), a.kind, a.quality, a.sig_t, a.sig_s, dict(a.meta, injected=round(a.t, 3) in inj)) for a in gb]
            acc_b, _ = A.merge(gb, ctx.D, ctx.gapfrac, ctx.kappa, local_tol=analyse.LOCAL_TOL)
            survive_b = sum(1 for a in acc_b if a.meta.get("injected"))
            e_b = np.abs(core.fuse(v, acc_b, tt)["s"] - sg)
            for nm, e, sv in (("old", e_o, survive_o), ("c", e_c, survive_o), ("d", e_d, survive_d), ("d_blind", e_b, survive_b)):
                r[nm] = dict(abs_mean=float(e[m].mean()), abs_p90=float(np.percentile(e[m], 90)), abs_max=float(e[m].max()), near_abs_mean=float(e[m & near].mean()), near_abs_max=float(e[m & near].max()), survived_merge=int(sv))
            r["gate_rejected_injected"] = gate_rej_inj
            rows.append(r)
        b = dict(old=float(base_old.mean()), c=float(base_c.mean()), d=float(base_d.mean()))
        agg = {nm: {kk: float(np.mean([r[nm][kk] for r in rows])) for kk in rows[0][nm]} for nm in ("old", "c", "d", "d_blind")}
        agg["gate_rejected_injected_mean"] = float(np.mean([r["gate_rejected_injected"] for r in rows]))
        out[n] = dict(baseline=b, mean_over_seeds=agg, per_seed=rows)
        log(f"== {n}: baseline abs mean old {b['old']:.1f} c {b['c']:.1f} d {b['d']:.1f}", flush=True)
        for nm in ("old", "c", "d", "d_blind"):
            a = agg[nm]
            log(f"   injected, {nm:7s}: abs mean {a['abs_mean']:.1f} p90 {a['abs_p90']:.1f} max {a['abs_max']:.0f} | within 60 s of an injected anchor: mean {a['near_abs_mean']:.1f} max {a['near_abs_max']:.0f} | injected anchors surviving the merge {a['survived_merge']:.1f}/5", flush=True)
        log(f"   gate rejected {agg['gate_rejected_injected_mean']:.1f}/5 injected on average", flush=True)
    json.dump(out, open(RES / "robust.json", "w"), indent=1)
