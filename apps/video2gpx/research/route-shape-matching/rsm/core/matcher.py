# SPDX-License-Identifier: AGPL-3.0-or-later
"""Local geometry matcher: rank candidate polylines against a relative trajectory. No OSM, no GPX.

`match(trajectory, candidates, options) -> MatchResult`.

Frame and units: candidates are plain polylines in any local metric frame (x right, y forward,
metres). The trajectory is in its own arbitrary frame; the similarity found maps *trajectory*
coordinates to *candidate* coordinates: ``cand ~ scale * R(rotation) @ traj + translation``.
All distances are in candidate metres; ``*_rel`` scores are divided by the fitted trajectory
length (``scale * trajectory length``), so they are dimensionless and comparable across lengths.

Algorithm (per candidate, per direction):
1. The trajectory is resampled to ``n`` points equally spaced in arc length (``n`` = length /
   ``spacing_m``, clipped to [``n_min``, ``n_max``]).
2. Windows: a window starts at ``start`` metres along the candidate and has length
   ``trajectory length * s`` for a scale hypothesis ``s`` in the trajectory's ScalePrior
   ``[min, max]``. It is resampled to ``n`` points equally spaced in arc length, which gives the
   point correspondences.
3. Coarse grid: ``coarse_n_scales`` scales spread over the prior, window starts every
   ``coarse_start_frac`` of the window length (plus the last feasible start). Each window gets a
   least-squares similarity (`similarity.fit_similarity_batch`, no reflection, fitted scale
   clamped to the prior). The window with the smallest relative residual ``rms / (scale * length)`` wins.
4. Refinement of the ``refine_top`` best coarse windows, ``refine_rounds`` rounds each: around the window, ``refine_n_start`` starts spanning +-1
   coarse start step and ``refine_n_scale`` scales spanning +-1 coarse scale step; the next round
   spans +-1 grid spacing of the previous one. The winner stays in the set, so refinement never
   worsens the criterion.
5. At the final alignment all components are computed and kept separately (`metrics`): RMSE,
   discrete Frechet, Hausdorff, heading-signature distance, each also as ``*_rel``.

The alignment (window, scale) is always chosen by the relative residual, whatever the ranking
score is; the ranking score only orders the candidates afterwards. This keeps the search identical
for every ranking metric, so the benchmark can compare them on the same alignments.

Direction: the candidates are scored forward. The reversed candidate is evaluated only when
``allow_reverse`` (it then competes and the better alignment is kept, ``reversed=True``) or
``diagnose_reverse`` (computed and reported in ``reverse_scores`` but never used for the rank).

Ranking score (`MatchOptions.rank_by`, default `DEFAULT_RANK_BY`): one named component
(``rmse_rel``, ``frechet_rel``, ``hausdorff_rel``, ``heading``) or ``combo``, the
geometric mean ``sqrt(rmse_rel * heading)``; no weights. See FINDINGS for the evidence.

Distinctness: windows are mapped to the underlying path through ``origin_id`` and
``origin_offset_m`` (default: the candidate itself, offset 0), so overlapping library entries cut
from one road are recognised as the same place. Two matches are the *same place* if they share
``origin_id`` and their windows overlap by more than ``overlap_distinct`` (default 50 %) of the
shorter window. `MatchResult.distinct` keeps the best of each place (greedy, best first);
the ambiguity block works on it.

Status (`ambiguity.status`), from `StatusThresholds` (set on the benchmark's development split):
- ``no_match``: best score > ``max_score``;
- ``confident``: second-best distinct score >= ``gap_ratio`` * best score (or there is no second);
- ``ambiguous``: otherwise.
``eps = gap_ratio - 1`` is the relative tolerance for ``n_within_eps`` (other distinct candidates
with score <= best * (1 + eps)), so ``confident`` <=> ``n_within_eps == 0`` (unless no_match).
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field, replace
from typing import Any

import numpy as np

from . import metrics as M
from .geometry import as_points, cumulative_length, headings, interp_at
from .similarity import fit_similarity_batch
from .trajectory import RelativeTrajectory

SCORE_KEYS = ("rmse_rel", "frechet_rel", "hausdorff_rel", "heading")
DEFAULT_RANK_BY = "rmse_rel"  # PROVISIONAL: chosen by the dev rule on stand-in tracks only (FINDINGS); re-decide with the real benchmark


@dataclass(frozen=True)
class StatusThresholds:
    """`gap_ratio`: confident needs second/best >= gap_ratio. `max_score`: best above it is `no_match`."""

    gap_ratio: float
    max_score: float

    def __post_init__(self) -> None:
        if not (math.isfinite(self.gap_ratio) and self.gap_ratio >= 1.0):
            raise ValueError(f"gap_ratio must be finite and >= 1, got {self.gap_ratio}")
        if not (self.max_score > 0):
            raise ValueError(f"max_score must be > 0, got {self.max_score}")


# Per ranking score, to be filled from the development split of the REAL benchmark (`python -m rsm bench`, result
# `tuning.thresholds`; FINDINGS). Deliberately empty: the only run so far used stand-in tracks and an assumed error
# model, so shipping its numbers as defaults would pass them off as calibrated. `match` raises without thresholds.
DEFAULT_STATUS: dict[str, StatusThresholds] = {}


@dataclass(frozen=True)
class Candidate:
    """A candidate polyline in a local metric frame. `origin_id`/`origin_offset_m` say which underlying
    path it was cut from and where it starts on it (default: itself, 0), for the distinctness test."""

    id: str
    points: np.ndarray
    origin_id: str | None = None
    origin_offset_m: float = 0.0
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        p = as_points(self.points, f"candidate {self.id!r} points")
        if cumulative_length(p)[-1] <= 0:
            raise ValueError(f"candidate {self.id!r} has zero length")
        p = p.copy()
        p.setflags(write=False)
        object.__setattr__(self, "points", p)


@dataclass(frozen=True)
class MatchOptions:
    rank_by: str = DEFAULT_RANK_BY
    allow_reverse: bool = False
    diagnose_reverse: bool = False
    spacing_m: float = 10.0
    n_min: int = 40
    n_max: int = 200
    coarse_n_scales: int = 5
    coarse_start_frac: float = 0.10
    refine_n_start: int = 9
    refine_n_scale: int = 7
    refine_rounds: int = 3
    refine_top: int = 3  # coarse windows refined per candidate (the relative residual is flat along smooth shapes)
    prefilter_k: int | None = None  # tier 1: keep only the k best candidates by heading signature of the coarse windows
    # extra scoring functions (name, f(transformed_query, window) -> metres), e.g. DTW from the benchmark; they add
    # scores "<name>_m" and "<name>_rel" and may be used as rank_by="<name>_rel". rsm.core itself has none.
    extra_metrics: tuple = ()
    overlap_distinct: float = 0.5
    thresholds: StatusThresholds | None = None  # None: DEFAULT_STATUS[rank_by]

    def __post_init__(self) -> None:
        extra = tuple(f"{n}_rel" for n, _ in self.extra_metrics)
        if self.rank_by not in SCORE_KEYS + ("combo",) + extra:
            raise ValueError(f"rank_by must be one of {SCORE_KEYS}, got {self.rank_by!r}")
        if self.coarse_n_scales < 1 or self.refine_n_start < 1 or self.refine_n_scale < 1:
            raise ValueError("grid sizes must be >= 1")
        if not (0 < self.coarse_start_frac <= 1):
            raise ValueError("coarse_start_frac must be in (0, 1]")
        if not (0 <= self.overlap_distinct < 1):
            raise ValueError("overlap_distinct must be in [0, 1)")


@dataclass(frozen=True)
class CandidateMatch:
    """The best alignment of the trajectory on one candidate, with every component score."""

    candidate_id: str
    origin_id: str
    rank: int  # 1-based in `MatchResult.ranked` (not set (0) on matches obtained elsewhere)
    score: float  # the ranking score (`MatchResult.rank_by`)
    scores: dict[str, float | None]  # all components
    scale: float  # fitted, true candidate metres per trajectory metre (clamped to the prior)
    rotation_rad: float  # counter-clockwise
    translation: tuple[float, float]
    window_start_m: float  # along the candidate (forward direction of the candidate as given)
    window_length_m: float  # candidate metres covered by the matched window
    origin_start_m: float  # window_start_m + origin_offset_m: position on the underlying path
    origin_end_m: float
    reversed: bool
    scale_clamped: bool  # fitted scale was clamped to the prior bound
    scale_at_bound: bool  # clamped, or the window scale hypothesis sits on the prior bound
    forward_scores: dict[str, float | None]
    reverse_scores: dict[str, float | None] | None  # None unless the reverse was computed
    warnings: tuple[str, ...] = ()
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Ambiguity:
    status: str  # confident | ambiguous | no_match
    best_id: str | None
    second_id: str | None  # best *distinct* other candidate
    best_score: float | None
    second_score: float | None
    gap_abs: float | None  # second - best
    gap_ratio: float | None  # second / best (inf if best == 0 < second)
    eps: float  # relative tolerance used for n_within_eps (= gap_ratio threshold - 1)
    n_within_eps: int  # other distinct candidates with score <= best * (1 + eps)
    thresholds: StatusThresholds
    reason: str


@dataclass(frozen=True)
class MatchResult:
    rank_by: str
    ranked: tuple[CandidateMatch, ...]  # every evaluated candidate, best first
    distinct: tuple[CandidateMatch, ...]  # one per place (best first); ranks refer to this list's order via .rank
    ambiguity: Ambiguity
    options: MatchOptions
    grid: dict[str, Any]  # grid sizes and counts
    n_skipped: int  # candidates shorter than the shortest window (not evaluated)
    n_prefiltered_out: int
    timings_s: dict[str, float]
    warnings: tuple[str, ...] = ()

    def rerank(self, rank_by: str, thresholds: StatusThresholds | None = None) -> "MatchResult":
        """Same alignments, ordered by another component (the benchmark compares ranking scores this way).
        `thresholds=None` uses `DEFAULT_STATUS[rank_by]`."""
        return _finalize(list(self.ranked), replace(self.options, rank_by=rank_by, thresholds=thresholds),
                         self.grid, self.n_skipped, self.n_prefiltered_out, self.timings_s, self.warnings)


# -- internals ---------------------------------------------------------------------------------


def _score_value(scores: dict, key: str) -> float:
    if key == "combo":  # geometric mean of two dimensionless scores: equal weight in log space, no tunable constant
        return math.sqrt(scores["rmse_rel"] * scores["heading"])
    v = scores.get(key)
    return float("nan") if v is None else float(v)


def _overlap_fraction(a: CandidateMatch, b: CandidateMatch) -> float:
    if a.origin_id != b.origin_id:
        return 0.0
    ov = min(a.origin_end_m, b.origin_end_m) - max(a.origin_start_m, b.origin_start_m)
    shorter = min(a.origin_end_m - a.origin_start_m, b.origin_end_m - b.origin_start_m)
    return max(ov, 0.0) / shorter if shorter > 0 else 0.0


def _finalize(matches: list[CandidateMatch], options: MatchOptions, grid, n_skipped, n_pref, timings, warnings) -> MatchResult:
    key = options.rank_by
    th = options.thresholds
    if th is None:
        th = DEFAULT_STATUS.get(key)
        if th is None:
            raise ValueError(f"no calibrated StatusThresholds for rank_by={key!r}: pass MatchOptions(thresholds=...)")
    scored = [(m, _score_value(m.scores, key)) for m in matches]
    scored.sort(key=lambda mv: (math.isnan(mv[1]), mv[1], mv[0].candidate_id))
    ranked = tuple(replace(m, rank=i + 1, score=v) for i, (m, v) in enumerate(scored))
    distinct: list[CandidateMatch] = []
    for m in ranked:
        if math.isnan(m.score):
            continue
        if all(_overlap_fraction(m, k) <= options.overlap_distinct for k in distinct):
            distinct.append(m)
    distinct = tuple(replace(m, rank=i + 1) for i, m in enumerate(distinct))
    eps = th.gap_ratio - 1.0
    if not distinct:
        amb = Ambiguity("no_match", None, None, None, None, None, None, eps, 0, th, "no candidate could be evaluated")
    else:
        b = distinct[0]
        sec = distinct[1] if len(distinct) > 1 else None
        gap_abs = None if sec is None else sec.score - b.score
        if sec is None:
            ratio = None
        elif b.score <= 0:
            ratio = math.inf if sec.score > 0 else 1.0
        else:
            ratio = sec.score / b.score
        n_eps = sum(1 for m in distinct[1:] if m.score <= b.score * (1 + eps))
        if b.score > th.max_score:
            status, why = "no_match", f"best score {b.score:.4g} > max_score {th.max_score:.4g}"
        elif ratio is None or ratio >= th.gap_ratio:
            status, why = "confident", ("single distinct candidate" if ratio is None else f"second/best = {ratio:.3g} >= {th.gap_ratio:.3g}")
        else:
            status, why = "ambiguous", f"second/best = {ratio:.3g} < {th.gap_ratio:.3g} ({n_eps} other distinct within eps)"
        amb = Ambiguity(status, b.candidate_id, None if sec is None else sec.candidate_id, b.score,
                        None if sec is None else sec.score, gap_abs, ratio, eps, n_eps, th, why)
    return MatchResult(key, ranked, distinct, amb, replace(options, thresholds=th), grid, n_skipped, n_pref, timings, tuple(warnings))


class _Query:
    """Trajectory resampled for the search."""

    def __init__(self, traj: RelativeTrajectory, opt: MatchOptions):
        self.length = traj.length
        self.n = int(min(max(round(self.length / opt.spacing_m) + 1, opt.n_min), opt.n_max))
        self.q = traj.resample_n(self.n).points
        self.hq = headings(self.q)
        self.u = np.linspace(0.0, 1.0, self.n)
        self.smin, self.smax = traj.scale.min, traj.scale.max
        self.bounds = (self.smin, self.smax)


def _windows(pts: np.ndarray, s: np.ndarray, starts: np.ndarray, widths: np.ndarray, u: np.ndarray) -> np.ndarray:
    return interp_at(pts, s, starts[:, None] + widths[:, None] * u[None, :])


def _fit(q: _Query, win: np.ndarray):
    f = fit_similarity_batch(q.q, win, q.bounds)
    rel = f["rms"] / (f["scale"] * q.length)
    return f, rel


def _coarse(q: _Query, pts, s, total, opt: MatchOptions):
    """Coarse grid for one oriented candidate. Returns (starts, widths, fit, rel) or None if no window fits."""
    scales = np.unique(np.linspace(q.smin, q.smax, opt.coarse_n_scales))
    st, wd = [], []
    for sc in scales:
        w = q.length * sc
        if w > total + 1e-9:
            continue
        step = max(opt.coarse_start_frac * w, 1e-6)
        starts = np.arange(0.0, total - w + 1e-9, step)
        starts = np.unique(np.append(starts, max(total - w, 0.0)))
        st.append(starts)
        wd.append(np.full(len(starts), w))
    if not st:
        return None
    starts, widths = np.concatenate(st), np.concatenate(wd)
    win = _windows(pts, s, starts, widths, q.u)
    f, rel = _fit(q, win)
    return starts, widths, f, rel, win


def _refine(q: _Query, pts, s, total, opt: MatchOptions, start0, width0, start_span, scale_span):
    """One refinement round: `refine_n_start` starts within +-start_span of start0 and `refine_n_scale` scales within
    +-scale_span of the scale of width0."""
    s0 = width0 / q.length
    sc = np.unique(np.clip(s0 + scale_span * np.linspace(-1, 1, opt.refine_n_scale), q.smin, q.smax))
    offs = start_span * np.linspace(-1, 1, opt.refine_n_start)
    st, wd = [], []
    for scv in sc:
        w = q.length * scv
        if w > total + 1e-9:
            continue
        starts = np.clip(start0 + offs, 0.0, max(total - w, 0.0))
        st.append(starts)
        wd.append(np.full(len(starts), w))
    starts, widths = np.concatenate(st), np.concatenate(wd)
    win = _windows(pts, s, starts, widths, q.u)
    f, rel = _fit(q, win)
    return starts, widths, f, rel, win


def _transform(q: _Query, f: dict, i: int) -> np.ndarray:
    z = (q.q[:, 0] + 1j * q.q[:, 1]) * (f["scale"][i] * np.exp(1j * f["rotation"][i])) + (f["tx"][i] + 1j * f["ty"][i])
    return np.column_stack([z.real, z.imag])


@dataclass
class _Align:
    """Best alignment on one oriented candidate (internal)."""

    reverse: bool
    start: float  # along the oriented candidate
    width: float
    scale: float
    rotation: float
    t: tuple[float, float]
    clamped: bool
    rel: float
    qt: np.ndarray
    win: np.ndarray
    at_bound: bool
    n_coarse: int = 0
    n_refine: int = 0
    tier1: float = math.nan


def _coarse_stage(q: _Query, pts: np.ndarray, opt: MatchOptions, tier1: bool):
    """Coarse grid on one oriented candidate: dict with the `refine_top` best windows [(start, width, rel)], the number
    of windows, and the tier-1 heading score (min over the coarse windows), or None if no window fits."""
    s = cumulative_length(pts)
    c = _coarse(q, pts, s, float(s[-1]), opt)
    if c is None:
        return None
    starts, widths, f, rel, win = c
    top = np.argsort(rel, kind="stable")[: opt.refine_top]
    t1 = float(np.min(np.std(headings(win) - q.hq, axis=-1))) if tier1 else math.nan
    return {"top": [(float(starts[i]), float(widths[i]), float(rel[i])) for i in top], "n": len(starts), "tier1": t1}


def _refine_one(q: _Query, pts: np.ndarray, s: np.ndarray, opt: MatchOptions, start0: float, width0: float):
    """Refine around one coarse window. Each of `refine_rounds` rounds searches a small grid around the best window so
    far (which stays in the set, so the criterion never worsens); the span of the next round is the grid spacing of this one."""
    total = float(s[-1])
    scale_span = (q.smax - q.smin) / (opt.coarse_n_scales - 1) if opt.coarse_n_scales > 1 and q.smax > q.smin else 0.05 * q.smin
    start_span = opt.coarse_start_frac * width0
    w0 = _windows(pts, s, np.array([start0]), np.array([width0]), q.u)
    f0, rel0 = _fit(q, w0)
    best = (start0, width0, f0, rel0, w0[0])  # the coarse winner itself
    n_ref = 0
    for _ in range(opt.refine_rounds):
        starts, widths, f, rel, win = _refine(q, pts, s, total, opt, best[0], best[1], start_span, scale_span)
        n_ref += len(starts)
        i = int(np.argmin(rel))
        if rel[i] < best[3][0]:
            best = (float(starts[i]), float(widths[i]), {k: f[k][i:i + 1] for k in f}, rel[i:i + 1], win[i])
        start_span /= (opt.refine_n_start - 1) / 2 if opt.refine_n_start > 1 else 1
        scale_span /= (opt.refine_n_scale - 1) / 2 if opt.refine_n_scale > 1 else 1
    return best, n_ref


def _refine_stage(q: _Query, pts: np.ndarray, opt: MatchOptions, reverse: bool, coarse) -> "_Align":
    """Refine the `refine_top` best coarse windows and return the best final alignment."""
    s = cumulative_length(pts)
    n_ref = 0
    best = None
    for start0, width0, _ in coarse["top"]:
        cand, n = _refine_one(q, pts, s, opt, start0, width0)
        n_ref += n
        if best is None or cand[3][0] < best[3][0]:
            best = cand
    st, wd, fb, relb, winb = best
    at_bound = bool(fb["scale_clamped"][0]) or abs(wd / q.length - q.smin) < 1e-6 or abs(wd / q.length - q.smax) < 1e-6
    return _Align(reverse, st, wd, float(fb["scale"][0]), float(fb["rotation"][0]), (float(fb["tx"][0]), float(fb["ty"][0])),
                  bool(fb["scale_clamped"][0]), float(relb[0]), _transform(q, fb, 0), winb, at_bound, coarse["n"], n_ref, coarse["tier1"])


def _components(q: _Query, al: _Align, timings: dict[str, float], extras: tuple) -> dict[str, float | None]:
    fitted = al.scale * q.length
    t0 = time.perf_counter()
    rmse = float(np.sqrt(np.mean(np.sum((al.qt - al.win) ** 2, axis=1))))
    t1 = time.perf_counter()
    fr = M.frechet(al.qt, al.win)
    t2 = time.perf_counter()
    ha = M.hausdorff(al.qt, al.win)
    t3 = time.perf_counter()
    hd = M.heading_signature_distance(al.qt, al.win, q.n)  # same function as the public metric (both curves re-resampled by arc length)
    t4 = time.perf_counter()
    for k, v in (("rmse", t1 - t0), ("frechet", t2 - t1), ("hausdorff", t3 - t2), ("heading", t4 - t3)):
        timings[k] = timings.get(k, 0.0) + v
    out = {"rmse_m": rmse, "frechet_m": fr, "hausdorff_m": ha, "rmse_rel": rmse / fitted, "frechet_rel": fr / fitted,
           "hausdorff_rel": ha / fitted, "heading": hd}
    for name, fn in extras:
        t = time.perf_counter()
        v = float(fn(al.qt, al.win))
        timings[name] = timings.get(name, 0.0) + time.perf_counter() - t
        out[f"{name}_m"], out[f"{name}_rel"] = v, v / fitted
    return out


def match(trajectory: RelativeTrajectory, candidates: list[Candidate], options: MatchOptions | None = None) -> MatchResult:
    """Rank `candidates` against `trajectory`. See the module docstring."""
    opt = options or MatchOptions()
    if not isinstance(trajectory, RelativeTrajectory):
        raise ValueError("trajectory must be a RelativeTrajectory")
    if not candidates:
        raise ValueError("no candidates")
    if len({c.id for c in candidates}) != len(candidates):
        raise ValueError("candidate ids must be unique")
    q = _Query(trajectory, opt)
    timings: dict[str, float] = {}
    t_start = time.perf_counter()
    do_rev = opt.allow_reverse or opt.diagnose_reverse
    tier1 = opt.prefilter_k is not None

    # stage 1: coarse search on every candidate (and its reverse)
    stage = []
    skipped = 0
    for c in candidates:
        fwd = _coarse_stage(q, c.points, opt, tier1)
        if fwd is None:
            skipped += 1
            continue
        rev = _coarse_stage(q, c.points[::-1], opt, tier1) if do_rev else None
        stage.append((c, fwd, rev))
    timings["coarse"] = time.perf_counter() - t_start

    n_pref = 0
    if tier1 and len(stage) > opt.prefilter_k:
        order = sorted(range(len(stage)), key=lambda i: min(stage[i][1]["tier1"], stage[i][2]["tier1"] if stage[i][2] else math.inf))
        keep = set(order[: opt.prefilter_k])
        n_pref = len(stage) - len(keep)
        stage = [x for i, x in enumerate(stage) if i in keep]

    # stage 2: refinement on the survivors
    tic = time.perf_counter()
    items = []
    n_coarse = n_refine = 0
    for c, cf, cr in stage:
        fwd = _refine_stage(q, c.points, opt, False, cf)
        rev = _refine_stage(q, c.points[::-1], opt, True, cr) if cr is not None else None
        n_coarse += fwd.n_coarse + (rev.n_coarse if rev else 0)
        n_refine += fwd.n_refine + (rev.n_refine if rev else 0)
        items.append((c, fwd, rev))
    timings["refine"] = time.perf_counter() - tic

    # stage 3: all components at the final alignments
    tic = time.perf_counter()
    comps = []
    for c, fwd, rev in items:
        comps.append((_components(q, fwd, timings, opt.extra_metrics),
                      _components(q, rev, timings, opt.extra_metrics) if rev is not None else None))
    chosen = []
    for (c, fwd, rev), (cf, cr) in zip(items, comps):
        use_rev = opt.allow_reverse and rev is not None and rev.rel < fwd.rel
        chosen.append((rev, cr) if use_rev else (fwd, cf))
    warnings: list[str] = []
    timings["components"] = time.perf_counter() - tic

    matches = []
    for (c, fwd, rev), (cf, cr), (al, cc) in zip(items, comps, chosen):
        total = float(cumulative_length(c.points)[-1])
        start_fwd = total - al.start - al.width if al.reverse else al.start
        origin = c.origin_id if c.origin_id is not None else c.id
        w = []
        if al.at_bound:
            w.append(f"scale {al.scale:.3f} at the prior bound [{q.smin}, {q.smax}]" + (" (fit clamped)" if al.clamped else ""))
        matches.append(CandidateMatch(
            candidate_id=c.id, origin_id=origin, rank=0, score=math.nan, scores=cc, scale=al.scale, rotation_rad=al.rotation,
            translation=al.t, window_start_m=float(start_fwd), window_length_m=al.width,
            origin_start_m=float(c.origin_offset_m + start_fwd), origin_end_m=float(c.origin_offset_m + start_fwd + al.width),
            reversed=al.reverse, scale_clamped=al.clamped, scale_at_bound=al.at_bound,
            forward_scores=cf, reverse_scores=cr, warnings=tuple(w), meta=dict(c.meta)))
    grid = {"n_points": q.n, "coarse_n_scales": opt.coarse_n_scales, "coarse_start_frac": opt.coarse_start_frac,
            "refine_n_start": opt.refine_n_start, "refine_n_scale": opt.refine_n_scale, "refine_rounds": opt.refine_rounds, "refine_top": opt.refine_top,
            "windows_coarse_total": n_coarse, "windows_refine_total": n_refine,
            "windows_per_candidate": ((n_coarse + n_refine) / len(items)) if items else 0,
            "n_candidates": len(candidates), "n_evaluated": len(items)}
    timings["total"] = time.perf_counter() - t_start
    return _finalize(matches, opt, grid, skipped, n_pref, timings, warnings)
