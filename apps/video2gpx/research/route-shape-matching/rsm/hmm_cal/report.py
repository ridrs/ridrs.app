# SPDX-License-Identifier: AGPL-3.0-or-later
"""Evidence, decoy rank, figures and (only if p <= 0.05 and the evidence agrees) route points of the Amalfi calibration study. python -m rsm.hmm_cal.report"""
from __future__ import annotations

import json
import pickle

import numpy as np

from rsm.hmm import decoy as D
from rsm.hmm import figs
from rsm.network.graph import NetGraph
from rsm.nogps import cfg, verify

from . import area, run

RES, FIG = area.WORK / "res", area.WORK / "figs"


def surface_stats(r: dict) -> dict:
    S = r["scan"] / r["km"]
    fi, ki = np.unravel_index(np.nanargmax(S), S.shape)
    nb = [S[a, b] for a, b in ((fi - 1, ki), (fi + 1, ki), (fi, ki - 1), (fi, ki + 1)) if 0 <= a < S.shape[0] and 0 <= b < S.shape[1]]
    # smooth in kappa? drop of the two neighbouring kappa columns at the best f row
    return dict(best=float(S[fi, ki]), fi=int(fi), ki=int(ki), f=r["fgrid"][fi], kappa=r["kgrid"][ki], interior_f=0 < fi < S.shape[0] - 1, interior_kappa=0 < ki < S.shape[1] - 1,
                neighbour_mean=float(np.mean(nb)), neighbour_min=float(np.min(nb)), neighbour_max=float(np.max(nb)), median_all=float(np.median(S)), worst=float(S.min()))


def evidence(rt, g) -> dict:
    ev = json.loads((cfg.WORK / "evidence.json").read_text())
    ivs = [x for x in ev["dark_intervals"] if x.get("tunnel_by_eye")]
    rt.gap_edges = []
    rt.inc = np.zeros(len(rt.t))
    tc = verify.tunnel_check(rt, g, ivs, T=7631)
    places = verify.place_nodes(area.AMALFI_BBOX, cache=area.CACHE / "places.json")
    v = verify.place_check(rt, g, places, "Vietri", 30.0)
    e = verify.place_check(rt, g, places, "Erchie", 790.0)
    from pyproj import Transformer
    tr = Transformer.from_crs(4326, g.crs, always_xy=True)
    out = dict(tunnels=tc)
    for nm, key, res in (("Vietri sul Mare", "vietri", v), ("Erchie", "erchie", e)):
        pts = [p for p in places if nm.lower().split()[0] in p["name"].lower()]
        x0 = np.array(res["route_xy"])
        d_t = {p["name"]: float(np.hypot(*(np.array(tr.transform(p["lon"], p["lat"])) - x0))) for p in pts}
        out[key] = dict(window_min_m=min([x["dist_m"] for x in res["named"]] or [np.nan]), at_t_m=d_t, nearest_places_at_t=res["nearest_places_at_t"][:3], route_xy=res["route_xy"], nodes=[(p["name"], p["place"], tr.transform(p["lon"], p["lat"])) for p in pts])
    return out


def main():
    r = pickle.load(open(RES / "scan_base.pkl", "rb"))
    g, E = run.load_amalfi()
    cfg.install("base")
    rt = r["route"]
    ss = surface_stats(r)
    ev = evidence(rt, g)
    done = pickle.load(open(RES / "decoy_base.pkl", "rb"))
    rk = D.rank(done)
    tc = ev["tunnels"]
    summary = dict(surface=ss, rank=rk, vietri_window_m=ev["vietri"]["window_min_m"], vietri_at_t=ev["vietri"]["at_t_m"], erchie_window_m=ev["erchie"]["window_min_m"], erchie_at_t=ev["erchie"]["at_t_m"],
                   vietri_nearest=ev["vietri"]["nearest_places_at_t"], erchie_nearest=ev["erchie"]["nearest_places_at_t"],
                   tunnel_hits=tc["hits"], tunnel_n=tc["n"], tunnel_shift_mean=tc["shifted_hits_mean"], tunnel_shift_p95=tc["shifted_hits_p95"], tunnel_p_shift=tc["p_shift"],
                   tunnel_share_of_route_time=tc["tunnel_share_of_route_time"], tunnel_rows=[dict(t0=x["t0"], hit=x["hit"], nearest_tunnel_s=x["nearest_tunnel_s"]) for x in tc["rows"]],
                   conf=dict(mean=float(rt and r["conf"]["p"].mean()), median=float(np.median(r["conf"]["p"])), share_below_half=float((r["conf"]["p"] < 0.5).mean())),
                   route=dict(t0=float(rt.t[0]), t1=float(rt.t[-1]), n_edges=int(len(np.unique(rt.E)))), seconds=r["seconds"])
    ll = g.to_wgs84(rt.xy[[0, -1]])
    summary["route"]["start_lonlat"] = ll[0].tolist(); summary["route"]["end_lonlat"] = ll[1].tolist()
    ok_evidence = bool(ev["vietri"]["window_min_m"] < 1500 and ev["erchie"]["window_min_m"] < 1500 and tc["hits"] >= 5)
    summary["evidence_agrees"] = ok_evidence
    summary["route_points_written"] = False
    if rk["p"] <= 0.05 and ok_evidence:
        from rsm.hmm.amalfi import points
        pts = points(rt, g)
        pt = np.array([p["t"] for p in pts])
        for p, q in zip(pts, np.interp(pt, r["conf"]["t"], r["conf"]["p"])):
            p["posterior"] = float(q)
        json.dump(dict(meta="dense HMM, vms base, Amalfi calibration study, decoy p <= 0.05, evidence agrees; t = video s, heading = compass deg clockwise from north, posterior = mass of the decoded directed edge", points=pts),
                  open(area.WORK / "route_points.json", "w"))
        summary["route_points_written"] = True
    json.dump(summary, open(RES / "summary.json", "w"), indent=1, default=float)
    print(json.dumps(summary, indent=1, default=float))
    # figures
    surface_fig(r, ss, FIG / "likelihood_surface.png")
    ex = [(f"{n} node (sign at {'30' if n.startswith('V') else '790'} s)", np.array(xy)) for key in ("vietri", "erchie") for n, _, xy in ev[key]["nodes"] if n in ("Vietri sul Mare", "Erchie")]
    title = (f"Amalfi (motorcycle, post hoc), calibration scan best f_eff {r['f_best']:.0f}, kappa {r['kappa_best']:.2f}: Viterbi route of the dense HMM; "
             f"decoy rank {rk['rank']} of {rk['n'] + 1} (p = {rk['p']:.2f})")
    figs.map_fig("amalfi", g, rt, FIG / "map_amalfi_cal.png", title, evidence_pts=ex)
    conf_fig(r, tc, FIG / "confidence_amalfi_cal.png")
    figs.decoy_fig({"Amalfi (calibration scan)": (done, rk)}, FIG / "decoy_rank.png")


def surface_fig(r, ss, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    S = r["scan"] / r["km"]
    fig, ax = plt.subplots(figsize=(8.5, 4.8))
    im = ax.imshow(S, origin="lower", aspect="auto", cmap="viridis")
    for i in range(S.shape[0]):
        for j in range(S.shape[1]):
            ax.text(j, i, f"{S[i, j]:.1f}", ha="center", va="center", fontsize=7, color="w" if S[i, j] < np.nanmedian(S) else "k")
    ax.plot(ss["ki"], ss["fi"], "r*", ms=16, mfc="none", mew=1.5)
    ax.set_xticks(range(len(r["kgrid"]))); ax.set_xticklabels([f"{k:.2f}" for k in r["kgrid"]])
    ax.set_yticks(range(len(r["fgrid"]))); ax.set_yticklabels([f"{f:.0f}" for f in r["fgrid"]])
    ax.set_xlabel("kappa (distance scale, map m per nominal vms m)"); ax.set_ylabel("f_eff (px at 360 rows)")
    ax.set_title("Amalfi: best-path log-likelihood per km over (f_eff, kappa); red star = maximum", fontsize=9)
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
    ax.set_title("Amalfi, calibration scan: forward-backward posterior of the Viterbi edge over video time (grey bands: the 9 tunnels of evidence.json)", fontsize=9)
    fig.savefig(out, dpi=130, bbox_inches="tight")
    plt.close(fig)


if __name__ == "__main__":
    main()
