# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.angle.cli a-run <video> [--tag t] [options]   far-feature tracking + chi2 curves -> work/angle/a_<video>_<tag>.pkl (needs cv2: vms venv)"""
from __future__ import annotations

import argparse
import pickle
import resource
import sys
from dataclasses import fields

from . import farfeat, videos


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("a-run")
    a.add_argument("video")
    a.add_argument("--tag", default="base")
    a.add_argument("--procs", type=int, default=4)
    a.add_argument("--no-hwaccel", action="store_true")
    a.add_argument("--k1", default="0")
    a.add_argument("--colmap-ranges", action="store_true", help="only stretches inside the COLMAP windows of the video")
    for fl in fields(farfeat.Params):
        if fl.name != "k1_grid":
            a.add_argument("--" + fl.name.replace("_", "-"), type=type(fl.default), default=fl.default)
    args = ap.parse_args(argv)
    if args.cmd == "a-run":
        kw = {fl.name: getattr(args, fl.name) for fl in fields(farfeat.Params) if fl.name != "k1_grid"}
        p = farfeat.Params(**kw, k1_grid=tuple(float(x) for x in args.k1.split(",")))
        v = videos.VIDEOS[args.video]
        ranges = None
        if args.colmap_ranges:
            from . import refs
            ranges = [(float(w.t[0]), float(w.t[-1])) for r in v["routes"] for w in refs.load_windows(r)]
        res = farfeat.run_video(str(v["video"]), str(v["csv"]), videos.horizon(args.video), p, procs=args.procs, hwaccel=not args.no_hwaccel, ranges=ranges)
        res["peak_rss_gb_parent"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**30
        videos.WORK.mkdir(parents=True, exist_ok=True)
        out = videos.WORK / f"a_{args.video}_{args.tag}.pkl"
        with open(out, "wb") as fh:
            pickle.dump(res, fh)
        pool = farfeat.pool_f(res)
        bs = farfeat.bootstrap_f(res)
        print(f"{args.video} {args.tag}: f = {pool['f']:.1f}  CI {bs['lo']:.0f}-{bs['hi']:.0f}  ({bs['n_stretch']} stretches, {res['seconds']:.0f} s)" if pool and bs else "no result")


if __name__ == "__main__":
    sys.exit(main())
