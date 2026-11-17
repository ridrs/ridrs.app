# SPDX-License-Identifier: AGPL-3.0-or-later
"""Benchmark of the turn-sequence matcher (`rsm.core.turnseq`) on stand-in tracks with a MEASURED vms error model. No map, no video.

python -m rsm.bench.turnseq_bench --out work/turnseq            # everything (error model, benchmark, growth, controls, real queries, runtime)
python -m rsm.bench.turnseq_bench --stage errmodel              # only the error-model measurement

Stages: errmodel | bench | growth | real | runtime (comma separated; default all). Needs work/odometry/compare/results.json and
work/odometry/{gotthard,cayolle}/segments.json (produced by the odometry commands in README.md) and the stand-in GPX fixtures.
See the docstrings below and work/turnseq/RESULTS.md for definitions. Nothing derived from the GPX tracks except aggregate numbers is written.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..core.turnseq import (ConfidenceThresholds, QSegment, QTurn, TurnLibrary, TurnMatchParams, TurnPath, TurnQuery, search)

ROOT = Path(__file__).resolve().parents[2]
COMPARE = ROOT / "work/odometry/compare/results.json"
VMS_DIRS = {"gotthard": ROOT / "work/odometry/gotthard/segments.json", "cayolle": ROOT / "work/odometry/cayolle/segments.json"}
COLMAP_TO_TRUE = 1.2  # Phase 1: COLMAP camera-height scale gave 1.207 and 1.197 times the GPX length (assumed to carry over)
P_FLIP_ASSUMED = 0.02  # ASSUMED: observed 0/21 (and 11/11 hand checks); see RESULTS.md
ARTEFACT = ("cayolle-1630/m1", 170.69)  # the greedy time-overlap pairing artefact, excluded from the angle fit (reported with and without)


def jeffreys(k: int, n: int) -> tuple[float, float, float]:
    """Posterior mean (Beta(0.5, 0.5) prior) and the 90 % central interval."""
    from scipy.stats import beta

    a, b = k + 0.5, n - k + 0.5
    return a / (a + b), float(beta.ppf(0.05, a, b)), float(beta.ppf(0.95, a, b))


# ----------------------------------------------------------------------------------------------------------------------
# 1. error model, measured


def measure_error_model(compare: Path = COMPARE, vms: dict[str, Path] = VMS_DIRS) -> dict:
    r = json.loads(Path(compare).read_text())
    turns_c, pairs, extras, pieces = [], [], [], []
    for w in r["windows"]:
        for p in w["pieces"]:
            ct, vt = p["turns_colmap"], p["turns_vms"]
            missed = set(p["missed"])
            for i, t in enumerate(ct):
                turns_c.append(dict(window=w["window"], A=abs(t["angle_deg"]), missed=i in missed, clipped=bool(t["clipped"])))
            for q in p["turn_pairs"]:
                c, v = ct[q["colmap"]], vt[q["vms"]]
                pairs.append(dict(window=w["window"], A=q["colmap_deg"], a=q["vms_deg"], dt=0.5 * (v["t_start"] + v["t_end"]) - 0.5 * (c["t_start"] + c["t_end"]),
                                  clipped_c=bool(c["clipped"]), clipped_v=bool(v["clipped"]), err_pct=q["err_pct"]))
            for j in p["extra"]:
                extras.append(dict(window=w["window"], a=vt[j]["angle_deg"], clipped=bool(vt[j]["clipped"])))
            pieces.append(dict(window=w["window"], colmap_len=p["colmap_length_m"], ratio=p["length_ratio_vms_over_colmap"], fit_scale=p["shape"]["scale"]))
    out: dict = {"n_windows": len(r["windows"])}
    # miss probability by COLMAP turn size
    bins = [(25, 45), (45, 90), (90, 400)]
    mt = []
    for lo, hi in bins:
        sel = [t for t in turns_c if lo <= t["A"] < hi]
        k = sum(t["missed"] for t in sel)
        m, a, b = jeffreys(k, len(sel))
        mt.append(dict(bin=[lo, hi], n=len(sel), missed=k, missed_clipped=sum(t["missed"] and t["clipped"] for t in sel), mean=m, lo90=a, hi90=b))
    k_large = sum(t["missed"] for t in turns_c if t["A"] >= 45)
    n_large = sum(t["A"] >= 45 for t in turns_c)
    m, a, b = jeffreys(k_large, n_large)
    out["miss"] = dict(by_bin=mt, ge45=dict(n=n_large, missed=k_large, mean=m, lo90=a, hi90=b), n_total=len(turns_c), missed_total=sum(t["missed"] for t in turns_c))
    # extras
    km = sum(p["colmap_len"] for p in pieces) / 1000.0
    n_vms = len(pairs) + len(extras)
    out["extra"] = dict(n=len(extras), per_vms_turn=len(extras) / n_vms, n_vms_turns=n_vms, colmap_km=km, per_km=len(extras) / km,
                        per_km_jeffreys=jeffreys(len(extras), 1)[0] if False else None, note="km = sum of COLMAP piece lengths (4000 and 4000-dense windows overlap in time, so km is slightly overcounted)")
    # sign flips
    out["sign_flip"] = dict(n=len(pairs), flips=sum(np.sign(q["A"]) != np.sign(q["a"]) for q in pairs), jeffreys=jeffreys(0, len(pairs)),
                            hand_checks="11/11 agree", assumed_used=P_FLIP_ASSUMED)
    # angle error
    def angstats(ps):
        lr = np.array([math.log(abs(q["a"]) / abs(q["A"])) for q in ps])
        ae = np.array([abs(q["a"]) - abs(q["A"]) for q in ps])
        big = np.array([abs(q["A"]) >= 60 for q in ps])
        mad = lambda x: 1.4826 * float(np.median(np.abs(x - np.median(x))))
        d = dict(n=len(ps), ln_ratio_median=float(np.median(lr)), ln_ratio_mean=float(lr.mean()), ln_ratio_sd=float(lr.std(ddof=1)), ln_ratio_mad_sd=mad(lr),
                 abs_err_deg_median=float(np.median(np.abs(ae))), abs_err_deg_mean=float(np.abs(ae).mean()),
                 rel_err_pct_median_abs=float(np.median(np.abs(np.exp(lr) - 1)) * 100))
        if big.sum() > 2:
            d["ge60"] = dict(n=int(big.sum()), ln_ratio_median=float(np.median(lr[big])), ln_ratio_mad_sd=mad(lr[big]), rel_err_pct_median_abs=float(np.median(np.abs(np.exp(lr[big]) - 1)) * 100))
        if (~big).sum() > 2:
            d["lt60"] = dict(n=int((~big).sum()), ln_ratio_median=float(np.median(lr[~big])), ln_ratio_mad_sd=mad(lr[~big]), rel_err_pct_median_abs=float(np.median(np.abs(np.exp(lr[~big]) - 1)) * 100))
        return d, lr
    clean = [q for q in pairs if not (q["window"] == ARTEFACT[0] and abs(abs(q["a"] - q["A"]) - ARTEFACT[1]) < 0.1)]
    out["angle_all"], _ = angstats(pairs)
    out["angle"], lr = angstats(clean)
    out["angle_ratio_samples"] = [float(math.exp(x)) for x in lr]
    out["angle_excluded_artefact"] = len(pairs) - len(clean)
    out["position"] = dict(centre_time_diff_s_median_abs=float(np.median([abs(q["dt"]) for q in pairs])), centre_time_diff_s_p90_abs=float(np.percentile([abs(q["dt"]) for q in pairs], 90)),
                           note="centre of the vms turn minus centre of the COLMAP turn, video seconds (a bad pair of the artefact type gives 7 and 15 s)")
    # distance scale per piece (vms nominal / COLMAP), pieces with COLMAP length >= 20 m
    rp = np.array([p["ratio"] for p in pieces if p["colmap_len"] >= 20])
    out["scale_vms_over_colmap"] = dict(n=len(rp), min=float(rp.min()), q25=float(np.percentile(rp, 25)), median=float(np.median(rp)), q75=float(np.percentile(rp, 75)), max=float(rp.max()),
                                        ln_mean=float(np.log(rp).mean()), ln_sd=float(np.log(rp).std(ddof=1)), samples=[float(x) for x in rp], times_colmap_to_true=COLMAP_TO_TRUE,
                                        vms_over_true_median=float(np.median(rp) * COLMAP_TO_TRUE), vms_over_true_range=[float(rp.min() * COLMAP_TO_TRUE), float(rp.max() * COLMAP_TO_TRUE)])
    # segments, gaps, turn density from the two segment lists
    L, Dur, G, V, NT, ang_all = [], [], [], [], [], []
    per_video = {}
    for name, f in vms.items():
        doc = json.loads(Path(f).read_text())
        us = [s for s in doc["segments"] if s["usable"]]
        per_video[name] = dict(n=len(us), turns=sum(len(s["turns"]) for s in us), total_nominal_km=sum(s["length_nominal_m"] for s in us) / 1000)
        for a, b in zip(us, us[1:]):
            G.append(b["t0"] - a["t1"])
        for s in us:
            L.append(s["length_nominal_m"]); Dur.append(s["duration_s"]); NT.append(len(s["turns"]))
            V.append(s["length_nominal_m"] / s["duration_s"]); ang_all += [abs(t["angle_deg"]) for t in s["turns"]]
    pc = lambda x: [float(v) for v in np.percentile(x, [0, 10, 25, 50, 75, 90, 100])]
    out["segments"] = dict(n=len(L), length_m_pct_0_10_25_50_75_90_100=pc(L), duration_s_pct=pc(Dur), speed_mps_pct=pc(V), turns_per_segment_hist=np.bincount(NT).tolist(), per_video=per_video,
                           samples=dict(length=[float(x) for x in L], duration=[float(x) for x in Dur]))
    out["gaps"] = dict(n=len(G), seconds_pct_0_10_25_50_75_90_100=pc(G), samples=[float(x) for x in G],
                       note="time between a usable segment's end and the next usable segment's start (includes too-short sections)")
    out["vms_turn_abs_angle_samples"] = [float(x) for x in ang_all]
    out["vms_turns_per_nominal_km"] = float(len(ang_all) / (sum(L) / 1000))
    return out



# ----------------------------------------------------------------------------------------------------------------------
# 2. generator: a stretch of a true track -> a vms-like turn sequence


@dataclass(frozen=True)
class SimConfig:
    name: str
    p_miss_small: float  # |A| < 45
    p_miss_large: float
    extra_per_km: float
    angle_jitter_ln: float  # extra ln-normal angle noise on top of the bootstrapped measured ratios
    p_flip: float
    rho_jitter_ln: float  # extra per-segment ln-normal scale noise
    position_jitter_s: float = 1.0


def sim_configs(em: dict) -> dict[str, SimConfig]:
    m = {b["bin"][0]: b["mean"] for b in em["miss"]["by_bin"]}
    return {
        "measured": SimConfig("measured", m[25], em["miss"]["ge45"]["mean"], em["extra"]["per_km"], 0.0, P_FLIP_ASSUMED, 0.0),
        "stress": SimConfig("stress", 0.85, 0.20, 2.5, 0.20, 0.05, 0.15),
    }


class Sim:
    def __init__(self, em: dict, cfg: SimConfig):
        self.cfg = cfg
        self.ratio = np.array(em["angle_ratio_samples"])
        self.rho = np.array(em["scale_vms_over_colmap"]["samples"]) * COLMAP_TO_TRUE
        self.seg_len = np.array(em["segments"]["samples"]["length"])
        self.seg_dur = np.array(em["segments"]["samples"]["duration"])
        self.gaps = np.array(em["gaps"]["samples"])
        self.ang = np.array(em["vms_turn_abs_angle_samples"])

    def query(self, path: TurnPath, x0: float, length_m: float, rng: np.random.Generator, qid: str = "") -> tuple[TurnQuery, dict]:
        cfg = self.cfg
        end = min(x0 + length_m, path.length_m)
        cen, ang, ss, se = path.center, np.asarray(path.angle_deg), np.asarray(path.s_start), np.asarray(path.s_end)
        pos = x0
        segs, true_turns, n_missed, n_flip, n_extra = [], 0, 0, 0, 0
        used = []
        while pos < end - 20.0:
            k = int(rng.integers(len(self.seg_len)))
            nom, dur = float(self.seg_len[k]), float(self.seg_dur[k])
            rho = float(np.clip(self.rho[int(rng.integers(len(self.rho)))] * math.exp(rng.normal(0, 0.10 + cfg.rho_jitter_ln)), 0.3, 2.0))
            tl = nom / rho
            if pos + tl > end:
                tl = end - pos
                dur *= tl * rho / nom
                nom = tl * rho
                if nom < 17.0:
                    break
            x1 = pos + tl
            turns = []
            sel = np.flatnonzero((cen >= pos) & (cen < x1))
            for t in sel:
                a_true = float(ang[t])
                full = ss[t] >= pos and se[t] <= x1
                clipped = False
                if not full:
                    f = (min(se[t], x1) - max(ss[t], pos)) / max(se[t] - ss[t], 1e-9)
                    a_true *= f
                    clipped = True
                    if abs(a_true) < 25.0:
                        continue
                true_turns += 1
                pm = cfg.p_miss_small if abs(ang[t]) < 45.0 else cfg.p_miss_large
                if rng.random() < pm:
                    n_missed += 1
                    continue
                r = float(self.ratio[int(rng.integers(len(self.ratio)))]) * math.exp(rng.normal(0, 0.05 + cfg.angle_jitter_ln))
                a = math.copysign(max(abs(a_true) * r, 25.0), a_true)
                if rng.random() < cfg.p_flip:
                    a = -a
                    n_flip += 1
                c = (cen[t] - pos) * rho + rng.normal(0, cfg.position_jitter_s * nom / dur)
                c = float(np.clip(c, 0.0, nom))
                w = max((se[t] - ss[t]) * rho, 10.0)
                turns.append(QTurn(a, c - 0.5 * w, c + 0.5 * w, clipped))
            for _ in range(int(rng.poisson(cfg.extra_per_km * tl / 1000.0))):
                a = float(self.ang[int(rng.integers(len(self.ang)))]) * (1 if rng.random() < 0.5 else -1)
                c = float(rng.uniform(0, nom))
                turns.append(QTurn(a, c - 15.0, c + 15.0, False))
                n_extra += 1
            turns.sort(key=lambda t: t.center)
            gap = float(self.gaps[int(rng.integers(len(self.gaps)))])
            segs.append(QSegment(nom, tuple(turns), dur, gap))
            used.append((pos, x1))
            pos = x1 + gap * (nom / dur) / rho
        if not segs:
            raise ValueError("empty query")
        segs[-1] = QSegment(segs[-1].length_m, segs[-1].turns, segs[-1].duration_s, None)
        q = TurnQuery(tuple(segs), qid)
        info = dict(t0=x0, t1=used[-1][1], n_segments=len(segs), n_true_turns=true_turns, n_missed=n_missed, n_flip=n_flip, n_extra=n_extra,
                    n_obs=q.n_turns, turning_obs=float(sum(abs(t.angle_deg) for s in segs for t in s.turns)),
                    turning_true=float(np.abs(ang[sel_all(cen, x0, used[-1][1])]).sum()), nominal_m=q.length_m)
        return q, info


def sel_all(cen, a, b):
    return np.flatnonzero((cen >= a) & (cen < b))


# ----------------------------------------------------------------------------------------------------------------------
# 3. library (stand-in tracks and decoys)


def load_paths(standin: bool = True):
    from .tracks import available_tracks

    tracks = available_tracks(standin=standin)
    return tracks, [TurnPath.from_xy(t.name, t.points) for t in tracks]


def block_path(paths: list[TurnPath], length_m: float, rng: np.random.Generator, pid: str, block_m: float = 1500.0) -> TurnPath:
    """Random blocks of the true paths (random reversal and mirroring per block), glued by turn lists. Keeps local structure
    (hairpin chains, spacing), destroys long-range structure; contains no unflipped forward block of the source, only mirrored or
    reversed ones or unflipped ones from another place (a decoy for everything, a duplicate of nothing but by chance)."""
    A, S0, S1 = [], [], []
    off = 0.0
    while off < length_m:
        p = paths[int(rng.integers(len(paths)))]
        if p.length_m < block_m * 2:
            continue
        a = float(rng.uniform(0, p.length_m - block_m))
        b = a + block_m
        cen = p.center
        sel = np.flatnonzero((cen >= a) & (cen < b))
        ang, s0, s1 = np.asarray(p.angle_deg)[sel], np.asarray(p.s_start)[sel] - a, np.asarray(p.s_end)[sel] - a
        mode = int(rng.integers(3))  # 0 mirror, 1 reverse, 2 mirror + reverse (never the plain forward block)
        if mode in (1, 2):
            s0, s1 = block_m - s1, block_m - s0
            ang = -ang
        if mode in (0, 2):
            ang = -ang
        A.append(ang); S0.append(s0 + off); S1.append(s1 + off)
        off += block_m
    return TurnPath.from_turns(pid, np.concatenate(A), np.concatenate(S0), np.concatenate(S1), off)


def library_for(paths: list[TurnPath], mult: int, seed: int = 7) -> list[TurnPath]:
    """mult 1: the paths; 2: + each reversed; 4: + each mirrored and each mirrored-reversed; mult > 4: + (mult - 4) block-shuffled copies."""
    out = list(paths)
    if mult >= 2:
        out += [p.reversed(p.id + "~rev") for p in paths]
    if mult >= 4:
        out += [p.mirrored(p.id + "~mir") for p in paths] + [p.reversed().mirrored(p.id + "~mirrev") for p in paths]
    if mult > 4:
        rng = np.random.default_rng(seed)
        for k in range(mult - 4):
            out += [block_path(paths, p.length_m, rng, f"{p.id}~blk{k}") for p in paths]
    return out



# ----------------------------------------------------------------------------------------------------------------------
# 4. evaluation


LENGTHS = (1000, 2000, 5000, 10000)
RANK_CAP = 51  # truth not among the first 50 distinct locations -> rank 51 (censored)
CORRECT_OVERLAP = 0.5  # a result window is correct if it is on the true path (not a reversed / mirrored decoy) and covers >= 50 % of the true stretch
_G: dict = {}


def _truth_hit(m, truth) -> bool:
    name, t0, t1 = truth
    if m.path_id != name:
        return False
    return max(0.0, min(m.end_m, t1) - max(m.start_m, t0)) / max(t1 - t0, 1e-9) >= CORRECT_OVERLAP


def _work(task):
    k, query, truth = task
    r = search(query, _G["lib"], _G["params"], ConfidenceThresholds(0.0, -1e9), top_k=1, n_ranked=RANK_CAP - 1)
    rank = RANK_CAP
    if truth is not None:
        for m in r.matches:
            if _truth_hit(m, truth):
                rank = m.rank
                break
    b = r.matches[0] if r.matches else None
    s2 = r.matches[1] if len(r.matches) > 1 else None
    return dict(k=k, rank=rank, cost=None if b is None else b.cost, evidence=0.0 if b is None else b.evidence,
                gap_nats=(s2.cost - b.cost) if (b and s2) else (float("inf") if b else 0.0),
                gap_ratio=(b.evidence / s2.evidence) if (b and s2 and s2.evidence > 0) else None,
                second_evidence=None if s2 is None else s2.evidence,
                best_path=None if b is None else b.path_id, best_start=None if b is None else b.start_m,
                comp=None if b is None else {k2: v for k2, v in b.components.items()}, seconds=r.seconds, n_obs=r.n_query_turns)


def run_queries(tasks, lib: TurnLibrary, params: TurnMatchParams, workers: int = 8) -> list[dict]:
    import multiprocessing as mp

    _G["lib"], _G["params"] = lib, params
    if workers <= 1 or len(tasks) < 4:
        return [_work(t) for t in tasks]
    with mp.get_context("fork").Pool(workers) as pool:
        return pool.map(_work, tasks, chunksize=max(1, len(tasks) // (workers * 4)))


def make_queries(paths, tracks, sim: Sim, n_per: int, seed: int):
    rng = np.random.default_rng(seed)
    out = []
    for L in LENGTHS:
        for p, tr in zip(paths, tracks):
            for _ in range(n_per):
                x0 = float(rng.uniform(0, p.length_m - L))
                q, info = sim.query(p, x0, float(L), rng, qid=f"{p.id}:{L}:{x0:.0f}")
                out.append(dict(track=p.id, role=tr.role, L=L, query=q, info=info, truth=(p.id, info["t0"], info["t1"])))
    return out


def bin_label(n: int) -> str:
    return "0-1" if n <= 1 else "2-3" if n <= 3 else "4-7" if n <= 7 else "8-15" if n <= 15 else "16+"


def summarize(recs: list[dict], key: str = "L") -> list[dict]:
    rows = []
    vals = sorted({r[key] for r in recs}, key=lambda v: (isinstance(v, str), v))
    for v in vals + ["all"]:
        sel = [r for r in recs if v == "all" or r[key] == v]
        rk = np.array([r["rank"] for r in sel])
        rows.append(dict(group=v, n=len(sel), top1=float((rk == 1).mean()), top1_lo=wilson(int((rk == 1).sum()), len(sel))[0], top1_hi=wilson(int((rk == 1).sum()), len(sel))[1],
                         top5=float((rk <= 5).mean()), median_rank=float(np.median(rk)),
                         not_in_50=float((rk >= RANK_CAP).mean()), median_obs_turns=float(np.median([r["n_obs"] for r in sel]))))
    return rows


def confident(r: dict, gap: float, ev: float) -> bool:
    return r["evidence"] is not None and r["evidence"] >= ev and r["gap_nats"] >= gap


def tune_thresholds(normal: list[dict], neg: list[dict]) -> tuple[float, float, dict]:
    """Dev only. Among (min_gap_nats, min_evidence) on a grid with NO confident wrong result on the dev data (normal queries whose top-1 is
    wrong + every confident negative: mirrored queries and queries of a track that is not in the library), take the one with the most
    confident correct results; ties -> the largest thresholds (most conservative)."""
    best = None
    for gap in np.arange(0, 40.1, 1.0):
        for ev in np.arange(0, 60.1, 2.0):  # evidence >= 0: the alignment must beat the null
            wrong = sum(confident(r, gap, ev) and r["rank"] != 1 for r in normal) + sum(confident(r, gap, ev) for r in neg)
            right = sum(confident(r, gap, ev) and r["rank"] == 1 for r in normal)
            if wrong == 0:
                key = (right, gap + ev)
                if best is None or key > best[0]:
                    best = (key, float(gap), float(ev), right)
    if best is None:
        return 40.0, 80.0, dict(note="no grid point without a dev error; most conservative corner used")
    return best[1], best[2], dict(dev_confident_correct=best[3], dev_n_normal=len(normal), dev_n_negatives=len(neg))


def decision_table(recs: list[dict], neg_mirror: list[dict], neg_foreign: list[dict], gap: float, ev: float) -> dict:
    n = len(recs)
    cc = sum(confident(r, gap, ev) and r["rank"] == 1 for r in recs)
    cw = sum(confident(r, gap, ev) and r["rank"] != 1 for r in recs)
    return dict(n=n, confident_correct=cc, confident_wrong=cw, confident_correct_rate=cc / max(n, 1), confident_wrong_rate=cw / max(n, 1),
                precision=cc / max(cc + cw, 1), n_mirror=len(neg_mirror), mirror_confident=sum(confident(r, gap, ev) for r in neg_mirror),
                n_foreign=len(neg_foreign), foreign_confident=sum(confident(r, gap, ev) for r in neg_foreign))


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def md_table(rows: list[dict], cols: list[tuple[str, str, str]]) -> str:
    h = "| " + " | ".join(c[1] for c in cols) + " |\n|" + "---|" * len(cols) + "\n"
    for r in rows:
        h += "| " + " | ".join((c[2] % r[c[0]]) if r.get(c[0]) is not None else "-" for c in cols) + " |\n"
    return h


# ----------------------------------------------------------------------------------------------------------------------
# 5. stages


def stage_bench(out: Path, em: dict, n_per: int, seed: int, workers: int, params: TurnMatchParams, mults=(1, 2, 4, 8, 16)) -> dict:
    tracks, paths = load_paths()
    cfg = sim_configs(em)
    res: dict = {"params": params.__dict__, "n_per_track_length": n_per, "seed": seed, "tracks": {p.id: dict(turns=p.n_turns, km=p.length_m / 1000, role=t.role) for p, t in zip(paths, tracks)}}
    lib1 = TurnLibrary(library_for(paths, 1))
    t_start = time.perf_counter()
    out_md = []
    sets = {}
    for name in ("measured", "stress"):
        sim = Sim(em, cfg[name])
        qs = make_queries(paths, tracks, sim, n_per, seed)
        tasks = [(k, d["query"], d["truth"]) for k, d in enumerate(qs)]
        recs = run_queries(tasks, lib1, params, workers)
        for d, r in zip(qs, recs):
            r.update(track=d["track"], role=d["role"], L=d["L"], **{k: d["info"][k] for k in ("n_true_turns", "n_obs", "turning_obs", "turning_true", "n_extra", "n_missed", "n_flip", "n_segments", "nominal_m")})
        # negatives: mirrored query vs the full library (source present, its mirror not); foreign: query vs the library without its own track
        mir = run_queries([(k, d["query"].mirrored(), None) for k, d in enumerate(qs)], lib1, params, workers)
        foreign = []
        for p in paths:
            idx = [k for k, d in enumerate(qs) if d["track"] == p.id]
            libx = TurnLibrary([q for q in library_for(paths, 1) if q.id != p.id])
            foreign += run_queries([(k, qs[k]["query"], None) for k in idx], libx, params, workers)
        for r_list in (mir, foreign):
            for r in r_list:
                d = qs[r["k"]]
                r.update(track=d["track"], role=d["role"], L=d["L"], n_obs=d["info"]["n_obs"])
        sets[name] = dict(qs=qs, recs=recs, mir=mir, foreign=foreign)
    res["seconds_main"] = time.perf_counter() - t_start
    # thresholds from dev, measured error model
    m = sets["measured"]
    dev = lambda xs: [x for x in xs if x["role"] == "dev"]
    test = lambda xs: [x for x in xs if x["role"] == "test"]
    gap, ev, tinfo = tune_thresholds(dev(m["recs"]), dev(m["mir"]) + dev(m["foreign"]))
    res["thresholds"] = dict(min_gap_nats=gap, min_evidence=ev, tuning=tinfo)
    res["by_level"] = {}
    for name in ("measured", "stress"):
        S = sets[name]
        for lab, f in (("dev", dev), ("test", test), ("all", lambda x: x)):
            R = f(S["recs"])
            res["by_level"][f"{name}/{lab}"] = dict(by_length=summarize(R, "L"), decision=decision_table(R, f(S["mir"]), f(S["foreign"]), gap, ev))
        # by observed turns and total turning (all tracks)
        for r in S["recs"]:
            r["obs_bin"] = bin_label(r["n_obs"])
            r["turning_bin"] = "<100" if r["turning_obs"] < 100 else "100-300" if r["turning_obs"] < 300 else "300-700" if r["turning_obs"] < 700 else ">=700"
        res["by_level"][f"{name}/by_obs_turns"] = summarize(S["recs"], "obs_bin")
        res["by_level"][f"{name}/by_turning_deg"] = summarize(S["recs"], "turning_bin")
        res["by_level"][f"{name}/by_track"] = summarize(S["recs"], "track")
        for lab in ("mir", "foreign"):
            res["by_level"][f"{name}/{lab}_by_length"] = [dict(L=L, n=len([r for r in S[lab] if r["L"] == L]),
                                                               confident=sum(confident(r, gap, ev) for r in S[lab] if r["L"] == L),
                                                               top1_is_source=None) for L in LENGTHS]
    # mirrored control detail: where does the mirrored query's best hit land
    mir = m["mir"]
    res["mirror_control"] = dict(n=len(mir), confident=sum(confident(r, gap, ev) for r in mir),
                                 best_on_source_window=sum(1 for r, d in zip(mir, m["qs"]) if r["best_path"] == d["truth"][0] and abs((r["best_start"] or -1e9) - d["truth"][1]) < 0.5 * (d["truth"][2] - d["truth"][1])),
                                 median_evidence=float(np.median([r["evidence"] for r in mir])), median_evidence_normal=float(np.median([r["evidence"] for r in m["recs"]])),
                                 mean_n_flip_pairs=float(np.mean([(r["comp"] or {}).get("n_flip", 0) for r in mir])))
    # failure list (measured, all): wrong top-1 with observed turns >= 4
    res["failures_measured"] = [dict(track=r["track"], L=r["L"], n_obs=r["n_obs"], n_true=r["n_true_turns"], n_extra=r["n_extra"], n_flip=r["n_flip"], rank=r["rank"], evidence=r["evidence"], gap=r["gap_nats"])
                                for r in m["recs"] if r["rank"] != 1 and r["n_obs"] >= 4][:60]
    res["_records_measured"] = [{k: v for k, v in r.items() if k != "comp"} for r in m["recs"]]
    # growth: normal queries (measured), fixed thresholds
    res["growth"] = []
    qs = m["qs"]
    for mult in mults:
        libm = TurnLibrary(library_for(paths, mult))
        t0 = time.perf_counter()
        recs = run_queries([(k, d["query"], d["truth"]) for k, d in enumerate(qs)], libm, params, workers)
        wall = time.perf_counter() - t0
        for r, d in zip(recs, qs):
            r.update(track=d["track"], role=d["role"], L=d["L"], n_obs=d["info"]["n_obs"])
        rows = {}
        for lab, R in (("dev", dev(recs)), ("test", test(recs)), ("all", recs)):
            su = summarize(R, "L")
            rows[lab] = dict(summary=su, decision=decision_table(R, [], [], gap, ev))
        ans = [r for r in recs if r["n_obs"] >= 4]
        res["growth"].append(dict(mult=mult, n_paths=len(libm), n_path_turns=libm.n_turns, path_km=float(libm.path_length.sum() / 1000), wall_s=wall,
                                  mean_search_s=float(np.mean([r["seconds"] for r in recs])), rows=rows,
                                  answerable_ge4=dict(n=len(ans), top1=float(np.mean([r["rank"] == 1 for r in ans])), top5=float(np.mean([r["rank"] <= 5 for r in ans])), median_rank=float(np.median([r["rank"] for r in ans])),
                                                      **{k: v for k, v in decision_table(ans, [], [], gap, ev).items() if k.startswith("confident")})))
    # threshold sensitivity (measured, test and all), including the negatives
    res["threshold_sensitivity"] = []
    for g2, e2 in ((4, 0), (6, 0), (8, 0), (10, 0), (14, 0), (20, 0), (10, 4), (10, 8), (14, 8)):
        row = dict(min_gap_nats=g2, min_evidence=e2)
        for lab, f in (("dev", dev), ("test", test)):
            row[lab] = decision_table(f(m["recs"]), f(m["mir"]), f(m["foreign"]), g2, e2)
        res["threshold_sensitivity"].append(row)
    # ablations on the same measured queries, library 1x
    res["ablation"] = []
    variants = {"default": params,
                "no spacing check (rho prior 1e-3..1e3)": TurnMatchParams(**{**params.__dict__, "rho_lo": 1e-3, "rho_hi": 1e3}),
                "rho prior 0.55..1.0 (tight, wrong-ish)": TurnMatchParams(**{**params.__dict__, "rho_lo": 0.55, "rho_hi": 1.0}),
                "rho prior 0.25..2.5 (wide)": TurnMatchParams(**{**params.__dict__, "rho_lo": 0.25, "rho_hi": 2.5}),
                "Gaussian rho prior (sigma_ln 0.4)": TurnMatchParams(**{**params.__dict__, "rho_sigma_ln": 0.4}),
                "angle sigma_rel 0.15 (tight)": TurnMatchParams(**{**params.__dict__, "angle_sigma_rel": 0.15}),
                "angle sigma_rel 0.6 (loose)": TurnMatchParams(**{**params.__dict__, "angle_sigma_rel": 0.6}),
                "p_miss 0.3 / 0.03 (optimistic)": TurnMatchParams(**{**params.__dict__, "p_miss_small": 0.3, "p_miss_large": 0.03}),
                "flip allowed (flip_cost 2)": TurnMatchParams(**{**params.__dict__, "flip_cost": 2.0})}
    for vn, vp in variants.items():
        r_ = run_queries([(k, d["query"], d["truth"]) for k, d in enumerate(m["qs"])], lib1, vp, workers)
        for r, d in zip(r_, m["qs"]):
            r.update(L=d["L"], role=d["role"])
        su = summarize(r_, "L")
        mi_ = run_queries([(k, d["query"].mirrored(), None) for k, d in enumerate(m["qs"])], lib1, vp, workers)
        res["ablation"].append(dict(variant=vn, top1=[x["top1"] for x in su], top5=[x["top5"] for x in su], groups=[x["group"] for x in su],
                                    median_evidence_correct=float(np.median([r["evidence"] for r in r_ if r["rank"] == 1])) if any(r["rank"] == 1 for r in r_) else None,
                                    mirror_best_on_source_window=sum(1 for r, d in zip(mi_, m["qs"]) if r["best_path"] == d["truth"][0] and abs((r["best_start"] or -1e9) - d["truth"][1]) < 0.5 * (d["truth"][2] - d["truth"][1]))))
    # evidence / gap of the best hit by outcome and observed-turn bin (measured level)
    eo = {}
    for lab, R in (("correct top-1", [r for r in m["recs"] if r["rank"] == 1]), ("wrong top-1", [r for r in m["recs"] if r["rank"] != 1]),
                   ("foreign query", m["foreign"]), ("mirrored query", m["mir"])):
        for r in R:
            r["obs_bin"] = bin_label(r["n_obs"])
        for b in ("0-1", "2-3", "4-7", "8-15", "16+"):
            xs = [r for r in R if r["obs_bin"] == b]
            if xs:
                ev_ = np.array([r["evidence"] for r in xs]); gp = np.array([min(r["gap_nats"], 99.0) for r in xs])
                eo[f"{lab}|{b}"] = dict(outcome=lab, bin=b, n=len(xs), evidence_p10=float(np.percentile(ev_, 10)), evidence_p50=float(np.median(ev_)), evidence_p90=float(np.percentile(ev_, 90)),
                                        gap_p10=float(np.percentile(gp, 10)), gap_p50=float(np.median(gp)), gap_p90=float(np.percentile(gp, 90)))
    res["evidence_by_outcome"] = list(eo.values())
    # leave-one-track-out thresholds (post hoc, descriptive): tune on the other two tracks, evaluate on the held-out one; and the reverse split (tune on test, evaluate on dev)
    res["loto"] = []
    names = [p.id for p in paths]
    for held in names:
        tr_ = lambda xs: [x for x in xs if x["track"] != held]
        te_ = lambda xs: [x for x in xs if x["track"] == held]
        g3, e3, _ = tune_thresholds(tr_(m["recs"]), tr_(m["mir"]) + tr_(m["foreign"]))
        res["loto"].append(dict(held_out=held, min_gap_nats=g3, min_evidence=e3, decision=decision_table(te_(m["recs"]), te_(m["mir"]), te_(m["foreign"]), g3, e3)))
    g4, e4, _ = tune_thresholds(test(m["recs"]), test(m["mir"]) + test(m["foreign"]))
    res["reverse_split"] = dict(min_gap_nats=g4, min_evidence=e4, evaluated_on_dev=decision_table(dev(m["recs"]), dev(m["mir"]), dev(m["foreign"]), g4, e4))
    # every confident error at the dev thresholds (normal queries wrong, mirrored, foreign)
    errs = []
    for kind, R in (("normal-wrong", [r for r in m["recs"] if r["rank"] != 1]), ("mirrored", m["mir"]), ("foreign", m["foreign"])):
        for r in R:
            if confident(r, gap, ev):
                d = m["qs"][r["k"]]
                errs.append(dict(kind=kind, track=r["track"], role=r["role"], L=r["L"], n_obs=r["n_obs"], n_true_turns=d["info"]["n_true_turns"], n_extra_sim=d["info"]["n_extra"], evidence=r["evidence"], gap_nats=r["gap_nats"],
                                 best_path=r["best_path"], rank=r["rank"], n_match=(r["comp"] or {}).get("n_match"), n_extra_aligned=(r["comp"] or {}).get("n_extra"), n_miss_aligned=(r["comp"] or {}).get("n_miss")))
    res["confident_errors"] = errs
    res["_records_negatives"] = {lab: [{k2: v for k2, v in r.items() if k2 != "comp"} for r in m[lab]] for lab in ("mir", "foreign")}
    res["_sets_evidence"] = dict(correct=[r["evidence"] for r in m["recs"] if r["rank"] == 1], wrong=[r["evidence"] for r in m["recs"] if r["rank"] != 1])
    return res, sets, paths


def chunk_queries(doc: dict, target_m: float) -> list[tuple[str, TurnQuery]]:
    """Consecutive blocks of usable segments with at least `target_m` nominal metres each (the last short remainder is dropped)."""
    use = [s for s in doc["segments"] if s.get("usable")]
    out, a, acc = [], 0, 0.0
    for k, s in enumerate(use):
        acc += s["length_nominal_m"]
        if acc >= target_m:
            out.append((f"seg{a}-{k}", TurnQuery.from_vms_segments(doc, seg_range=(a, k + 1))))
            a, acc = k + 1, 0.0
    return out


def stage_real(out: Path, em: dict, params: TurnMatchParams, gap: float, ev: float, paths, mults=(1, 4)) -> dict:
    res = {}
    for mult in mults:
        lib = TurnLibrary(library_for(paths, mult))
        rows = []
        for vid, f in VMS_DIRS.items():
            doc = json.loads(Path(f).read_text())
            for target in (1000, 2000, 5000, 10000, 1e9):
                for lab, q in chunk_queries(doc, target) if target < 1e9 else [("all", TurnQuery.from_vms_segments(doc))]:
                    r = search(q, lib, params, ConfidenceThresholds(gap, ev), top_k=1)
                    b = r.matches[0]
                    rows.append(dict(video=vid, target_m=target if target < 1e9 else None, chunk=lab, nominal_m=q.length_m, n_segments=len(q.segments), n_turns=q.n_turns,
                                     best_path=b.path_id, evidence=b.evidence, evidence_per_turn=b.evidence / max(q.n_turns, 1), gap_nats=r.ambiguity["gap_nats"], status=r.status, seconds=r.seconds,
                                     n_match=b.components.get("n_match"), n_extra=b.components.get("n_extra")))
        res[f"mult{mult}"] = rows
    return res


def stage_runtime(em: dict, params: TurnMatchParams, paths, n_paths=20000, turns_per_path=60, seed=3) -> dict:
    import resource

    rng = np.random.default_rng(seed)
    allA = np.concatenate([np.asarray(p.angle_deg) for p in paths])
    # synthetic OSM-like library: turn spacing from the pooled gaps of the stand-in tracks
    gaps = np.concatenate([np.diff(p.center) for p in paths if p.n_turns > 2])
    plist = []
    for k in range(n_paths):
        c = np.cumsum(rng.choice(gaps, turns_per_path))
        plist.append(TurnPath.from_turns(f"s{k}", rng.choice(allA, turns_per_path), c - 20, c + 20, float(c[-1] + 100)))
    t0 = time.perf_counter()
    lib = TurnLibrary(plist)
    t_build = time.perf_counter() - t0
    sim = Sim(em, sim_configs(em)["measured"])
    tr, pp = load_paths()
    res = dict(n_paths=n_paths, turns_per_path=turns_per_path, n_path_turns=lib.n_turns, mean_path_km=float(np.mean([p.length_m for p in plist]) / 1000), library_build_s=t_build, rows=[])
    for L, name in ((2000, "catalunya_standin"), (5000, "catalunya_standin"), (10000, "catalunya_standin")):
        p = [x for x in pp if x.id == name][0]
        q, info = sim.query(p, 3000.0, float(L), rng)
        t0 = time.perf_counter()
        r = search(q, lib, params, top_k=1)
        t1 = time.perf_counter() - t0
        t0 = time.perf_counter()
        r2 = search(q, lib, params, top_k=1)  # second call: lag arrays are cached
        res["rows"].append(dict(length_m=L, n_query_turns=q.n_turns, first_call_s=t1, second_call_s=time.perf_counter() - t0, status=r2.status))
    res["max_rss_mb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6 if sys.platform == "darwin" else resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e3
    return res


def write_tables(out: Path) -> None:
    em = json.loads((out / "error_model.json").read_text())
    L = []
    pct = lambda x: "%.0f %%" % (100 * x)
    if (out / "bench_results.json").exists():
        r = json.loads((out / "bench_results.json").read_text())
        th = r["thresholds"]
        L.append(f"## Thresholds (tuned on dev only, measured model, library 1x): min_gap_nats {th['min_gap_nats']}, min_evidence {th['min_evidence']}; {r['n_per_track_length']} queries per track and length, seed {r['seed']}\n")
        for lvl in ("measured", "stress"):
            for lab in ("all", "dev", "test"):
                b = r["by_level"][f"{lvl}/{lab}"]
                L.append(f"### Retrieval, {lvl} error level, {lab} queries, library 1x\n")
                L.append("| length | n | top-1 [95 % Wilson] | top-5 | median rank | not in top 50 | median observed turns |\n|---|---|---|---|---|---|---|")
                for x in b["by_length"]:
                    g = "all" if x["group"] == "all" else f"{x['group'] / 1000:g} km"
                    L.append(f"| {g} | {x['n']} | {pct(x['top1'])} [{pct(x['top1_lo'])}, {pct(x['top1_hi'])}] | {pct(x['top5'])} | {x['median_rank']:g} | {pct(x['not_in_50'])} | {x['median_obs_turns']:g} |")
                d = b["decision"]
                L.append(f"\nDecision at the dev thresholds: confident-correct {d['confident_correct']}/{d['n']} ({pct(d['confident_correct_rate'])}), confident-wrong {d['confident_wrong']}/{d['n']}; "
                         f"mirrored-query control confident {d['mirror_confident']}/{d['n_mirror']}; foreign-query control (source track removed from the library) confident {d['foreign_confident']}/{d['n_foreign']}.\n")
        for lvl in ("measured", "stress"):
            for key, title in (("by_obs_turns", "observed turns in the query"), ("by_turning_deg", "total observed turning (sum of |angle|, deg)"), ("by_track", "track")):
                L.append(f"### {lvl}, by {title}, library 1x\n\n| group | n | top-1 [95 % Wilson] | top-5 | median rank | not in top 50 |\n|---|---|---|---|---|---|")
                rows = r["by_level"][f"{lvl}/{key}"]
                order = ["0-1", "2-3", "4-7", "8-15", "16+", "<100", "100-300", "300-700", ">=700"]
                rows = sorted(rows, key=lambda x: (order.index(x["group"]) if x["group"] in order else 99, str(x["group"])))
                for x in rows:
                    L.append(f"| {x['group']} | {x['n']} | {pct(x['top1'])} [{pct(x['top1_lo'])}, {pct(x['top1_hi'])}] | {pct(x['top5'])} | {x['median_rank']:g} | {pct(x['not_in_50'])} |")
                L.append("")
        L.append("### Best-hit evidence and gap (nats) by outcome and observed turns (measured, library 1x)\n\n| outcome | observed turns | n | evidence p10 / p50 / p90 | gap p10 / p50 / p90 |\n|---|---|---|---|---|")
        for x in r["evidence_by_outcome"]:
            L.append(f"| {x['outcome']} | {x['bin']} | {x['n']} | {x['evidence_p10']:.1f} / {x['evidence_p50']:.1f} / {x['evidence_p90']:.1f} | {x['gap_p10']:.1f} / {x['gap_p50']:.1f} / {x['gap_p90']:.1f} |")
        L.append("")
        L.append("### Leave-one-track-out thresholds (post hoc; tuned on the other two tracks, evaluated on the held-out one) and the reverse split\n\n| held out | min gap | min evidence | n | confident-correct | confident-wrong | mirror confident | foreign confident |\n|---|---|---|---|---|---|---|---|")
        for x in r["loto"]:
            d = x["decision"]
            L.append(f"| {x['held_out']} | {x['min_gap_nats']:g} | {x['min_evidence']:g} | {d['n']} | {d['confident_correct']} | {d['confident_wrong']} | {d['mirror_confident']}/{d['n_mirror']} | {d['foreign_confident']}/{d['n_foreign']} |")
        rs = r["reverse_split"]; d = rs["evaluated_on_dev"]
        L.append(f"| reverse split: tuned on test (catalunya), evaluated on dev | {rs['min_gap_nats']:g} | {rs['min_evidence']:g} | {d['n']} | {d['confident_correct']} | {d['confident_wrong']} | {d['mirror_confident']}/{d['n_mirror']} | {d['foreign_confident']}/{d['n_foreign']} |\n")
        L.append("### Every confident error at the dev thresholds\n\n| kind | track | length | observed turns | true turns | simulated extras | evidence | gap | best path | rank of truth | matched / extra / miss in best alignment |\n|---|---|---|---|---|---|---|---|---|---|---|")
        for x in r["confident_errors"]:
            L.append(f"| {x['kind']} | {x['track']} | {x['L']} | {x['n_obs']} | {x['n_true_turns']} | {x['n_extra_sim']} | {x['evidence']:.1f} | {x['gap_nats']:.1f} | {x['best_path']} | {x['rank']} | {x['n_match']} / {x['n_extra_aligned']} / {x['n_miss_aligned']} |")
        L.append("")
        mc = r["mirror_control"]
        L.append(f"### Mirrored-query control (measured, 1x)\n\n{mc['confident']}/{mc['n']} confident; best hit on the source window in {mc['best_on_source_window']}/{mc['n']}; median evidence {mc['median_evidence']:.1f} (normal queries {mc['median_evidence_normal']:.1f}); mean flipped pairs in the best alignment {mc['mean_n_flip_pairs']:.3f}.\n")
        L.append("### Library growth (measured error level, fixed thresholds; decoys: 2x +reversed, 4x +mirrored +mirrored-reversed, 8x/16x + block-shuffled mirrored/reversed copies)\n")
        L.append("| library | paths | path turns | km | top-1 all | top-5 all | median rank | not in 50 | top-1 at 1/2/5/10 km | confident-correct | confident-wrong | answerable (>= 4 observed turns) top-1 / top-5 | mean search s |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for g in r["growth"]:
            a = g["rows"]["all"]["summary"]
            al = a[-1]
            dd = g["rows"]["all"]["decision"]
            an = g["answerable_ge4"]
            L.append(f"| {g['mult']}x | {g['n_paths']} | {g['n_path_turns']} | {g['path_km']:.0f} | {pct(al['top1'])} | {pct(al['top5'])} | {al['median_rank']:g} | {pct(al['not_in_50'])} | "
                     + " / ".join("%.0f" % (100 * x["top1"]) for x in a[:-1]) + f" | {dd['confident_correct']}/{dd['n']} | {dd['confident_wrong']} | {pct(an['top1'])} / {pct(an['top5'])} (n={an['n']}) | {g['mean_search_s']:.3f} |")
        L.append("\n### Ablations (measured, library 1x; top-1 at 1/2/5/10 km and all)\n\n| variant | 1 km | 2 km | 5 km | 10 km | all | mirrored query best on source window | median evidence of correct top-1 |\n|---|---|---|---|---|---|---|---|")
        for a in r["ablation"]:
            L.append(f"| {a['variant']} | " + " | ".join(pct(x) for x in a["top1"]) + f" | {a['mirror_best_on_source_window']}/480 | {a['median_evidence_correct']:.1f} |")
        L.append("\n### Threshold sensitivity (measured, library 1x; counts of confident results)\n\n| min gap | min evidence | dev correct | dev wrong | dev mirror | dev foreign | test correct | test wrong | test mirror | test foreign |\n|---|---|---|---|---|---|---|---|---|---|")
        for t in r["threshold_sensitivity"]:
            L.append(f"| {t['min_gap_nats']} | {t['min_evidence']} | " + " | ".join(str(t[l][k]) for l in ("dev", "test") for k in ("confident_correct", "confident_wrong", "mirror_confident", "foreign_confident")) + " |")
        L.append("")
    if (out / "real_results.json").exists():
        rr = json.loads((out / "real_results.json").read_text())
        for key, rows in rr.items():
            L.append(f"### Real vms queries against the stand-in library ({key})\n\n| video | chunk | nominal m | segments | turns | status | best evidence | evidence / turn | gap nats | best path | matched / extra |\n|---|---|---|---|---|---|---|---|---|---|---|")
            for x in rows:
                L.append(f"| {x['video']} | {x['chunk']} | {x['nominal_m']:.0f} | {x['n_segments']} | {x['n_turns']} | {x['status']} | {x['evidence']:.1f} | {x['evidence_per_turn']:.2f} | {x['gap_nats']:.1f} | {x['best_path']} | {x['n_match']} / {x['n_extra']} |")
            L.append("")
    if (out / "runtime_results.json").exists():
        t = json.loads((out / "runtime_results.json").read_text())
        L.append(f"### Runtime, synthetic library of {t['n_paths']} paths x {t['turns_per_path']} turns = {t['n_path_turns']} turns (mean path {t['mean_path_km']:.1f} km), build {t['library_build_s']:.2f} s, peak RSS {t['max_rss_mb']:.0f} MB\n\n| query | observed turns | first call s | second call s |\n|---|---|---|---|")
        for x in t["rows"]:
            L.append(f"| {x['length_m'] / 1000:g} km | {x['n_query_turns']} | {x['first_call_s']:.2f} | {x['second_call_s']:.2f} |")
        L.append("")
    (out / "tables.md").write_text("\n".join(L))


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "work/turnseq"))
    ap.add_argument("--stage", default="all")
    ap.add_argument("--n-per", type=int, default=100, help="queries per track and length")
    ap.add_argument("--seed", type=int, default=20261109)
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stages = set(a.stage.split(",")) if a.stage != "all" else {"errmodel", "bench", "real", "runtime"}
    em = measure_error_model()
    (out / "error_model.json").write_text(json.dumps(em, indent=1, default=float))
    print("error model written", flush=True)
    params = TurnMatchParams()
    res = {}
    if "bench" in stages or "real" in stages or "runtime" in stages:
        pass
    if "bench" in stages:
        res, sets, paths = stage_bench(out, em, a.n_per, a.seed, a.workers, params)
        (out / "bench_results.json").write_text(json.dumps(res, indent=1, default=float))
        print("bench done", res["thresholds"], flush=True)
        gap, ev = res["thresholds"]["min_gap_nats"], res["thresholds"]["min_evidence"]
    else:
        f = out / "bench_results.json"
        gap, ev = (json.loads(f.read_text())["thresholds"].values().__iter__().__next__(), None) if False else (None, None)
        if f.exists():
            t = json.loads(f.read_text())["thresholds"]
            gap, ev = t["min_gap_nats"], t["min_evidence"]
        tr, paths = load_paths()
    if "real" in stages:
        rr = stage_real(out, em, params, gap if gap is not None else 6.0, ev if ev is not None else 6.0, paths)
        (out / "real_results.json").write_text(json.dumps(rr, indent=1, default=float))
        print("real done", flush=True)
    if "runtime" in stages:
        rt = stage_runtime(em, params, paths)
        (out / "runtime_results.json").write_text(json.dumps(rt, indent=1, default=float))
        print("runtime", rt, flush=True)
    write_tables(out)


if __name__ == "__main__":
    main()
