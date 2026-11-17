# SPDX-License-Identifier: AGPL-3.0-or-later
"""Evidence, decoy rank, route difference to the vms route, figures of the far-yaw Amalfi decode. python -m rsm.hmm_far.report"""
from __future__ import annotations

import json
import pickle
from dataclasses import replace

import numpy as np
from scipy.spatial import cKDTree

from rsm.hmm import decoy as D, exp, figs
from rsm.hmm_cal import area, report as crep, run as crun
from rsm.nogps import cfg
from rsm.odometry.turns import TurnParams, detect_turns
from rsm.quanta import video as qvideo
from rsm.track2 import fig as t2fig

from . import run as R

RES, FIG = R.RES, R.WORK / "figs"
VMS_PKL = area.WORK / "res" / "scan_base.pkl"


def route_diff(g, ra, rb) -> dict:
    """far route ra against vms route rb on the common 1 s time grid: share of time on a different directed / undirected edge, distance at equal time, and the geometric
    deviation (distance of every sample of ra to the polyline of rb)"""
    t0, t1 = max(ra.t[0], rb.t[0]), min(ra.t[-1], rb.t[-1])
    tg = np.arange(np.ceil(t0), np.floor(t1) + 1.0)
    ia = np.clip(np.rint((tg - ra.t[0]) / (ra.t[1] - ra.t[0])).astype(int), 0, len(ra.t) - 1)
    ib = np.clip(np.rint((tg - rb.t[0]) / (rb.t[1] - rb.t[0])).astype(int), 0, len(rb.t) - 1)
    ea, eb = ra.E[ia], rb.E[ib]
    u, v = np.asarray(g.edge_u), np.asarray(g.edge_v)
    und = lambda e: np.minimum(u[e], v[e]) * 10_000_000 + np.maximum(u[e], v[e])
    d_t = np.hypot(*(ra.xy[ia] - rb.xy[ib]).T)
    # geometric: densify rb
    seg = np.hypot(*np.diff(rb.xy, axis=0).T)
    pts = [rb.xy[0]]
    for i in range(len(seg)):
        if seg[i] < 400:
            n = max(1, int(seg[i] // 5))
            pts += [rb.xy[i] + (rb.xy[i + 1] - rb.xy[i]) * (k / n) for k in range(1, n + 1)]
    tree = cKDTree(np.array(pts))
    dgeo = tree.query(ra.xy[ia])[0]
    far_edges = set(map(int, ea)); vms_edges = set(map(int, eb))
    el = np.asarray(g.edge_len)
    return dict(n_s=int(len(tg)), share_diff_directed_edge=float((ea != eb).mean()), share_diff_undirected_edge=float((und(ea) != und(eb)).mean()),
                dist_equal_time_median=float(np.median(d_t)), dist_equal_time_p90=float(np.percentile(d_t, 90)), dist_equal_time_max=float(d_t.max()), share_gt50m_equal_time=float((d_t > 50).mean()),
                geo_dev_max=float(dgeo.max()), geo_dev_p99=float(np.percentile(dgeo, 99)), share_geo_gt50m=float((dgeo > 50).mean()),
                time_geo_gt50m_s=float((dgeo > 50).sum()), edges_far=len(far_edges), edges_vms=len(vms_edges), edges_common=len(far_edges & vms_edges),
                km_edges_only_far=float(el[sorted(far_edges - vms_edges)].sum() / 1000), km_edges_only_vms=float(el[sorted(vms_edges - far_edges)].sum() / 1000),
                t=tg, differs=(und(ea) != und(eb)), dgeo=dgeo, d_t=d_t)


def surface_fig(r, ss, out, vms=None):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    S = r["scan"] / r["km"]
    fig, ax = plt.subplots(figsize=(8.5, 5.4))
    im = ax.imshow(S, origin="lower", aspect="auto", cmap="viridis")
    for i in range(S.shape[0]):
        for j in range(S.shape[1]):
            ax.text(j, i, f"{S[i, j]:.1f}", ha="center", va="center", fontsize=7, color="w" if S[i, j] < np.nanmedian(S) else "k")
    ax.plot(ss["ki"], ss["fi"], "r*", ms=16, mfc="none", mew=1.5)
    ax.set_xticks(range(len(r["kgrid"]))); ax.set_xticklabels([f"{k:.2f}" for k in r["kgrid"]])
    ax.set_yticks(range(len(r["fgrid"]))); ax.set_yticklabels([f"{f:.0f}" for f in r["fgrid"]])
    ax.set_xlabel("kappa (distance scale, map m per nominal vms m)"); ax.set_ylabel("f_eff (px at 360 rows; rad_eff = rad_far * f_A / f_eff, f_A = 404.9)")
    t = "Amalfi, far-feature yaw: best-path log-likelihood per km over (f_eff, kappa); red star = maximum"
    if vms:
        t += f"\n(vms-yaw run: peak {vms['best']:.1f} per km at f_eff {vms['f']:.0f}, kappa {vms['kappa']:.2f})"
    ax.set_title(t, fontsize=9)
    fig.colorbar(im, ax=ax, label="log-lik per km")
    fig.savefig(out, dpi=130, bbox_inches="tight")
    plt.close(fig)


def conf_fig(r, tc, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    c = r["conf"]
    fig, ax = plt.subplots(figsize=(11, 3.6))
    ax.plot(c["t"], c["p"], color="#1f5fbf", lw=1)
    for x in tc["rows"]:
        ax.axvspan(x["t0"], x["t1"], color="#444", alpha=0.5, lw=0)
    ax.axvline(30, color="#d62728", ls="--", lw=0.8); ax.axvline(790, color="#d62728", ls="--", lw=0.8)
    ax.text(30, 1.03, "Vietri sign", fontsize=7, color="#d62728"); ax.text(790, 1.03, "ERCHIE sign", fontsize=7, color="#d62728")
    ax.set_ylim(-0.02, 1.1); ax.set_xlabel("video time (s)"); ax.set_ylabel("posterior of the decoded edge")
    ax.set_title("Amalfi, far-feature yaw: forward-backward posterior of the Viterbi edge over video time (grey bands: the 9 tunnels of evidence.json)", fontsize=9)
    fig.savefig(out, dpi=130, bbox_inches="tight")
    plt.close(fig)


def patch_video_quanta(tracks, a_ang):
    """the quantum dots of rsm.track2.fig.dots take the video turns from the vms segments; swap in the turns of the far-yaw tracks (calibrated angle a_ang * th) for this process"""
    c = qvideo.config("refined", "amalfi")
    tp = replace(TurnParams(**{**TurnParams().to_dict(), **c.get("turn", {})}), min_angle_deg=25.0)

    def segments(video, label="refined"):
        out = []
        for i, tr in enumerate(tracks):
            s, t, th = np.asarray(tr["s"]), np.asarray(tr["t"]), np.asarray(tr["th"]) * a_ang
            out.append((float(t[0]), float(t[-1]), float(s[-1]), detect_turns(s, th, t, tp), i))
        return out
    qvideo.segments = segments


def route_diff_fig(g, ra, rb, rd, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection
    fig, axs = plt.subplots(1, 2, figsize=(14, 5.5), gridspec_kw=dict(width_ratios=[1.6, 1]))
    ax = axs[0]
    lo, hi = np.minimum(ra.xy.min(0), rb.xy.min(0)) - 800, np.maximum(ra.xy.max(0), rb.xy.max(0)) + 800
    ax.add_collection(LineCollection(t2fig._net_lines(g, lo, hi), colors="#e0e0e0", linewidths=0.4))
    ax.plot(rb.xy[:, 0], rb.xy[:, 1], color="#999999", lw=4, alpha=0.8, label="vms-yaw route")
    ax.plot(ra.xy[:, 0], ra.xy[:, 1], color="#1f5fbf", lw=1.4, label="far-yaw route")
    ia = np.clip(np.rint((rd["t"] - ra.t[0]) / (ra.t[1] - ra.t[0])).astype(int), 0, len(ra.t) - 1)
    m = rd["differs"]
    ax.scatter(ra.xy[ia][m, 0], ra.xy[ia][m, 1], s=5, c="#d62728", zorder=5, label=f"far route, other road than vms route ({m.sum()} s)")
    ax.set_xlim(lo[0], hi[0]); ax.set_ylim(lo[1], hi[1]); ax.set_aspect("equal"); ax.legend(fontsize=8, loc="lower left")
    ax.set_title("Amalfi: far-yaw route against the vms-yaw route (c) OpenStreetMap contributors, ODbL", fontsize=9)
    axs[1].plot(rd["t"], rd["dgeo"], color="#d62728", lw=0.7, label="distance of far route to vms route (geometry)")
    axs[1].plot(rd["t"], rd["d_t"], color="#1f5fbf", lw=0.5, alpha=0.6, label="distance at equal video time")
    axs[1].set_yscale("symlog", linthresh=10); axs[1].set_xlabel("video time (s)"); axs[1].set_ylabel("m"); axs[1].legend(fontsize=7)
    fig.savefig(out, dpi=120, bbox_inches="tight")
    plt.close(fig)


def portal_fig(fs, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    P = fs["P"]
    e = np.array(fs["portal"]["d_gated"]["err"]); ev = np.array(fs["portal"]["viterbi"]["err"])
    x = np.arange(len(P))
    fig, ax = plt.subplots(figsize=(11, 3.8))
    ax.bar(x - 0.2, ev, 0.4, color="#999999", label="Viterbi")
    ax.bar(x + 0.2, e, 0.4, color="#1f5fbf", label="fusion (d), far-yaw anchors")
    ax.set_xticks(x); ax.set_xticklabels([f"T{p['tunnel']} {p['portal'][:2]}" for p in P], rotation=70, fontsize=7)
    ax.axhline(0, color="k", lw=0.5); ax.set_ylabel("along-track error at the portal (m)"); ax.legend(fontsize=8)
    ax.set_title("Amalfi far-yaw route: along-track error at the tunnel portals (truth = luminance time + OSM portal arc)", fontsize=9)
    fig.savefig(out, dpi=130, bbox_inches="tight")
    plt.close(fig)


def main():
    r = pickle.load(open(RES / "scan_far.pkl", "rb"))
    vms = pickle.load(open(VMS_PKL, "rb"))
    g, E = crun.load_amalfi()
    cfg.install("base")
    rt = r["route"]
    ss = crep.surface_stats(r)
    ev = crep.evidence(rt, g)
    done = pickle.load(open(RES / "decoy_far.pkl", "rb"))
    rk = D.rank(done)
    tc = ev["tunnels"]
    sv = crep.surface_stats(vms)
    fine = pickle.load(open(RES / "fine_far.pkl", "rb"))
    # parabolic f at the best kappa column
    S = r["scan"] / r["km"]
    col = S[:, ss["ki"]]
    fi = ss["fi"]
    pf = None
    if 0 < fi < len(col) - 1:
        x = np.log(np.array(r["fgrid"])[fi - 1:fi + 2]); y = col[fi - 1:fi + 2]
        a, b, _ = np.polyfit(x, y, 2)
        pf = float(np.exp(-b / (2 * a)))
    rd = route_diff(g, rt, vms["route"])
    nq = None
    summary = dict(surface=ss, vms_surface=sv, f_parabola=pf, rank=rk, vietri_window_m=ev["vietri"]["window_min_m"], vietri_at_t=ev["vietri"]["at_t_m"], erchie_window_m=ev["erchie"]["window_min_m"], erchie_at_t=ev["erchie"]["at_t_m"],
                   tunnel_hits=tc["hits"], tunnel_n=tc["n"], tunnel_shift_mean=tc["shifted_hits_mean"], tunnel_shift_p95=tc["shifted_hits_p95"], tunnel_p_shift=tc["p_shift"],
                   tunnel_share_of_route_time=tc["tunnel_share_of_route_time"], tunnel_rows=[dict(t0=x["t0"], hit=x["hit"], nearest_tunnel_s=x["nearest_tunnel_s"]) for x in tc["rows"]],
                   conf=dict(mean=float(r["conf"]["p"].mean()), median=float(np.median(r["conf"]["p"])), share_below_half=float((r["conf"]["p"] < 0.5).mean()),
                             vms_mean=float(vms["conf"]["p"].mean()), vms_share_below_half=float((vms["conf"]["p"] < 0.5).mean())),
                   route_diff={k: v for k, v in rd.items() if not isinstance(v, np.ndarray)},
                   route=dict(t0=float(rt.t[0]), t1=float(rt.t[-1]), n_edges=int(len(np.unique(rt.E))), vms_n_edges=int(len(np.unique(vms["route"].E)))),
                   fine=dict(f=fine["f"], k=fine["k"], S=fine["S"].tolist()), seconds=r["seconds"])
    d = np.hypot(*np.diff(rt.xy, axis=0).T); d = d[d < 400]
    dv = np.hypot(*np.diff(vms["route"].xy, axis=0).T); dv = dv[dv < 400]
    summary["route"].update(map_km=float(d.sum() / 1000), vms_map_km=float(dv.sum() / 1000), nominal_km=float(r["km"]), mean_speed=float(d.sum() / (rt.t[-1] - rt.t[0])))
    ll = g.to_wgs84(rt.xy[[0, -1]])
    summary["route"]["start_lonlat"] = ll[0].tolist(); summary["route"]["end_lonlat"] = ll[1].tolist()
    json.dump(summary, open(RES / "summary.json", "w"), indent=1, default=lambda o: float(o) if isinstance(o, (np.floating, np.integer)) else str(o))
    print(json.dumps(summary, indent=1, default=float))
    FIG.mkdir(parents=True, exist_ok=True)
    surface_fig(r, ss, FIG / "likelihood_surface.png", vms=sv)
    conf_fig(r, tc, FIG / "confidence_amalfi_far.png")
    figs.decoy_fig({"Amalfi (far-feature yaw)": (done, rk)}, FIG / "decoy_rank.png")
    ex = [(f"{n} node (sign at {'30' if n.startswith('V') else '790'} s)", np.array(xy)) for key in ("vietri", "erchie") for n, _, xy in ev[key]["nodes"] if n in ("Vietri sul Mare", "Erchie")]
    patch_video_quanta(R.far_tracks(), float(r["par"].a_ang))
    title = (f"Amalfi (motorcycle, post hoc), far-feature yaw, best f_eff {r['f_best']:.0f}, kappa {r['kappa_best']:.2f}: Viterbi route of the dense HMM; "
             f"decoy rank {rk['rank']} of {rk['n'] + 1} (p = {rk['p']:.2f})")
    figs.map_fig("amalfi", g, rt, FIG / "map_amalfi_far.png", title, evidence_pts=ex)
    route_diff_fig(g, rt, vms["route"], rd, FIG / "route_diff_vs_vms.png")
    fp = RES / "fuse_summary.json"
    if fp.exists():
        portal_fig(json.load(open(fp)), FIG / "portal_errors.png")


if __name__ == "__main__":
    main()
