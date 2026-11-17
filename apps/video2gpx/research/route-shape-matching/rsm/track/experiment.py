# SPDX-License-Identifier: AGPL-3.0-or-later
"""DEV run, freeze, TEST run, controls.

python -m rsm.track.experiment dev            Grimone + Roanne (all groups and controls)        -> work/track/res/dev_<video>.pkl
python -m rsm.track.experiment freeze         work/track/frozen.json (parameters + sha256 of the code)
python -m rsm.track.experiment test           Rousset, once, refuses to run unless the code hash equals the frozen one
"""
from __future__ import annotations

import hashlib
import json
import pickle
import sys
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np

from . import anchors as A
from . import consensus as C
from . import graphs, run, score, tracker

WORK = graphs.WORK
RES = WORK / "res"
DEV = ("col-de-grimone-1", "vallee-de-roanne")
TEST = ("col-de-rousset",)
FOREIGN = {"col-de-rousset": "col-de-grimone-1", "col-de-grimone-1": "vallee-de-roanne", "vallee-de-roanne": "col-de-grimone-1"}
CODE_FILES = ("graphs", "vtrack", "tracker", "route", "anchors", "score", "consensus", "run", "experiment")


def code_hash() -> str:
    h = hashlib.sha256()
    for n in CODE_FILES:
        h.update((Path(__file__).parent / f"{n}.py").read_bytes())
    return h.hexdigest()


def _params():
    f = WORK / "frozen.json"
    prm = tracker.Params(); cp = C.CParams()
    return prm, cp


def run_video(video: str, prm, cp, tag: str, log=print) -> dict:
    t00 = time.time()
    S = run.setup(video, prm=prm)
    T = score.Truth(video, S["g"], S["fw"], log=log)
    grp = run.groups_for(S, video)
    out = dict(video=video, cal=S["cal"], tag=tag, groups={}, code_hash=code_hash(), n_segments=len(S["sf"].segs), t_range=(S["t0"], S["t1"]),
               vms_s=float(sum(s.t[-1] - s.t[0] for s in S["sf"].segs)), area=graphs.area_for(video))
    for name in ("dec", "rank25", "random", "ctl_mirror", "ctl_shuffle"):
        an = grp.get(name, [])
        if not an:
            continue
        routes, sec = run.track_all(S, an, log=log)
        out["groups"][name] = _pack(an, routes, T, sec)
    # controls: mirrored video with the true anchors; foreign map with random anchors
    Sm = run.setup(video, prm=prm, mirror=True)
    an = grp["dec"]
    routes, sec = run.track_all(Sm, an, log=log)
    out["groups"]["mirror_dec"] = _pack(an, routes, T, sec)
    fv = FOREIGN[video]
    Sf = run.setup(video, map_video=fv, prm=prm, cal_video=video)
    anf = A.random_anchors(Sf["fw"], Sf["t0"], Sf["t1"], max(len(grp["dec"]), 20), seed=11, kind="foreign_random")
    routes, sec = run.track_all(Sf, anf, log=log)
    out["groups"]["foreign_map"] = _pack(anf, routes, None, sec)
    out["foreign_map_video"] = fv
    out["consensus"] = consensus_tables(out, cp)
    out["seconds"] = time.time() - t00
    RES.mkdir(parents=True, exist_ok=True)
    with open(RES / f"{tag}_{video}.pkl", "wb") as fh:
        pickle.dump(out, fh)
    return out


def _pack(anchors, routes, T, sec):
    rows = []
    for a, r in zip(anchors, routes):
        if r is None:
            continue
        sc = score.score_route(r, T) if T is not None else None
        lab = T.anchor_ok(a) if T is not None else False
        rows.append(dict(anchor=a, route=r, score=sc, anchor_ok=lab))
    return dict(rows=rows, seconds=sec, n_anchors=len(anchors), n_tracked=len(rows))


def summarize(rows) -> dict:
    if not rows:
        return {}
    cpk = np.array([r["route"].cost_per_km for r in rows])
    d = dict(n=len(rows), cpk_med=float(np.median(cpk)), cpk_p10=float(np.percentile(cpk, 10)), cpk_p90=float(np.percentile(cpk, 90)),
             jumps_mean=float(np.mean([r["route"].n_jumps for r in rows])), off_mean=float(np.mean([r["route"].n_off for r in rows])),
             anchor_ok=float(np.mean([r["anchor_ok"] for r in rows])))
    if rows[0]["score"] is not None:
        for k in ("on30", "on100", "on_road"):
            v = np.array([r["score"][k] for r in rows]); d[k + "_med"] = float(np.median(v)); d[k + "_mean"] = float(v.mean()); d[k + "_max"] = float(v.max())
        jc = sum(r["score"]["junc_correct"] for r in rows); jn = sum(r["score"]["junc_n"] for r in rows)
        jw = sum(r["score"]["junc_wrong"] for r in rows)
        d["junc_share"] = jc / jn if jn else np.nan
        d["junc_on_route_share"] = jc / (jc + jw) if jc + jw else np.nan
    return d


def consensus_tables(out, cp) -> dict:
    """final decision on two anchor pools: P1 = plaus decisions only, P2 = decisions + rank 2-5 + random + accepted control candidates (polluted)."""
    res = {}
    G = out["groups"]
    for pool_name, names in (("P1_decisions", ("dec",)), ("P2_polluted", ("dec", "rank25", "random", "ctl_mirror", "ctl_shuffle"))):
        rows = [r for n in names for r in G.get(n, {}).get("rows", [])]
        for r, n in zip(rows, [n for n in names for _ in G.get(n, {}).get("rows", [])]):
            r["_g"] = n
        if len(rows) < 2:
            continue
        routes = [r["route"] for r in rows]
        cl = C.cluster(routes, cp)
        cls = []
        for mem in cl["clusters"][:6]:
            cls.append(dict(n=len(mem), n_dec=sum(rows[i]["_g"] == "dec" for i in mem), n_anchor_ok=sum(rows[i]["anchor_ok"] for i in mem),
                            cpk_mean=float(np.mean(cl["cpk"][mem])), best=int(min(mem, key=lambda i: cl["cpk"][i]))))
        top = cl["clusters"][0]
        lead = rows[min(top, key=lambda i: cl["cpk"][i])]
        tt, x, y, src = C.stitched(routes, top, cl["grid"])
        info = dict(n_routes=len(rows), n_clusters=len(cl["clusters"]), clusters=cls, lead_score=_light(lead["score"]), lead_cpk=float(lead["route"].cost_per_km),
                    lead_anchor_t=float(lead["anchor"]["t"]))
        if lead["score"] is not None:
            truth_t = out.get("_truth")
        info["stitched"] = dict(t=tt, x=x, y=y, src=src)
        info["support_ratio"] = (cls[0]["n"] / cls[1]["n"]) if len(cls) > 1 else np.inf
        info["cost_gap"] = (cls[1]["cpk_mean"] - cls[0]["cpk_mean"]) if len(cls) > 1 else np.nan
        res[pool_name] = info
    return res


def _light(sc):
    if sc is None:
        return None
    return {k: v for k, v in sc.items() if k not in ("dist", "ok", "w")}


def stitched_score(info, T) -> dict:
    st = info["stitched"]
    ok = (st["t"] >= T.t0) & (st["t"] <= T.t1)
    d = np.full(len(st["t"]), np.inf)
    m = np.isfinite(st["x"]) & ok
    d[m] = T.dist(st["t"][m], np.column_stack([st["x"][m], st["y"][m]]))
    return dict(coverage=float(m.sum() / max(ok.sum(), 1)), on30_of_all=float((d[ok] <= 30).mean()), on30_of_decided=float((d[m] <= 30).mean()) if m.any() else np.nan,
                on100_of_all=float((d[ok] <= 100).mean()))


def freeze(prm, cp, name="frozen.json", note=None):
    f = dict(frozen_at=time.strftime("%Y-%m-%d %H:%M:%S"), code_hash=code_hash(), params={k: (list(v) if isinstance(v, tuple) else v) for k, v in asdict(prm).items()},
             cluster_params=asdict(cp), calibration={v: A.video_cal(v) for v in DEV + TEST}, plaus_frozen=str(Path(A.P.WORK / "frozen.json")),
             note=note or "parameters are the code defaults; DEV = Grimone + Roanne (whole videos); Rousset (TEST) run once after this file was written")
    (WORK / name).write_text(json.dumps(f, indent=1, default=float))
    return f


def main():
    cmd = sys.argv[1]
    tag = sys.argv[2] if len(sys.argv) > 2 else None
    prm, cp = _params()
    if cmd == "dev":
        for v in DEV:
            o = run_video(v, prm, cp, tag or "dev")
            print(v, "done in", round(o["seconds"]), "s")
    elif cmd == "freeze":
        print(json.dumps(freeze(prm, cp, *(sys.argv[2:4] if len(sys.argv) > 2 else [])), default=float)[:300])
    elif cmd == "test":
        name = sys.argv[3] if len(sys.argv) > 3 else "frozen.json"
        f = json.loads((WORK / name).read_text())
        if f["code_hash"] != code_hash():
            raise SystemExit(f"code hash {code_hash()[:12]} != frozen {f['code_hash'][:12]} ({name}): refusing to run TEST")
        for v in TEST:
            o = run_video(v, prm, cp, tag or "test")
            print(v, "done in", round(o["seconds"]), "s")


if __name__ == "__main__":
    main()
