# SPDX-License-Identifier: AGPL-3.0-or-later
"""Verification, figures and route points of the no-GPS run.  python -m rsm.nogps.report <variant>  -> work/amalfi/verify_<variant>.json, figs/, route_points.json (base)"""
from __future__ import annotations

import json
import pickle
import sys

import numpy as np

from rsm.plaus import data

from . import cfg, figs, mapbuild, stages, verify

COLMAP = cfg.ROOT / "work" / "amalfi-780.trajectory.json"


def vms_vs_colmap(label="refined", t0=780.0, t1=960.0):
    """does the vms heading of this video follow the COLMAP camera heading in 780..960 s? (cause analysis for a failed match)"""
    tr = data.vms_tracks(cfg.VIDEO, label)
    d = json.loads(COLMAP.read_text())
    P = np.array([[p["t"], p["x"], p["y"]] for p in d["points"]])
    tc, hc = verify.heading_series(P[:, 0], P[:, 1:3], sm=3.0)
    out = []
    for x in tr:
        k = (x["t"] >= t0) & (x["t"] <= t1)
        if k.sum() < 20:
            continue
        tg = np.arange(max(x["t"][k][0], tc[0]) + 3, min(x["t"][k][-1], tc[-1]) - 3, 1.0)
        if len(tg) < 30:
            continue
        hv = np.interp(tg, x["t"], x["th"]); hcc = np.interp(tg, tc, hc)
        rv, rc = np.gradient(hv), np.gradient(hcc)
        out.append(dict(corr=float(np.corrcoef(rv, rc)[0, 1]), net_vms_deg=float(np.degrees(hv[-1] - hv[0])), net_colmap_deg=float(np.degrees(hcc[-1] - hcc[0])), span=[float(tg[0]), float(tg[-1])]))
    return out


def main():
    variant = sys.argv[1]
    cfg.install(variant)
    ctx = mapbuild.load_ctx()
    g = ctx.g
    o = pickle.load(open(cfg.WORK / "res" / f"track_{variant}.pkl", "rb"))
    ev = json.loads((cfg.WORK / "evidence.json").read_text())
    tunnels = ev["tunnels"]
    places = verify.place_nodes(ctx.area["bbox"])
    routes, anchors = o["routes"], o["anchors_tracked"]
    dec = o["decision"]
    lead = routes[dec["lead"]]
    res = dict(variant=variant, lead_index=int(dec["lead"]), lead_anchor_t=float(anchors[dec["lead"]]["t"]), lead_cpk=float(lead.cost_per_km), support_ratio=dec["support_ratio"])

    def check(r):
        tc = verify.tunnel_check(r, g, tunnels)
        v = verify.place_check(r, g, places, "Vietri", 30.0)
        e = verify.place_check(r, g, places, "Erchie", 790.0)
        return dict(tunnel_hits=tc["hits"], tunnel_n=tc["n"], tunnel_shift_mean=tc["shifted_hits_mean"], tunnel_p_shift=tc["p_shift"], tunnel_share=tc["tunnel_share_of_route_time"],
                    vietri_m=min([x["dist_m"] for x in v["named"]] or [np.nan]), erchie_m=min([x["dist_m"] for x in e["named"]] or [np.nan]), full=tc, v=v, e=e)

    res["lead"] = check(lead)
    res["all_routes"] = [dict(anchor_t=float(a["t"]), cpk=float(r.cost_per_km), **{k: v for k, v in check(r).items() if k not in ("full", "v", "e")}) for a, r in zip(anchors, routes)]
    res["random_routes"] = [dict(cpk=float(r.cost_per_km), **{k: v for k, v in check(r).items() if k not in ("full", "v", "e")}) for r in o["random_routes"]]
    res["colmap_shape"] = verify.colmap_shape(lead, COLMAP)
    res["colmap_shape_all"] = [verify.colmap_shape(r, COLMAP) for r in routes]
    res["vms_vs_colmap"] = vms_vs_colmap()
    res["tunnel_ways_on_lead"] = verify.tunnel_ways_on_route(lead, g)[0]
    (cfg.WORK / f"verify_{variant}.json").write_text(json.dumps(res, indent=1, default=float))
    # figures
    (cfg.WORK / "figs").mkdir(exist_ok=True)
    evd = dict(tunnels=[(r["t0"], r["t1"], r["route_xy"], "") for r in res["lead"]["full"]["rows"] if r["hit"] or True],
               signs=[(30.0, "Vietri sul Mare (sign)", res["lead"]["v"]["route_xy"]), (790.0, "ERCHIE (sign)", res["lead"]["e"]["route_xy"])])
    figs.map_fig(g, lead, [a for a in anchors], evd, cfg.WORK / "figs" / f"map_{variant}.png", f"{variant}: formal decision (lowest-cost member of the best cluster; support {dec['clusters'][0]['n']} of {dec['n_routes']}), NOT credible")
    figs.cost_fig(o, cfg.WORK / "figs" / f"cost_{variant}.png", f"{variant}: step cost over video time", tunnels=[(t["t0"], t["t1"]) for t in tunnels])
    if variant == "base":
        pts = verify.route_points(lead, g)
        meta = dict(note="Decided route of the no-GPS pipeline (lowest-cost member of the best anchor cluster) for the Amalfi video. The decision is NOT credible: all anchors disagree (support 1 vs 1), cost per km 108 against 21-38 for true routes on the GPS videos. Use only as a hypothesis.",
                    anchor_video_t=res["lead_anchor_t"], cost_per_km=res["lead_cpk"], heading="compass degrees clockwise from north", source="work/amalfi/res/track_base.pkl")
        (cfg.WORK / "route_points.json").write_text(json.dumps(dict(meta=meta, points=pts), default=float))
    print(json.dumps({k: v for k, v in res.items() if k not in ("lead", "all_routes", "random_routes", "colmap_shape_all")}, default=float)[:1500])


if __name__ == "__main__":
    main()
