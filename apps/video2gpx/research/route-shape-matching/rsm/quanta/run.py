# SPDX-License-Identifier: AGPL-3.0-or-later
"""Run the window experiments for one video and write the records.

python -m rsm.quanta.run <video> --params work/quanta/params.json --out work/quanta/runs_<tag> [--sources refined baseline gps controls]

Records (one json per video): for every source and window length the per-window result of `evalrun.run_windows`. Sources:
  refined, baseline   vms quanta (frozen configurations), threshold 45
  gps                 quanta from the GPS track (upper bound)
  mirror, shuffle     controls on `refined`: left/right swapped; quantum order permuted (seed 7)
  foreign:<video>     `refined` quanta of this video against the map of another video
  first               windows grown from many start quanta (quanta needed until the first confident window), refined
"""
from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np

from . import evalrun as ev
from .area import WORK
from .chain import MapIndex, Params
from .qdef import mirror, take

VIDEOS = ("col-de-grimone-1", "vallee-de-roanne", "col-de-rousset")
TEST = "col-de-rousset"
GROW = (3, 4, 5, 6, 7, 8, 10, 12, 14, 17, 20, 25, 30, 35, 40)


def load_params(path) -> Params:
    if path and Path(path).exists():
        return Params(**json.loads(Path(path).read_text()))
    return Params()


def run_source(ix: MapIndex, q: dict, mask: np.ndarray, pos1, pos2, lengths=ev.LENGTHS) -> dict:
    out = {}
    for L in lengths:
        out[str(L)] = ev.run_windows(ix, q, ev.windows(mask, L), pos1, pos2)
    return out


def run_first(ix: MapIndex, q: dict, mask: np.ndarray, pos1, pos2, rule: dict, stride: int = 3) -> list[dict]:
    """For start quanta s: smallest L in GROW whose window [s, s+L) is confident -> correct?"""
    res = []
    for s in range(0, len(mask), stride):
        got = None
        for L in GROW:
            if s + L > len(mask) or not mask[s:s + L].all():
                break
            r = ev.run_windows(ix, q, [(s, s + L)], pos1, pos2)[0]
            if ev.confident(r, rule):
                got = dict(start=s, L=L, ok=bool(r["ok1"]), gap=r["gap"], n_matched=r["n_matched"])
                break
        res.append(got or dict(start=s, L=None))
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--params")
    ap.add_argument("--rule")
    ap.add_argument("--out", required=True)
    ap.add_argument("--sources", nargs="*", default=["refined", "baseline", "gps", "mirror", "shuffle", "foreign", "first"])
    ap.add_argument("--thr", type=float, default=45.0)
    ap.add_argument("--post-hoc", action="store_true", help="skip the frozen-hash check on the TEST video; everything written is post hoc")
    a = ap.parse_args()
    if a.video == TEST and not a.post_hoc:
        from . import freeze
        print("TEST video: frozen code hash OK", freeze.check()[:12], flush=True)
    p = load_params(a.params)
    rule = json.loads(Path(a.rule).read_text()) if a.rule else dict(gap=5.0, min_matched=3, min_score=0.0)
    ctx = ev.load_ctx(a.video, a.thr)
    t0 = time.time()
    ix = MapIndex(ctx.m, p)
    res = dict(video=a.video, thr=a.thr, params=asdict(p), rule=rule, n_legs=ix.N, n_events=int(len(ctx.m["events"]["sign"])), index_sec=time.time() - t0)
    q_ref = ev.video_q(a.video, "refined", a.thr)
    srcs = {}
    if "refined" in a.sources or "first" in a.sources or "mirror" in a.sources or "shuffle" in a.sources or "foreign" in a.sources:
        srcs["refined"] = q_ref
    if "baseline" in a.sources:
        srcs["baseline"] = ev.video_q(a.video, "baseline", a.thr)
    if "gps" in a.sources:
        srcs["gps"] = ev.gps_q(ctx, a.thr)
    res["n_quanta"], res["n_scorable"] = {}, {}
    res["runs"] = {}
    for name, q in srcs.items():
        mask = ev.scorable(ctx, q)
        p1, p2 = ev.turn_positions(ctx, q)
        res["n_quanta"][name], res["n_scorable"][name] = int(len(mask)), int(mask.sum())
        res["runs"][name] = run_source(ix, q, mask, p1, p2)
        print(a.video, name, {L: len(r) for L, r in res["runs"][name].items()}, f"{time.time()-t0:.0f}s", flush=True)
    if "mirror" in a.sources:
        q = mirror(q_ref)
        mask = ev.scorable(ctx, q_ref)
        p1, p2 = ev.turn_positions(ctx, q_ref)
        res["runs"]["mirror"] = run_source(ix, q, mask, p1, p2)
    if "shuffle" in a.sources:
        mask = ev.scorable(ctx, q_ref)
        idx = np.flatnonzero(mask)
        perm = np.random.default_rng(7).permutation(idx)
        q = take(q_ref, perm)
        p1, p2 = ev.turn_positions(ctx, q)
        res["runs"]["shuffle"] = run_source(ix, q, np.ones(len(perm), bool), p1, p2)
    if "foreign" in a.sources:
        mask = ev.scorable(ctx, q_ref)
        p1, p2 = ev.turn_positions(ctx, q_ref)
        for other in VIDEOS:
            if other == a.video or not (WORK / f"map_{other}_{int(a.thr)}.npz").exists():
                continue
            octx = ev.load_ctx(other, a.thr)
            oix = MapIndex(octx.m, p)
            # truth stays the own GPS track (all areas share the UTM zone 31 frame); windows over ALL quanta of this video that are scorable in its own area
            res["runs"][f"foreign:{other}"] = run_source(oix, q_ref, mask, p1, p2)
    if "first" in a.sources:
        mask = ev.scorable(ctx, q_ref)
        p1, p2 = ev.turn_positions(ctx, q_ref)
        res["first"] = run_first(ix, q_ref, mask, p1, p2, rule)
    res["post_hoc"] = bool(a.post_hoc)
    res["seconds"] = time.time() - t0
    Path(a.out).mkdir(parents=True, exist_ok=True)
    Path(a.out, f"{a.video}.json").write_text(json.dumps(res, default=float))
    print(f"{a.video}: done in {res['seconds']:.0f}s", flush=True)


if __name__ == "__main__":
    main()
