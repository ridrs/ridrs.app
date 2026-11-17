# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm trajectory | trajectory-info | calibrate | bench | odometry"""
from __future__ import annotations

import argparse
import math
import sys

import numpy as np

from .io import road_reconstruction, trajectory_json


def cmd_trajectory(args: argparse.Namespace) -> int:
    traj = road_reconstruction.load(args.from_reconstruction, args.source, args.scale_min, args.scale_max)
    trajectory_json.write(traj, args.output)
    print(f"wrote {args.output}: {len(traj)} points, {traj.length:.1f} m")
    for w in traj.warnings:
        print(f"WARNING: {w}", file=sys.stderr)
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    traj = trajectory_json.read(args.file)
    steps = np.diff(traj.cumulative_distance)
    print(f"file:       {args.file}")
    print(f"points:     {len(traj)}")
    print(f"length:     {traj.length:.2f} m")
    print(f"spacing:    min {steps.min():.3f}  median {np.median(steps):.3f}  mean {steps.mean():.3f}  max {steps.max():.3f} m")
    turn = traj.total_turn(step=1.0)
    print(f"total turn: {math.degrees(turn):+.1f} deg (left positive, 1 m resampling)")
    print(f"channels:   z={'yes' if traj.z is not None else 'no'} t={'yes' if traj.t is not None else 'no'} "
          f"uncertainty={'yes' if traj.uncertainty is not None else 'no'}")
    if traj.t is not None:
        print(f"time:       {traj.t[0]:.2f} .. {traj.t[-1]:.2f} s")
    print(f"scale prior: known={traj.scale.known} min={traj.scale.min} max={traj.scale.max}; direction_known={traj.direction_known}")
    print("provenance:")
    for k, v in traj.metadata.items():
        if k != "warnings":
            print(f"  {k}: {v}")
    print(f"warnings:   {len(traj.warnings)}")
    for w in traj.warnings:
        print(f"  - {w}")
    return 0


def cmd_bench(args: argparse.Namespace) -> int:
    from pathlib import Path

    from .bench import benchmark, report

    base = benchmark.BenchConfig()
    cfg = benchmark.BenchConfig(
        standin=args.standin, lengths=tuple(args.lengths) if args.lengths else base.lengths, n_main=args.n_main, n_mirror=args.n_mirror,
        n_straight=args.n_straight, n_excluded=args.n_excluded, n_dup=args.n_dup, n_prefilter=args.n_prefilter, seed=args.seed,
        workers=args.workers, error_model=args.error_model, n_timing=args.n_timing)
    out = Path(args.out)
    res = benchmark.run(cfg, out)
    md = report.render(res, out, run_real=not args.no_real_video)
    (out / "bench_tables.md").write_text(md)
    print(md)
    return 0


def cmd_calibrate(args: argparse.Namespace) -> int:
    from .bench import calibrate

    return calibrate.main(args.out)


def cmd_odometry(args: argparse.Namespace) -> int:
    from .odometry import GateParams, TurnParams, pipeline

    gate = GateParams(max_gap_s=args.max_gap, min_segment_s=args.min_segment, exclude_before_s=args.exclude_before)
    turn = TurnParams(sigma_m=args.turn_sigma, enter_deg_per_m=args.turn_enter, exit_deg_per_m=args.turn_exit, merge_gap_m=args.turn_merge,
                      min_angle_deg=args.turn_min_angle)
    cal = None
    if args.calibration:
        from .odometry import load_calibration
        cal = load_calibration(args.calibration)
    elif not args.video_id:
        raise ValueError("--video-id is required unless --calibration is given")
    res = pipeline.run(args.csv, args.video_id or "calibrated", args.output, f360=args.focal, gate=gate, turn=turn, height_m=args.height, video_name=args.video_name,
                       calibration=cal)
    c = res["coverage"]
    print(f"{args.csv}: f360 {res['f360_px']:.1f} px, k {res['k']:.1f}; analysed {c['analysed_s']:.0f} s (excluded {c['excluded_s']:.0f} s), usable {c['usable_s']:.0f} s "
          f"= {100 * c['coverage']:.1f} % in {res['segments_usable']} segments ({res['segments_too_short']} sections too short), "
          f"{res['total_length_nominal_m']:.0f} nominal m; length quantiles (s) {res['length_s']}")
    for r in res["coverage_vs_max_gap"]:
        print(f"  max_gap {r['max_gap_s']:>4} s: {r['segments']:>3} segments, coverage {100 * r['coverage']:.1f} %")
    print(f"wrote {args.output}/segments.json and {res['segments_usable']} seg_*.trajectory.json")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="rsm")
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("trajectory", help="build trajectory.json from a road-reconstruction route folder")
    t.add_argument("--from-reconstruction", required=True, metavar="ROUTE_DIR")
    t.add_argument("--source", choices=road_reconstruction.SOURCES, default="cameras")
    t.add_argument("--scale-min", type=float, default=0.7)
    t.add_argument("--scale-max", type=float, default=1.4)
    t.add_argument("-o", "--output", required=True)
    t.set_defaults(fn=cmd_trajectory)
    i = sub.add_parser("trajectory-info", help="print statistics, provenance and warnings of a trajectory.json")
    i.add_argument("file")
    i.set_defaults(fn=cmd_info)
    b = sub.add_parser("bench", help="Phase 2 benchmark (see README); writes <out>/bench_results.json and bench_tables.md")
    b.add_argument("--standin", action="store_true", help="use the in-repository fixture GPX tracks instead of the FR_* files (harness validation only)")
    b.add_argument("--lengths", type=int, nargs="+")
    b.add_argument("--n-main", type=int, default=20)
    b.add_argument("--n-mirror", type=int, default=8)
    b.add_argument("--n-straight", type=int, default=6)
    b.add_argument("--n-excluded", type=int, default=8)
    b.add_argument("--n-dup", type=int, default=6)
    b.add_argument("--n-prefilter", type=int, default=6)
    b.add_argument("--n-timing", type=int, default=3)
    b.add_argument("--seed", type=int, default=20261109)
    b.add_argument("--workers", type=int, default=8)
    b.add_argument("--error-model", default="work/error_model.json")
    b.add_argument("--no-real-video", action="store_true")
    b.add_argument("-o", "--out", default="work/bench")
    b.set_defaults(fn=cmd_bench)
    c = sub.add_parser("calibrate", help="error-model calibration on the two real video/GPX pairs; writes <out>/error_model.json")
    c.add_argument("-o", "--out", default="work/error_model.json")
    c.set_defaults(fn=cmd_calibrate)
    o = sub.add_parser("odometry", help="vms motion CSV -> gated segments, heading over distance, turns, one trajectory.json per segment")
    o.add_argument("csv", help="CSV written by `vms motion`")
    o.add_argument("--video-id", help="selects the nominal focal length (gotthard | cayolle) unless --focal or --calibration is given")
    o.add_argument("--calibration", help="JSON from a GPS-referenced calibration (work/vangestel/calibration.json): f360, distance factor, detector parameters; overrides --focal and the --turn-*/gate options it sets")
    o.add_argument("--video-name", help="video file name for the provenance (default: the video id)")
    o.add_argument("-o", "--output", required=True, help="output folder (segments.json, seg_NNN.trajectory.json); must be inside a git-ignored work/ folder")
    o.add_argument("--focal", type=float, help="focal length in px at 360 rows (overrides the nominal value)")
    o.add_argument("--height", type=float, default=1.1, help="assumed camera height, m (nominal distance = f * height * s)")
    o.add_argument("--max-gap", type=float, default=0.5, help="an unusable run of at least this many seconds (or any cut) splits the stream; 0 = strict")
    o.add_argument("--min-segment", type=float, default=10.0, help="shortest usable segment, s")
    o.add_argument("--exclude-before", type=float, default=0.0, help="ignore the video before this time, s (e.g. a map intro)")
    o.add_argument("--turn-sigma", type=float, default=6.0)
    o.add_argument("--turn-enter", type=float, default=0.6, help="deg per metre")
    o.add_argument("--turn-exit", type=float, default=0.3, help="deg per metre")
    o.add_argument("--turn-merge", type=float, default=25.0, help="metres")
    o.add_argument("--turn-min-angle", type=float, default=25.0, help="degrees")
    o.set_defaults(fn=cmd_odometry)
    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except (ValueError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
