# SPDX-License-Identifier: AGPL-3.0-or-later
"""Phase 2 benchmark: shape matching of perturbed cuts of real-road tracks against a library of other cuts.

Protocol (fixed in code, in this order; the test split is only touched in step 4)
1. Queries (deterministic, seeded): cuts of 0.3 / 0.5 / 1 / 2 km at seeded random positions of every
   reference track, perturbed by the error model at level 1 (calibrated) and level 2 (twice the lateral
   noise and drift). Hard negatives: mirrored curvy cuts, near-straight cuts, cuts with an identical
   shape injected into the library, and cuts of a track that is excluded from the library.
2. Every query is matched once (alignment independent of the ranking metric); each candidate keeps all
   components. The distinct list (non-maximum suppression by window overlap) is re-ranked by every metric.
3. Development split only (roles in `tracks.ROLES`): choose the ranking score (rule below) and the status
   thresholds per score.
4. Apply the frozen choice/thresholds to the test split and report dev and test separately.

"Correct": the top-ranked candidate's matched window, mapped to the track by (origin_id, offset),
overlaps the query's true source interval (same track) by >= 50 % of the TRUE interval length
(`tracks.CORRECT_OVERLAP`). Rank of the truth = position of the first correct entry in the distinct
list (1-based; if none is correct, rank = number of distinct entries + 1 and the query counts as "not found").
top-k = rank <= k. Confident-and-wrong = status confident while the top-1 is not correct (for queries
without a truth in the library every confident answer is wrong).

Tuning rules (development split only):
- ranking score = the one with the highest mean top-1 over all dev main-query cells (length x level);
  ties within 0.5 percentage points go to the lower median truth rank.
- gap_ratio tau = smallest tau on the sorted observed ratios such that wrong answers are <= 1 % of the
  dev queries declared confident; pooled over main queries (both levels), mirrored curvy queries and
  excluded-track queries.
- max_score = 99th percentile of the best score over dev queries whose top-1 is correct.
"""
from __future__ import annotations

import json
import math
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from ..core.matcher import Candidate, MatchOptions, StatusThresholds, match
from ..core.trajectory import ScalePrior
from . import dtw as dtwmod
from . import tracks as T
from .perturb import ErrorModel, load_error_model, make_query

# DTW is an optional metric (dtaidistance with its C code loaded, see rsm/bench/dtw.py); without it the table has no DTW row.
KEYS = ("rmse_rel", "frechet_rel", "hausdorff_rel") + (("dtw_rel",) if dtwmod.available() else ()) + ("heading", "combo")
KEY_COST = {"rmse_rel": ("rmse",), "frechet_rel": ("rmse", "frechet"), "hausdorff_rel": ("rmse", "hausdorff"),
            "dtw_rel": ("rmse", "dtw"), "heading": ("heading",), "combo": ("rmse", "heading")}
TOPN = 20
PLACEHOLDER = StatusThresholds(1.0, float("inf"))  # statuses are computed later from tuned thresholds
CURVY_TURN_DEG = 90.0  # mirrored queries: only cuts whose absolute turning exceeds this (a mirrored straight is the same shape)
STRAIGHT_MAX_DEV_DEG = 12.0  # near-straight cut: heading stays within this of its mean
PREFILTER_K = 50


@dataclass(frozen=True)
class BenchConfig:
    standin: bool = False
    lengths: tuple[int, ...] = (300, 500, 1000, 2000)
    n_main: int = 20  # queries per track per length (each at both noise levels)
    n_mirror: int = 8
    n_straight: int = 6
    n_excluded: int = 8
    n_dup: int = 6
    n_prefilter: int = 6  # queries per track per length also run with the tier-1 prefilter
    seed: int = 20261109
    workers: int = 8
    error_model: str | None = "work/error_model.json"
    levels: tuple[float, ...] = (1.0, 2.0)
    n_timing: int = 3


# -- tracks and query specification ----------------------------------------------------------

_G: dict = {}


def _init_worker(payload, model_dict):
    tracks = [T.Track(n, r, p, s, t) for n, r, p, s, t in payload]
    _G["tracks"] = {t.name: t for t in tracks}
    _G["order"] = [t.name for t in tracks]
    _G["model"] = ErrorModel(**{**model_dict, "scale_clip": tuple(model_dict["scale_clip"]), "notes": tuple(model_dict["notes"])})
    _G["lib"] = {}


def _payload(tracks):
    return [(t.name, t.role, t.points, t.s, t.t) for t in tracks]


def _library(names: tuple[str, ...], length: int):
    key = (names, length)
    if key not in _G["lib"]:
        _G["lib"][key] = T.build_library([_G["tracks"][n] for n in names], length)
    return _G["lib"][key]


def _heading_stats(path: np.ndarray) -> tuple[float, float]:
    """(total absolute turning in degrees, max deviation of the heading from its mean in degrees); `path` at ~10 m
    spacing, headings from 20 m chords."""
    v = path[2:] - path[:-2] if len(path) > 4 else np.diff(path, axis=0)
    h = np.unwrap(np.arctan2(v[:, 1], v[:, 0]))
    return float(np.degrees(np.abs(np.diff(h)).sum())), float(np.degrees(np.abs(h - h.mean()).max()))


def make_specs(tracks: list[T.Track], cfg: BenchConfig) -> list[dict]:
    """All query specifications. Positions come from per-(track, length) streams of one seed: reproducible
    and independent of the number of workers."""
    specs = []
    names = tuple(t.name for t in tracks)
    for ti, tr in enumerate(tracks):
        for length in cfg.lengths:
            margin = 0.5 * length
            span = tr.length - length - 2 * margin
            if span <= 0:
                continue

            def pos(rng):
                return float(margin + rng.uniform(0, span))

            base = np.random.default_rng([cfg.seed, ti, length, 0])
            positions = [pos(base) for _ in range(cfg.n_main)]
            for k, a in enumerate(positions):
                for level in cfg.levels:
                    specs.append(dict(seed=cfg.seed, kind="main", track=tr.name, length=length, k=k, a=a, level=level, ti=ti,
                                      library=names, prefilter=(k < cfg.n_prefilter and level == cfg.levels[0])))
            # curvy / straight selection from a scan of the track (not random draws that may fail)
            scan = np.arange(margin, tr.length - length - margin, max(25.0, length / 10))
            stats = [(a, *_heading_stats(tr.cut(a, a + length, 10.0))) for a in scan]
            curvy = [a for a, turn, dev in stats if turn >= CURVY_TURN_DEG]
            straight = [a for a, turn, dev in stats if dev <= STRAIGHT_MAX_DEV_DEG]
            r1 = np.random.default_rng([cfg.seed, ti, length, 1])
            for k, a in enumerate(r1.permutation(curvy)[: cfg.n_mirror] if curvy else []):
                specs.append(dict(seed=cfg.seed, kind="mirror", track=tr.name, length=length, k=k, a=float(a), level=cfg.levels[0], ti=ti, library=names))
            r2 = np.random.default_rng([cfg.seed, ti, length, 2])
            for k, a in enumerate(r2.permutation(straight)[: cfg.n_straight] if straight else []):
                specs.append(dict(seed=cfg.seed, kind="straight", track=tr.name, length=length, k=k, a=float(a), level=cfg.levels[0], ti=ti, library=names))
            others = tuple(n for n in names if n != tr.name)
            for k, a in enumerate(positions[: cfg.n_excluded]):
                specs.append(dict(seed=cfg.seed, kind="excluded", track=tr.name, length=length, k=k, a=a, level=cfg.levels[0], ti=ti, library=others))
            for k, a in enumerate(positions[: cfg.n_dup]):
                specs.append(dict(seed=cfg.seed, kind="dup", track=tr.name, length=length, k=k, a=a, level=cfg.levels[0], ti=ti, library=names))
    return specs


def _record(res, keys, truth, accept_origins):
    """Per ranking key: the first TOPN distinct entries' scores and correctness, the truth rank, and the status inputs."""
    rec = {}
    for key in keys:
        r = res if key == res.rank_by else res.rerank(key, PLACEHOLDER)
        d = r.distinct
        corr = [truth is not None and _is_correct(m, truth, accept_origins) for m in d]
        rank = next((i + 1 for i, c in enumerate(corr) if c), None)
        rec[key] = {"n_distinct": len(d), "scores": [m.score for m in d[:TOPN]], "correct": [bool(c) for c in corr[:TOPN]],
                    "rank": rank, "found": rank is not None, "best_clamped": bool(d[0].scale_clamped) if d else False,
                    "best_scale": d[0].scale if d else None}
    return rec


def _is_correct(m, truth, accept_origins) -> bool:
    name, a, b = truth
    origin = m.origin_id
    if origin in accept_origins:
        origin = name
    return T.overlap_with_truth(origin, m.origin_start_m, m.origin_end_m, (name, a, b)) >= T.CORRECT_OVERLAP


def run_task(spec: dict) -> dict:
    tracks, model = _G["tracks"], _G["model"]
    tr = tracks[spec["track"]]
    length, a = spec["length"], spec["a"]
    path = tr.cut(a, a + length)
    # one stream per (seed, track, length, k, position): main/excluded/dup of the same cut get the same perturbation draws
    rng = np.random.default_rng([spec["seed"], spec["ti"], length, spec["k"], int(a)])
    traj, info = make_query(path, rng, model, spec["level"], mirror=spec["kind"] == "mirror", prior=ScalePrior())
    names = tuple(spec["library"])
    lib = list(_library(names, length))
    truth = None if spec["kind"] == "excluded" else (tr.name, a, a + length)
    accept = set()
    if spec["kind"] == "dup":
        # inject a rigidly moved copy of the library entry that covers the truth best, as a different place
        best = max((c for c in lib if c.origin_id == tr.name),
                   key=lambda c: T.overlap_with_truth(c.origin_id, c.origin_offset_m, c.origin_offset_m + float(np.sum(np.hypot(*np.diff(c.points, axis=0).T))), truth))
        th = rng.uniform(0, 2 * math.pi)
        rot = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
        copy = Candidate("dup:" + best.id, best.points @ rot.T + rng.uniform(-5000, 5000, 2), origin_id="dup:" + tr.name,
                         origin_offset_m=best.origin_offset_m)
        lib.append(copy)
        accept = {"dup:" + tr.name}
    opts = MatchOptions(rank_by="rmse_rel", thresholds=PLACEHOLDER, extra_metrics=dtwmod.extra_metrics())
    t0 = time.perf_counter()
    res = match(traj, lib, opts)
    wall = time.perf_counter() - t0
    out = {"spec": {k: v for k, v in spec.items() if k not in ("library",)}, "library_size": len(lib), "info": info,
           "query_length_m": traj.length, "keys": _record(res, KEYS, truth, accept), "timings": res.timings_s, "grid": res.grid,
           "true_turn_deg_abs": _heading_stats(path[::5])[0], "wall_s": wall}
    if spec.get("prefilter"):
        pre = match(traj, lib, MatchOptions(rank_by="rmse_rel", thresholds=PLACEHOLDER, prefilter_k=PREFILTER_K, extra_metrics=dtwmod.extra_metrics()))
        out["prefilter"] = {"k": PREFILTER_K, "truth_in_ranked": any(truth and _is_correct(m, truth, accept) for m in pre.ranked),
                            "truth_in_ranked_full": any(truth and _is_correct(m, truth, accept) for m in res.ranked),
                            "top1_correct": bool(pre.distinct and truth and _is_correct(pre.distinct[0], truth, accept)),
                            "time_s": pre.timings_s["total"], "time_full_s": res.timings_s["total"], "n_out": pre.n_prefiltered_out}
    return out


# -- analysis --------------------------------------------------------------------------------


def status_of(entry: dict, th: StatusThresholds) -> str:
    sc = entry["scores"]
    if not sc:
        return "no_match"
    best = sc[0]
    if best > th.max_score:
        return "no_match"
    if len(sc) < 2:
        return "confident" if entry["n_distinct"] < 2 else "ambiguous"
    ratio = math.inf if best <= 0 < sc[1] else (1.0 if best <= 0 else sc[1] / best)
    return "confident" if ratio >= th.gap_ratio else "ambiguous"


def _ratio(entry) -> float:
    sc = entry["scores"]
    if len(sc) < 2:
        return math.inf
    return math.inf if sc[0] <= 0 < sc[1] else (1.0 if sc[0] <= 0 else sc[1] / sc[0])


def tune(records: list[dict], dev_names: set[str]) -> dict:
    """Choose the ranking score and the status thresholds from DEV records only."""
    dev = [r for r in records if r["spec"]["track"] in dev_names]
    main = [r for r in dev if r["spec"]["kind"] == "main"]
    cells = sorted({(r["spec"]["length"], r["spec"]["level"]) for r in main})
    summary = {}
    for key in KEYS:
        top1 = np.mean([np.mean([r["keys"][key]["rank"] == 1 for r in main if (r["spec"]["length"], r["spec"]["level"]) == c]) for c in cells])
        ranks = [r["keys"][key]["rank"] or (r["keys"][key]["n_distinct"] + 1) for r in main]
        summary[key] = {"mean_top1_over_cells": float(top1), "median_rank": float(np.median(ranks))}
    best_top1 = max(v["mean_top1_over_cells"] for v in summary.values())
    tied = [k for k in KEYS if summary[k]["mean_top1_over_cells"] >= best_top1 - 0.005]
    chosen = min(tied, key=lambda k: (summary[k]["median_rank"], KEYS.index(k)))
    thresholds = {}
    for key in KEYS:
        pool = [r for r in dev if r["spec"]["kind"] in ("main", "mirror", "excluded")]
        obs = [(_ratio(r["keys"][key]), bool(r["keys"][key]["correct"] and r["keys"][key]["correct"][0]) and r["spec"]["kind"] == "main") for r in pool]
        cand = sorted({o[0] for o in obs if math.isfinite(o[0]) and o[0] >= 1.0})
        tau = math.inf
        for c in cand:
            conf = [ok for ratio, ok in obs if ratio >= c]
            if conf and (len(conf) - sum(conf)) / len(conf) <= 0.01:
                tau = c
                break
        if not math.isfinite(tau):
            tau = (cand[-1] * 1.0001) if cand else 1.0  # nothing reaches the target: only the very largest ratios count
        good = [r["keys"][key]["scores"][0] for r in dev if r["spec"]["kind"] == "main" and r["keys"][key]["correct"] and r["keys"][key]["correct"][0]]
        nu = float(np.percentile(good, 99)) if good else float("inf")
        thresholds[key] = {"gap_ratio": float(tau), "max_score": nu, "n_dev_correct": len(good), "n_dev_pool": len(pool)}
    return {"chosen": chosen, "per_key": summary, "thresholds": thresholds, "tied": tied}


def _rate(xs):
    return float(np.mean(xs)) if len(xs) else float("nan")


def aggregate(records: list[dict], key: str, th: StatusThresholds, split: dict) -> dict:
    """Tables for one ranking key: per (split, length, level)."""
    out = {}
    for part, names in split.items():
        sel = [r for r in records if r["spec"]["track"] in names and r["spec"]["kind"] == "main"]
        for length in sorted({r["spec"]["length"] for r in sel}):
            for level in sorted({r["spec"]["level"] for r in sel}):
                cell = [r for r in sel if r["spec"]["length"] == length and r["spec"]["level"] == level]
                if not cell:
                    continue
                ks = [r["keys"][key] for r in cell]
                ranks = [k["rank"] if k["rank"] is not None else k["n_distinct"] + 1 for k in ks]
                st = [status_of(k, th) for k in ks]
                top1 = [k["rank"] == 1 for k in ks]
                out[f"{part}|{length}|{level:g}"] = {
                    "n": len(cell), "top1": _rate(top1), "top5": _rate([k["rank"] is not None and k["rank"] <= 5 for k in ks]),
                    "top20": _rate([k["rank"] is not None and k["rank"] <= 20 for k in ks]), "median_rank": float(np.median(ranks)),
                    "not_found": _rate([not k["found"] for k in ks]),
                    "confident": _rate([s == "confident" for s in st]), "ambiguous": _rate([s == "ambiguous" for s in st]),
                    "no_match": _rate([s == "no_match" for s in st]),
                    "confident_wrong": _rate([s == "confident" and not t for s, t in zip(st, top1)]),
                    "confident_given_correct": _rate([s == "confident" for s, t in zip(st, top1) if t]),
                    "library_size": int(np.median([r["library_size"] for r in cell]))}
    return out


TURN_BINS = ((0, 45), (45, 90), (90, 180), (180, 1e9))  # total absolute turning of the true cut, degrees


def by_turn(records: list[dict], key: str, th: StatusThresholds, split: dict) -> dict:
    """Top-1 and confident rates of main queries (level 1) by how much the true cut turns, per length: where it fails."""
    out = {}
    for part, names in split.items():
        for length in sorted({r["spec"]["length"] for r in records}):
            for lo, hi in TURN_BINS:
                sel = [r for r in records if r["spec"]["track"] in names and r["spec"]["kind"] == "main" and r["spec"]["length"] == length
                       and r["spec"]["level"] == 1.0 and lo <= r["true_turn_deg_abs"] < hi]
                if not sel:
                    continue
                ks = [r["keys"][key] for r in sel]
                st = [status_of(k, th) for k in ks]
                top1 = [k["rank"] == 1 for k in ks]
                out[f"{part}|{length}|{lo}-{int(hi) if hi < 1e8 else 'inf'}"] = {
                    "n": len(sel), "top1": _rate(top1), "confident": _rate([x == "confident" for x in st]),
                    "confident_wrong": _rate([x == "confident" and not t for x, t in zip(st, top1)])}
    return out


def hard_negatives(records: list[dict], key: str, th: StatusThresholds, split: dict) -> dict:
    out = {}
    for part, names in split.items():
        for kind in ("mirror", "straight", "dup", "excluded"):
            sel = [r for r in records if r["spec"]["track"] in names and r["spec"]["kind"] == kind]
            if not sel:
                out[f"{part}|{kind}"] = {"n": 0}
                continue
            ks = [r["keys"][key] for r in sel]
            st = [status_of(k, th) for k in ks]
            top1 = [bool(k["correct"] and k["correct"][0]) for k in ks]
            d = {"n": len(sel), "confident": _rate([s == "confident" for s in st]), "ambiguous": _rate([s == "ambiguous" for s in st]),
                 "no_match": _rate([s == "no_match" for s in st])}
            if kind == "mirror":
                # truth is the mirrored original location: confident there would mean the mirror matched its own road
                d["confident_at_original_location"] = _rate([s == "confident" and t for s, t in zip(st, top1)])
            if kind in ("straight",):
                d["confident_wrong"] = _rate([s == "confident" and not t for s, t in zip(st, top1)])
                d["top1"] = _rate(top1)
            if kind == "dup":
                d["confident_wrong"] = _rate([s == "confident" for s in st])  # an identical shape twice must never be confident
            if kind == "excluded":
                d["confident_wrong"] = _rate([s == "confident" for s in st])
            out[f"{part}|{kind}"] = d
    return out


# -- driver ----------------------------------------------------------------------------------


def run(cfg: BenchConfig, out_dir: Path, tracks: list[T.Track] | None = None, log=print) -> dict:
    tracks = tracks or T.available_tracks(cfg.standin)
    model = load_error_model(cfg.error_model)
    t_all = time.perf_counter()
    specs = make_specs(tracks, cfg)
    if not dtwmod.available():
        log("note: DTW skipped (dtaidistance not importable or its C code not loaded; see rsm/bench/dtw.py): no DTW row in the tables")
    log(f"{len(specs)} query runs, {len(tracks)} tracks ({', '.join(f'{t.name}[{t.role}] {t.length / 1000:.1f} km' for t in tracks)}), "
        f"error model: {model.source}, workers {cfg.workers}")
    payload, md = _payload(tracks), model.to_dict()
    if cfg.workers <= 1:
        _init_worker(payload, md)
        records = [run_task(s) for s in specs]
    else:
        with ProcessPoolExecutor(cfg.workers, initializer=_init_worker, initargs=(payload, md)) as ex:
            records = list(ex.map(run_task, specs, chunksize=4))
    t_match = time.perf_counter() - t_all
    log(f"matching done in {t_match:.1f} s wall")

    split = {"dev": {t.name for t in tracks if t.role == "dev"}, "test": {t.name for t in tracks if t.role == "test"}}
    tuning = tune(records, split["dev"])
    chosen = tuning["chosen"]
    tables = {}
    for key in KEYS:
        th = StatusThresholds(max(tuning["thresholds"][key]["gap_ratio"], 1.0), tuning["thresholds"][key]["max_score"])
        tables[key] = {"thresholds": {"gap_ratio": th.gap_ratio, "max_score": th.max_score},
                       "cells": aggregate(records, key, th, split), "hard": hard_negatives(records, key, th, split),
                       "by_turn": by_turn(records, key, th, split)}
    timing = timing_pass(tracks, cfg, model)
    pre = prefilter_summary(records)
    lib_sizes = {str(L): len(T.build_library(tracks, L)) for L in cfg.lengths}
    result = {"config": {k: (list(v) if isinstance(v, tuple) else v) for k, v in cfg.__dict__.items()},
              "error_model": model.to_dict(), "tracks": [{"name": t.name, "role": t.role, "length_km": round(t.length / 1000, 2)} for t in tracks],
              "preprocessing": {"dedup_m": T.DEDUP_M, "smooth_sigma_m": T.SMOOTH_SIGMA_M, "step_m": T.STEP_M,
                                "library_length_factor": T.LIB_LENGTH_FACTOR, "library_margin_m": T.LIB_MARGIN_M, "library_stride_frac": T.LIB_STRIDE_FRAC},
              "library_size": lib_sizes, "n_runs": len(specs), "wall_s_matching": t_match, "tuning": tuning, "chosen": chosen,
              "tables": tables, "timing_s_per_query": timing, "prefilter": pre,
              "definitions": {"correct_overlap": T.CORRECT_OVERLAP, "topn": TOPN, "curvy_turn_deg": CURVY_TURN_DEG, "straight_max_dev_deg": STRAIGHT_MAX_DEV_DEG}}
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "bench_records.json").write_text(json.dumps(records))
    result["wall_s_total"] = time.perf_counter() - t_all
    (out_dir / "bench_results.json").write_text(json.dumps(result, indent=1))
    return result


def timing_pass(tracks, cfg: BenchConfig, model: ErrorModel) -> dict:
    """Serial timing: seconds per query for each ranking score = alignment search + that score's components."""
    _init_worker(_payload(tracks), model.to_dict())
    out = {}
    tr = tracks[0]
    for length in cfg.lengths:
        lib = _library(tuple(t.name for t in tracks), length)
        acc = []
        for k in range(cfg.n_timing):
            a = 0.5 * length + (tr.length - 2 * length) * (k + 1) / (cfg.n_timing + 1)
            traj, _ = make_query(tr.cut(a, a + length), np.random.default_rng([7, length, k]), model, 1.0)
            acc.append(match(traj, lib, MatchOptions(rank_by="rmse_rel", thresholds=PLACEHOLDER, extra_metrics=dtwmod.extra_metrics())).timings_s)
        m = {k: float(np.mean([t[k] for t in acc])) for k in acc[0]}
        search = m["coarse"] + m["refine"]
        out[str(length)] = {"library": len(lib), "search_s": search, **{key: search + sum(m[c] for c in KEY_COST[key]) for key in KEYS},
                            "all_components_s": m["components"]}
    return out


def prefilter_summary(records) -> dict:
    pr = [(r["spec"]["length"], r["prefilter"]) for r in records if "prefilter" in r]
    out = {}
    for length in sorted({l for l, _ in pr}):
        p = [x for l, x in pr if l == length]
        full = sum(x["truth_in_ranked_full"] for x in p)
        kept = sum(x["truth_in_ranked"] and x["truth_in_ranked_full"] for x in p)
        out[str(length)] = {"n": len(p), "k": PREFILTER_K, "truth_retained": kept, "truth_retained_of": full,
                            "time_ratio": float(np.sum([x["time_s"] for x in p]) / np.sum([x["time_full_s"] for x in p]))}
    return out
