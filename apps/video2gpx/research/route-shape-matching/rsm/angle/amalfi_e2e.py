# SPDX-License-Identifier: AGPL-3.0-or-later
"""POST HOC end-to-end rerun of the Amalfi no-GPS pipeline (rsm.nogps, same network, area, rules, frozen thresholds) with a given angle scale f360.

Amalfi was seen in the matching before this study, so this is not a blind test. Outputs: work/angle/amalfi/<tag>/ ; the area graph and the map quanta are read
from work/amalfi (cached there, not rewritten).

  PYTHONPATH=. .venv/bin/python tools/memguard.py --max-gb 12 --min-free 25 -- .venv/bin/python -m rsm.angle.amalfi_e2e <tag> <f360>
"""
from __future__ import annotations

import json
import pickle
import sys
import time

import numpy as np

from rsm.plaus import freeze as PF
from rsm.quanta import video as qvideo
from rsm.track import experiment as TX

from rsm.nogps import cfg, mapbuild, stages, trackrun, verify
from . import videos

OUT = videos.WORK / "amalfi"


def install(tag: str, f360: float) -> str:
    fz = json.loads(cfg.VMS_FROZEN.read_text())
    c = dict(fz["configs"]["baseline"])
    c["csv"], c["f360"] = "work/amalfi/vms/{video}.csv", float(f360)
    fz["configs"] = {"refined": c}
    (OUT / tag).mkdir(parents=True, exist_ok=True)
    f = OUT / tag / "frozen_params.json"
    f.write_text(json.dumps(fz, indent=1))
    qvideo.FROZEN = f
    return "refined"


def checks(route, g, ev, places):
    tc = verify.tunnel_check(route, g, ev["tunnels"])
    v = verify.place_check(route, g, places, "Vietri", 30.0)
    e = verify.place_check(route, g, places, "Erchie", 790.0)
    return dict(tunnel_hits=tc["hits"], tunnel_n=tc["n"], tunnel_shift_mean=tc["shifted_hits_mean"], tunnel_p_shift=tc["p_shift"],
                vietri_m=min([x["dist_m"] for x in v["named"]] or [np.nan]), erchie_m=min([x["dist_m"] for x in e["named"]] or [np.nan]))


def main(tag: str, f360: float, procs: int = 4):
    print("plaus code hash OK", PF.check()[:12], flush=True)
    fz = json.loads((TX.WORK / "frozen_v2.json").read_text())
    assert fz["code_hash"] == TX.code_hash(), "rsm.track differs from frozen_v2"
    ctx = mapbuild.load_ctx()  # cached graph and map of work/amalfi
    label = install(tag, f360)
    res = {}
    t0 = time.time()
    for ctl in (None, "mirror"):
        src = stages.Source(ctx, label, ctl=ctl)
        recs = stages.run_windows(src, f"{tag}/{ctl}", procs=procs)
        with open(OUT / tag / f"recs{'_mirror' if ctl else ''}.pkl", "wb") as fh:
            pickle.dump(recs, fh)
        res["mirror" if ctl else "real"] = dict(n_quanta=len(src.q["t0"]), windows=len(recs), stats=stages.window_stats(recs), decisions=len(stages.decisions(recs)))
        print(tag, ctl, res["mirror" if ctl else "real"]["decisions"], "decisions", flush=True)
        if ctl is None:
            real = recs
    res["seconds_stage"] = time.time() - t0
    cal = stages.video_cal(real)
    res["cal"] = cal
    if cal is None:
        (OUT / tag / "result.json").write_text(json.dumps(res, indent=1, default=float))
        print("no accepted windows: no calibration")
        return res
    t0 = time.time()
    o = trackrun.run_all(ctx, real, dict(rho0=cal["rho"], kappa0=cal["kappa"], n=cal["n"], **{k: cal[k] for k in ("rho_iqr", "kappa_iqr")}), log=lambda *a, **k: None)
    res["seconds_track"] = time.time() - t0
    with open(OUT / tag / "track.pkl", "wb") as fh:
        pickle.dump(o, fh)
    evd = json.loads((cfg.WORK / "evidence.json").read_text())
    places = verify.place_nodes(ctx.area["bbox"])
    routes, anchors = o.get("routes", []), o.get("anchors_tracked", [])
    res["n_decisions"], res["n_anchors"], res["n_routes"] = o["n_decisions"], len(o["anchors"]), len(routes)
    if routes:
        d = o["decision"]
        lead = routes[d["lead"]]
        res["clusters"] = [dict(n=c["n"], cpk_mean=c["cpk_mean"], cpk_best=c["cpk_best"], good_run_best=c["good_run_best"], anchor_t=c["anchor_t"]) for c in d["clusters"]]
        res["support_ratio"], res["cost_gap"] = d["support_ratio"], d["cost_gap"]
        res["lead_checks"] = checks(lead, ctx.g, evd, places)
        res["lead_cpk"] = float(lead.cost_per_km)
        res["all_routes"] = [dict(anchor_t=float(a["t"]), cpk=float(r.cost_per_km), **checks(r, ctx.g, evd, places)) for a, r in zip(anchors, routes)]
        res["colmap_shape"] = verify.colmap_shape(lead, cfg.ROOT / "work" / "amalfi-780.trajectory.json")
        res["tunnels_total"] = len(evd["tunnels"])
        res["random_cpk"] = [float(r.cost_per_km) for r in o.get("random_routes", [])]
        res["mirror_cpk"] = [float(r.cost_per_km) for r in o.get("mirror_routes", [])]
        res["pool_with_random"] = {k: v for k, v in o.get("pool_dec_random", {}).items() if k in ("n_routes", "n_clusters", "support_ratio")}
        pts = verify.route_points(lead, ctx.g)
        (OUT / tag / "route_points.json").write_text(json.dumps(dict(meta=dict(tag=tag, f360=f360, post_hoc=True, cost_per_km=res["lead_cpk"], heading="compass degrees clockwise from north"), points=pts), default=float))
    (OUT / tag / "result.json").write_text(json.dumps(res, indent=1, default=float))
    print(json.dumps({k: v for k, v in res.items() if k not in ("all_routes", "random_cpk", "mirror_cpk", "colmap_shape")}, default=float)[:2500])
    return res


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]))
