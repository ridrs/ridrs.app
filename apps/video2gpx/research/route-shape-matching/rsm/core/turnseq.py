# SPDX-License-Identifier: AGPL-3.0-or-later
"""Turn-sequence matcher: align the turn list of a video (vms odometry) to a window of a long candidate path. numpy / scipy only.

WHAT IT MATCHES
  query     = ordered segments (`TurnQuery`). Each segment has a nominal length (metres of the odometry, scale uncertain), its
              turns (signed angle in degrees, left positive; start/end position in nominal metres inside the segment) and the
              duration of the gap that follows it (seconds; the length of a gap is NOT known).
  candidate = a long path (`TurnPath`): its turns in true metres along the path, made by the SAME detector
              (`rsm.odometry.turns.detect_turns`, default `TurnParams`) from the path heading over arc length.
  Everything in the query is relative; the matcher finds where on which candidate the query fits best.

PUBLIC API (see the end of the module docstring for a recipe)
  TurnPath.from_theta(id, s_m, theta_rad) / .from_xy(id, xy) / .from_turns(id, angle_deg, s_start, s_end, length_m)
  TurnQuery(segments=(QSegment(length_m, turns=(QTurn(angle_deg, s_start, s_end, clipped), ...), duration_s, gap_after_s), ...))
  TurnQuery.from_vms_segments(segments_json_dict)           # work/odometry/<video>/segments.json
  TurnLibrary(paths)                                         # concatenates the paths once; reuse it for many queries
  search(query, library, params, thresholds, top_k)          -> TurnMatchResult
  match_candidates(query, [(id, s_m, theta_rad), ...], ...)  -> TurnMatchResult   (convenience; builds the library)

MODEL (all costs in nats = negative log-likelihood-like numbers; lower is better; constants in `TurnMatchParams`)
  An alignment assigns each query turn either to one candidate turn (a match; order preserved) or to nothing (an "extra", a
  turn the video has and the path has not), and every candidate turn that lies inside the observed part of the query but
  is not assigned is a "miss" (the path has it, the video did not detect it). Components, reported separately:
    angle    robust (Student-t, nu=3) cost of ln|a_query| - ln|A_path| against a bias and a sigma that grows for small turns:
             sigma_ln^2 = sigma_rel^2 + (sigma_abs / |A|)^2. A query turn flagged `clipped` (touches the segment edge, so its
             angle is a lower bound) pays nothing when it is smaller than expected.
    base     -ln(1 - p_miss(|A|)): the matched candidate turn was detected.
    flip     `flip_cost` for a matched pair with opposite signs (default 7 nats: more than an extra plus a miss costs, so a
             flipped pair is accepted only in marginal cases; this is what keeps a mirrored query from matching its source).
    extra    -ln(p_extra) + c0 per unmatched query turn, c0 = -ln of the null density of that turn's angle and sign.
    miss     -ln p_miss(|A|) per unmatched candidate turn inside the observed part. Between two matches in different
             segments a skipped candidate turn may lie in an unobserved gap, so it is weighted by the fraction of the
             stretch that is observed (segment length / (segment length + expected gap length)).
    spacing  position consistency. Each segment has its own distance scale rho = nominal metres / true metres, with a prior
             [rho_lo, rho_hi] (default 0.4 to 1.5) enforced softly (a log-ratio outside the prior costs 0.5 (x / sigma_edge)^2,
             sigma_edge 0.15). Inside one segment the spacing of two matched turns must imply a rho inside the prior (optionally a
             Gaussian around `rho_center` if `rho_sigma_ln` is set). Across segments the unknown gap length (0 to
             gap_s * speed bound) and the different rho of each segment are allowed for; the check is only an interval.
  The sequence is aligned by dynamic programming over (query turn, candidate turn) pairs: up to `max_query_skip` consecutive
  extras and `max_cand_skip` consecutive misses between two matches; the first match and the last match may be anywhere
  (the unmatched ends cost extras and misses, so the whole query must be explained). All candidate paths are concatenated
  and processed by one vectorised DP per query turn.

RANKING AND CONFIDENCE
  Each end node of the DP gives one alignment; per path the best are kept and de-duplicated: two results are the same location
  if they are on the same path and their windows overlap by more than 50 % of the shorter window (greedy, best first).
  Rank by `cost`. `evidence` = sum of c0 over the query turns - cost: the log-likelihood advantage (nats) of "the video turns come from this
  window with the stated detection errors" over "they are unrelated random turns" (null density of angle and sign per turn, no
  position information). Spacing is only a penalty, so no evidence is credited for consistent spacing (conservative).
  `ambiguity.gap_nats` = cost(second distinct) - cost(best); `gap_ratio` = evidence(best) / evidence(second) (None if the second is <= 0).
  status: "no_match" if evidence(best) < `ConfidenceThresholds.min_evidence`, "confident" if additionally gap_nats >=
  `min_gap_nats`, else "ambiguous". The thresholds are NOT constants of nature: tune them on a dev split (rsm.bench.turnseq_bench).
  Why both: a small library can contain one place that fits a foreign query much better than all others (large gap) while the fit
  itself is poor (evidence near or below 0); the evidence rejects it, the gap rejects repetition.

KNOWN LIMITS
  Only turns are used (no lengths of turns, no junction info); a query with fewer than 2 turns cannot be distinctive; the
  direction of travel is assumed (reversed copies of the paths must be in the library if wanted: `TurnPath.reversed()`);
  a window may hang over the end of a path (no penalty).

RECIPE (video turn sequence vs OSM paths)
    import json
    from rsm.core.turnseq import TurnQuery, match_candidates
    q = TurnQuery.from_vms_segments(json.load(open("work/odometry/gotthard/segments.json")))
    res = match_candidates(q, [(path_id, s_m, theta_rad), ...])      # s_m arc length (m), theta_rad unwrapped heading
    res.matches[0].path_id, res.matches[0].start_m, res.matches[0].components, res.ambiguity
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field, replace
from typing import Sequence

import numpy as np

PATH_STRIDE = 1.0e7  # metres between concatenated paths in the library (> any path length)
_LN_SQRT_2PI = 0.5 * math.log(2 * math.pi)


# ----------------------------------------------------------------------------------------------------------------------
# data


@dataclass(frozen=True)
class QTurn:
    angle_deg: float  # signed, left positive
    s_start: float  # nominal metres from the segment start
    s_end: float
    clipped: bool = False  # touches the segment edge: the angle is a lower bound

    @property
    def center(self) -> float:
        return 0.5 * (self.s_start + self.s_end)


@dataclass(frozen=True)
class QSegment:
    length_m: float  # nominal
    turns: tuple[QTurn, ...] = ()
    duration_s: float | None = None
    gap_after_s: float | None = None  # unobserved time between this segment and the next (None for the last / unknown)


@dataclass(frozen=True)
class TurnQuery:
    segments: tuple[QSegment, ...]
    qid: str = ""

    @property
    def n_turns(self) -> int:
        return sum(len(s.turns) for s in self.segments)

    @property
    def length_m(self) -> float:
        return float(sum(s.length_m for s in self.segments))

    @classmethod
    def from_vms_segments(cls, doc: dict, qid: str = "", seg_range: tuple[int, int] | None = None) -> "TurnQuery":
        """From the parsed `segments.json` of `python -m rsm odometry`. Usable segments in time order; the gap after a segment is
        the time to the next usable segment (it includes too-short sections). `seg_range` = (first, last+1) among the usable ones."""
        use = [s for s in doc["segments"] if s.get("usable")]
        if seg_range is not None:
            use = use[seg_range[0]:seg_range[1]]
        segs = []
        for k, s in enumerate(use):
            gap = (use[k + 1]["t0"] - s["t1"]) if k + 1 < len(use) else None
            turns = tuple(QTurn(float(t["angle_deg"]), float(t["s_start"]), float(t["s_end"]), bool(t.get("clipped", False))) for t in s.get("turns", []))
            segs.append(QSegment(float(s["length_nominal_m"]), turns, float(s["duration_s"]), None if gap is None else float(gap)))
        return cls(tuple(segs), qid)

    def mirrored(self) -> "TurnQuery":
        return TurnQuery(tuple(replace(s, turns=tuple(replace(t, angle_deg=-t.angle_deg) for t in s.turns)) for s in self.segments), self.qid + "~mirror")


@dataclass(frozen=True)
class TurnPath:
    """A candidate path with its turns in true metres along the path. `angle_deg` signed (left +), positions of start/end."""
    id: str
    angle_deg: np.ndarray
    s_start: np.ndarray
    s_end: np.ndarray
    length_m: float

    def __post_init__(self) -> None:
        if not (len(self.angle_deg) == len(self.s_start) == len(self.s_end)):
            raise ValueError("turn arrays differ in length")

    @property
    def center(self) -> np.ndarray:
        return 0.5 * (np.asarray(self.s_start) + np.asarray(self.s_end))

    @property
    def n_turns(self) -> int:
        return len(self.angle_deg)

    @classmethod
    def from_turns(cls, id: str, angle_deg, s_start, s_end, length_m: float) -> "TurnPath":
        o = np.argsort(np.asarray(s_start, float) + np.asarray(s_end, float), kind="stable")
        return cls(id, np.asarray(angle_deg, float)[o], np.asarray(s_start, float)[o], np.asarray(s_end, float)[o], float(length_m))

    @classmethod
    def from_theta(cls, id: str, s_m, theta_rad, params=None) -> "TurnPath":
        """Turns of a heading curve theta(s) (unwrapped, rad, left positive; s in true metres) with the odometry turn detector."""
        from ..odometry.turns import TurnParams, detect_turns

        s = np.asarray(s_m, float)
        tu = detect_turns(s, np.asarray(theta_rad, float), None, params or TurnParams())
        return cls.from_turns(id, [t.angle_deg for t in tu], [t.s_start for t in tu], [t.s_end for t in tu], float(s[-1] - s[0]))

    @classmethod
    def from_xy(cls, id: str, xy, params=None) -> "TurnPath":
        """Turns of a polyline (N, 2) in metres, x right, y forward (heading atan2(dy, dx), left turn positive)."""
        xy = np.asarray(xy, float)
        d = np.diff(xy, axis=0)
        seg = np.hypot(d[:, 0], d[:, 1])
        keep = seg > 1e-9
        d, seg = d[keep], seg[keep]
        s = np.concatenate([[0.0], np.cumsum(seg)])
        theta = np.unwrap(np.arctan2(d[:, 1], d[:, 0]))
        sm = 0.5 * (s[:-1] + s[1:])
        return cls.from_theta(id, sm, theta, params) if len(sm) >= 3 else cls.from_turns(id, [], [], [], float(s[-1]))

    def reversed(self, id: str | None = None) -> "TurnPath":
        L = self.length_m
        return TurnPath.from_turns(id or self.id + "~rev", -np.asarray(self.angle_deg), L - np.asarray(self.s_end), L - np.asarray(self.s_start), L)

    def mirrored(self, id: str | None = None) -> "TurnPath":
        return TurnPath(id or self.id + "~mir", -np.asarray(self.angle_deg), np.asarray(self.s_start), np.asarray(self.s_end), self.length_m)


# ----------------------------------------------------------------------------------------------------------------------
# parameters


@dataclass(frozen=True)
class TurnMatchParams:
    # distance scale prior, rho = query nominal metres / true metres (measured vms/COLMAP piece ratios 0.47 to 1.27, times
    # about 1.2 for COLMAP-vs-GPX: 0.56 to 1.52; see work/turnseq/RESULTS.md)
    rho_lo: float = 0.4
    rho_hi: float = 1.5
    rho_center: float = 0.75  # only used to estimate window extents (and the Gaussian prior when rho_sigma_ln is set)
    rho_sigma_ln: float | None = None  # None: flat inside the prior; else Gaussian on ln rho for pairs inside one segment
    rho_edge_sigma_ln: float = 0.15
    # miss probability by |angle|: p_miss_small below miss_edge_deg, p_miss_large from there
    miss_edge_deg: float = 45.0
    p_miss_small: float = 0.70
    p_miss_large: float = 0.12
    # angle error model on ln(|a_query| / |A_path|)
    angle_log_bias: float = -0.05
    angle_sigma_rel: float = 0.30
    angle_sigma_abs_deg: float = 10.0
    t_dof: float = 3.0
    flip_cost: float = 7.0
    # extras: probability that a query turn is spurious (measured 3/24 = 0.125, margin 0.2); null model of a turn angle for the
    # evidence: ln|a| ~ N(null_ln_mean, null_ln_sd) (vms turns: 4.08 / 0.60; stand-in track turns: 4.28 / 0.57), sign +- 1/2
    p_extra: float = 0.20
    null_ln_mean: float = 4.15
    null_ln_sd: float = 0.60
    # alignment search limits
    max_cand_skip: int = 5
    max_query_skip: int = 3
    # gaps
    gap_speed_factor: float = 1.5  # candidate-metre speed bound = factor * nominal speed / rho_lo
    default_speed_mps: float = 3.5  # nominal speed if a segment has no duration
    default_gap_s: float = 3.0
    distinct_overlap: float = 0.5


@dataclass(frozen=True)
class ConfidenceThresholds:
    min_gap_nats: float = 6.0
    min_evidence: float = 6.0


# ----------------------------------------------------------------------------------------------------------------------
# library


class TurnLibrary:
    """Many candidate paths concatenated into flat arrays (built once, reused for many queries)."""

    def __init__(self, paths: Sequence[TurnPath]):
        self.paths = list(paths)
        P = len(self.paths)
        n = np.array([p.n_turns for p in self.paths], dtype=np.int64)
        self.n_turns = int(n.sum())
        self.path_first = np.concatenate([[0], np.cumsum(n)])
        self.pid = np.repeat(np.arange(P), n)
        cs = [p.center for p in self.paths if p.n_turns]
        self.angle = np.concatenate([np.asarray(p.angle_deg, float) for p in self.paths if p.n_turns]) if self.n_turns else np.zeros(0)
        self.local_s = np.concatenate(cs) if cs else np.zeros(0)
        self.S = self.local_s + self.pid * PATH_STRIDE
        self.path_length = np.array([p.length_m for p in self.paths])
        if self.path_length.size and self.path_length.max() >= PATH_STRIDE:
            raise ValueError("path longer than PATH_STRIDE")
        self._prep: dict = {}

    def __len__(self) -> int:
        return len(self.paths)

    def prepare(self, par: TurnMatchParams) -> "_Prep":
        key = (par.miss_edge_deg, par.p_miss_small, par.p_miss_large, par.p_extra, par.angle_sigma_rel, par.angle_sigma_abs_deg, par.max_cand_skip)
        if key not in self._prep:
            self._prep = {key: _Prep(self, par)}  # keep one
        return self._prep[key]


class _Prep:
    def __init__(self, lib: TurnLibrary, par: TurnMatchParams):
        M = lib.n_turns
        self.M = M
        aa = np.abs(lib.angle)
        self.lnA = np.log(np.maximum(aa, 1e-3)).astype(np.float32)
        self.sgn = np.sign(lib.angle).astype(np.int8)
        sig = np.sqrt(par.angle_sigma_rel ** 2 + (par.angle_sigma_abs_deg / np.maximum(aa, 1.0)) ** 2)
        self.sig = sig.astype(np.float32)
        self.lnsig = (np.log(sig) + _LN_SQRT_2PI).astype(np.float32)
        pm = np.where(aa < par.miss_edge_deg, par.p_miss_small, par.p_miss_large)
        self.okc = (-np.log1p(-pm) - math.log1p(-par.p_extra)).astype(np.float32)
        self.missc = (-np.log(pm)).astype(np.float32)
        self.P = np.concatenate([[0.0], np.cumsum(self.missc.astype(np.float64))])  # P[k] = sum of miss costs of turns < k
        K = par.max_cand_skip + 1
        self.K = K
        self.S = lib.S
        self.Sloc = lib.local_s.astype(np.float32)
        self.lagD, self.lagLn, self.lagInv, self.lagP = [None], [None], [None], [None]
        for l in range(1, K + 1):
            D = np.zeros(M, np.float64)
            inv = np.full(M, np.inf, np.float32)
            if M > l:
                D[l:] = lib.S[l:] - lib.S[:-l]
                same = lib.pid[l:] == lib.pid[:-l]
                inv[l:] = np.where(same, 0.0, np.inf)
            D = np.where(np.isfinite(inv), np.maximum(D, 0.5), 1.0)
            self.lagD.append(D.astype(np.float32))
            self.lagLn.append(np.log(D).astype(np.float32))
            self.lagInv.append(inv)
            Pl = np.zeros(M, np.float32)
            if M > l:
                Pl[l:] = (self.P[np.arange(l, M)] - self.P[np.arange(l, M) - l + 1]).astype(np.float32)  # turns j-l+1 .. j-1
            self.lagP.append(Pl)


# ----------------------------------------------------------------------------------------------------------------------
# query flattening


class _Q:
    def __init__(self, q: TurnQuery, par: TurnMatchParams):
        segs = q.segments
        nseg = len(segs)
        L = np.array([s.length_m for s in segs], float)
        self.L = L
        self.Oin = np.concatenate([[0.0], np.cumsum(L)])  # in-segment cumulative before segment k
        vnom = np.array([(s.length_m / s.duration_s) if (s.duration_s and s.duration_s > 0) else par.default_speed_mps for s in segs])
        gs = np.array([(s.gap_after_s if s.gap_after_s is not None else (par.default_gap_s if k + 1 < nseg else 0.0)) for k, s in enumerate(segs)], float)
        self.gap_nom = gs * vnom  # expected gap length in nominal metres
        self.gap_cand = gs * vnom * par.gap_speed_factor / par.rho_lo  # upper bound in true metres
        self.cumGn = np.concatenate([[0.0], np.cumsum(self.gap_nom)])  # gaps before segment k
        self.cumGc = np.concatenate([[0.0], np.cumsum(self.gap_cand)])
        a, seg, c, cl = [], [], [], []
        for k, s in enumerate(segs):
            for t in s.turns:
                a.append(t.angle_deg); seg.append(k); c.append(t.center); cl.append(t.clipped)
        self.N = len(a)
        self.a = np.array(a, float)
        self.seg = np.array(seg, int)
        self.pos = np.array([self.Oin[k] + x for k, x in zip(seg, c)], float)  # in-segment cumulative position
        self.lna = np.log(np.maximum(np.abs(self.a), 1e-3))
        z0 = (self.lna - par.null_ln_mean) / par.null_ln_sd
        self.c0 = np.log(par.null_ln_sd) + _LN_SQRT_2PI + 0.5 * z0 * z0 + math.log(2.0)  # -ln of the null density of this turn (nats)
        self.c_extra = self.c0 - math.log(par.p_extra)
        self.cumEx = np.concatenate([[0.0], np.cumsum(self.c_extra)])
        self.sgn = np.sign(self.a).astype(np.int8)
        self.clipped = np.array(cl, bool)
        self.total_in = float(L.sum())
        self.total_gn = float(self.gap_nom[:-1].sum()) if nseg else 0.0
        if self.N:
            self.gn_before = self.cumGn[self.seg]
            self.gn_after = self.total_gn - self.gn_before
            self.head_in = self.pos
            self.tail_in = self.total_in - self.pos
            self.head_tot = self.head_in + self.gn_before
            self.tail_tot = self.tail_in + self.gn_after
            self.w_head = np.where(self.head_tot > 0, self.head_in / np.maximum(self.head_tot, 1e-9), 1.0)
            self.w_tail = np.where(self.tail_tot > 0, self.tail_in / np.maximum(self.tail_tot, 1e-9), 1.0)
        self.w_all = self.total_in / max(self.total_in + self.total_gn, 1e-9)

    def pair(self, ip: int, i: int):
        """(in-segment nominal distance, upper bound of gap length in true metres, weight of observed part, same segment)."""
        d = max(self.pos[i] - self.pos[ip], 1.0)
        G = self.cumGc[self.seg[i]] - self.cumGc[self.seg[ip]]
        gn = self.cumGn[self.seg[i]] - self.cumGn[self.seg[ip]]
        same = self.seg[i] == self.seg[ip]
        return d, float(G), d / (d + gn), bool(same)


def _tcost(z, nu):
    return 0.5 * (nu + 1.0) * np.log1p(z * z / nu)


def _spacing(lnD, Draw, d, G, same, par: TurnMatchParams):
    """Spacing cost array for a query pair at nominal in-segment distance d, gap bound G (true m), candidate distances Draw."""
    lnd = math.log(d)
    se = par.rho_edge_sigma_ln
    lnrho_a = lnd - lnD  # largest implied rho (gap 0)
    x1 = np.maximum(lnrho_a - math.log(par.rho_hi), 0.0)
    if G > 0:
        lnrho_b = lnd - np.log(np.maximum(Draw - np.float32(G), 1.0))
    else:
        lnrho_b = lnrho_a
    x2 = np.maximum(math.log(par.rho_lo) - lnrho_b, 0.0)
    cost = 0.5 * (x1 * x1 + x2 * x2) / (se * se)
    if same and par.rho_sigma_ln:
        cost = cost + 0.5 * ((lnrho_a - math.log(par.rho_center)) / par.rho_sigma_ln) ** 2
    return cost


def _match_cost(pr: _Prep, q: _Q, i: int, par: TurnMatchParams):
    z = (np.float32(q.lna[i]) - pr.lnA - np.float32(par.angle_log_bias)) / pr.sig
    if q.clipped[i]:
        z = np.maximum(z, 0.0)
    ac = _tcost(z, par.t_dof) + pr.lnsig
    base = pr.okc + ac
    base = base + np.where(pr.sgn == q.sgn[i], np.float32(0.0), np.float32(par.flip_cost))
    return base.astype(np.float32), ac, z


# ----------------------------------------------------------------------------------------------------------------------
# dynamic programme


def _dp(lib: TurnLibrary, pr: _Prep, q: _Q, par: TurnMatchParams, store: bool):
    M, N, K = pr.M, q.N, pr.K
    INF = np.float32(np.inf)
    rc = par.rho_center
    bestF = np.full(M, INF, np.float32)
    bestW0 = np.zeros(M, np.float32)
    bestW1 = np.zeros(M, np.float32)
    bestI = np.full(M, -1, np.int16)
    D: list = [None] * N
    W: list = [None] * N
    ptr_ip: list = [None] * N
    ptr_l: list = [None] * N
    jj = np.arange(M)
    for i in range(N):
        mc, _, _ = _match_cost(pr, q, i, par)
        # first match: unmatched query turns before it are extras; candidate turns in the head are misses
        hl = q.head_tot[i] / rc
        k0 = np.minimum(np.searchsorted(pr.S, pr.S - hl, side="right"), jj)
        head = (pr.P[jj] - pr.P[k0]).astype(np.float32)
        cur = (np.float32(q.cumEx[i]) + np.float32(q.w_head[i]) * head + mc).astype(np.float32)
        curW = (pr.Sloc - np.float32(hl)).astype(np.float32)
        if store:
            pip = np.full(M, -1, np.int16)
            pl = np.zeros(M, np.int8)
        for ip in range(max(0, i - 1 - par.max_query_skip), i):
            base, bW = D[ip], W[ip]
            d, G, w, same = q.pair(ip, i)
            sk = np.float32(q.cumEx[i] - q.cumEx[ip + 1])
            for l in range(1, K + 1):
                if l >= M:
                    break
                sp = _spacing(pr.lagLn[l][l:], pr.lagD[l][l:], d, G, same, par)
                t = base[:M - l] + (np.float32(w) * pr.lagP[l][l:] + sk + sp + pr.lagInv[l][l:] + mc[l:]).astype(np.float32)
                better = t < cur[l:]
                if better.any():
                    cur[l:] = np.where(better, t, cur[l:])
                    curW[l:] = np.where(better, bW[:M - l], curW[l:])
                    if store:
                        pip[l:] = np.where(better, np.int16(ip), pip[l:])
                        pl[l:] = np.where(better, np.int8(l), pl[l:])
        D[i], W[i] = cur, curW
        if store:
            ptr_ip[i], ptr_l[i] = pip, pl
        elif i - par.max_query_skip - 1 >= 0:
            D[i - par.max_query_skip - 1] = W[i - par.max_query_skip - 1] = None
        tl = q.tail_tot[i] / rc
        k1 = np.maximum(np.searchsorted(pr.S, pr.S + tl, side="left"), jj + 1)
        tail = (pr.P[k1] - pr.P[np.minimum(jj + 1, M)]).astype(np.float32)
        F = cur + np.float32(q.w_tail[i]) * tail + np.float32(q.cumEx[N] - q.cumEx[i + 1])
        upd = F < bestF
        bestF = np.where(upd, F, bestF)
        bestW0 = np.where(upd, curW, bestW0)
        bestW1 = np.where(upd, (pr.Sloc + np.float32(tl)).astype(np.float32), bestW1)
        bestI = np.where(upd, np.int16(i), bestI)
    return dict(F=bestF, W0=bestW0, W1=bestW1, I=bestI, D=D, ptr_ip=ptr_ip, ptr_l=ptr_l)


# ----------------------------------------------------------------------------------------------------------------------
# results


@dataclass(frozen=True)
class TurnMatch:
    rank: int
    path_id: str
    start_m: float  # window on the path (true metres), estimated with rho_center and the expected gap lengths
    end_m: float
    cost: float
    evidence: float
    components: dict  # angle, base, flip, extra, miss, spacing (nats) and counts n_match, n_extra, n_miss, n_flip
    pairs: tuple  # (query turn index, path turn index, query angle, path angle, path position m)
    extras: tuple  # query turn indices
    misses: tuple  # (path turn index, weight)
    rho_est: tuple  # per query segment: median implied rho of consecutive matches in the segment, or None


@dataclass(frozen=True)
class TurnMatchResult:
    matches: tuple  # distinct locations, best first (with alignments for the first `top_k`)
    ambiguity: dict
    n_paths: int
    n_path_turns: int
    n_query_turns: int
    seconds: float
    params: TurnMatchParams

    @property
    def status(self) -> str:
        return self.ambiguity["status"]


def _window_overlap(a0, a1, b0, b1) -> float:
    inter = max(0.0, min(a1, b1) - max(a0, b0))
    return inter / max(min(a1 - a0, b1 - b0), 1e-9)


def _alignment(lib: TurnLibrary, par: TurnMatchParams, q: _Q, path_index: int, j_local: int, tq: TurnQuery) -> dict:
    """Re-run the DP on one path with back pointers and decompose the cost."""
    sub = TurnLibrary([lib.paths[path_index]])
    pr = sub.prepare(par)
    out = _dp(sub, pr, q, par, store=True)
    i = int(out["I"][j_local])
    j = j_local
    pairs = []
    while True:
        pairs.append((i, j))
        ip, l = int(out["ptr_ip"][i][j]), int(out["ptr_l"][i][j])
        if ip < 0:
            break
        i, j = ip, j - l
    pairs.reverse()
    return dict(pairs=pairs, cost=float(out["F"][j_local]), sub=sub, pr=pr)


def _decompose(al: dict, q: _Q, par: TurnMatchParams, path: TurnPath) -> tuple[dict, list, list, list]:
    sub, pr, pairs = al["sub"], al["pr"], al["pairs"]
    rc = par.rho_center
    comp = dict(angle=0.0, base=0.0, flip=0.0, extra=0.0, miss=0.0, spacing=0.0)
    miss: list[tuple[int, float]] = []
    n_flip = 0
    for (i, j) in pairs:
        _, ac, _ = _match_cost(pr, q, i, par)
        comp["angle"] += float(ac[j])
        comp["base"] += float(pr.okc[j])
        if pr.sgn[j] != q.sgn[i]:
            comp["flip"] += par.flip_cost
            n_flip += 1
    matched = {i for i, _ in pairs}
    extras = [i for i in range(q.N) if i not in matched]
    comp["extra"] = float(sum(q.c_extra[i] for i in extras))
    (i0, j0), (i1, j1) = pairs[0], pairs[-1]
    hl, tl = q.head_tot[i0] / rc, q.tail_tot[i1] / rc
    for k in range(sub.n_turns):  # head
        if pr.S[k] > pr.S[j0] - hl and k < j0:
            miss.append((k, float(q.w_head[i0])))
        if k > j1 and pr.S[k] < pr.S[j1] + tl:
            miss.append((k, float(q.w_tail[i1])))
    for (ia, ja), (ib, jb) in zip(pairs, pairs[1:]):
        d, G, w, same = q.pair(ia, ib)
        for k in range(ja + 1, jb):
            miss.append((k, w))
        sp = _spacing(np.float32(math.log(max(pr.S[jb] - pr.S[ja], 0.5))), np.float32(max(pr.S[jb] - pr.S[ja], 0.5)), d, G, same, par)
        comp["spacing"] += float(sp)
    comp["miss"] = float(sum(w * pr.missc[k] for k, w in miss))
    comp["total"] = sum(comp[k] for k in ("angle", "base", "flip", "extra", "miss", "spacing"))
    comp.update(n_match=len(pairs), n_extra=len(extras), n_miss=len(miss), n_flip=n_flip)
    return comp, extras, miss, pairs


def _rho_est(q: _Q, pairs, pr: _Prep, nseg: int) -> tuple:
    est: list[list[float]] = [[] for _ in range(nseg)]
    for (ia, ja), (ib, jb) in zip(pairs, pairs[1:]):
        if q.seg[ia] == q.seg[ib]:
            est[q.seg[ia]].append((q.pos[ib] - q.pos[ia]) / max(pr.S[jb] - pr.S[ja], 0.5))
    return tuple(float(np.median(e)) if e else None for e in est)


def search(query: TurnQuery, library: "TurnLibrary | Sequence[TurnPath]", params: TurnMatchParams = TurnMatchParams(),
           thresholds: ConfidenceThresholds = ConfidenceThresholds(), top_k: int = 10, n_ranked: int = 50) -> TurnMatchResult:
    """Rank the distinct locations of `library` for `query`. The first `top_k` results carry the full alignment and components,
    the next up to `n_ranked` have only cost, evidence and window (path_id, start_m, end_m)."""
    t0 = time.perf_counter()
    lib = library if isinstance(library, TurnLibrary) else TurnLibrary(library)
    q = _Q(query, params)
    if q.N == 0 or lib.n_turns == 0:
        return TurnMatchResult((), dict(status="no_match", gap_nats=0.0, gap_ratio=None, evidence=0.0, best_cost=None, second_cost=None, reason="no turns"),
                               len(lib), lib.n_turns, q.N, time.perf_counter() - t0, params)
    pr = lib.prepare(params)
    out = _dp(lib, pr, q, params, store=False)
    F, W0, W1 = out["F"], out["W0"].astype(np.float64), out["W1"].astype(np.float64)
    pid = lib.pid
    # best end node per path, then more per path with NMS
    order = np.argsort(F, kind="stable")
    order = order[np.isfinite(F[order])]
    chosen: list[tuple[int, int]] = []  # (end node j, path)
    per_path: dict[int, list[tuple[float, float]]] = {}
    limit = top_k + n_ranked
    for j in order[: max(20000, 50 * limit)]:
        p = int(pid[j])
        a0, a1 = W0[j], W1[j]
        if any(_window_overlap(a0, a1, b0, b1) > params.distinct_overlap for b0, b1 in per_path.get(p, ())):
            continue
        per_path.setdefault(p, []).append((a0, a1))
        chosen.append((int(j), p))
        if len(chosen) >= limit:
            break
    # evidence = null cost of the same window minus cost
    ev = []
    for j, p in chosen:
        ev.append(float(q.c0.sum()) - float(F[j]))
    matches = []
    for r, ((j, p), e) in enumerate(zip(chosen, ev)):
        base = dict(rank=r + 1, path_id=lib.paths[p].id, start_m=float(W0[j]), end_m=float(W1[j]), cost=float(F[j]), evidence=float(e))
        if r < top_k:
            j_local = int(j - lib.path_first[p])
            al = _alignment(lib, params, q, p, j_local, query)
            comp, extras, miss, pairs = _decompose(al, q, params, lib.paths[p])
            sub, spr = al["sub"], al["pr"]
            matches.append(TurnMatch(**base, components=comp, pairs=tuple((i, jl, float(q.a[i]), float(sub.angle[jl]), float(sub.local_s[jl])) for i, jl in pairs),
                                     extras=tuple(extras), misses=tuple(miss), rho_est=_rho_est(q, pairs, spr, len(query.segments))))
        else:
            matches.append(TurnMatch(**base, components={}, pairs=(), extras=(), misses=(), rho_est=()))
    if not matches:
        amb = dict(status="no_match", gap_nats=0.0, gap_ratio=None, evidence=0.0, best_cost=None, second_cost=None, reason="no alignment")
    else:
        b = matches[0]
        s2 = matches[1] if len(matches) > 1 else None
        gap = (s2.cost - b.cost) if s2 else float("inf")
        ratio = (b.evidence / s2.evidence) if (s2 and s2.evidence > 0) else None
        if b.evidence < thresholds.min_evidence:
            st = "no_match"
        elif gap >= thresholds.min_gap_nats:
            st = "confident"
        else:
            st = "ambiguous"
        amb = dict(status=st, gap_nats=float(gap), gap_ratio=None if ratio is None else float(ratio), evidence=b.evidence, best_cost=b.cost,
                   second_cost=None if s2 is None else s2.cost, thresholds=dict(min_gap_nats=thresholds.min_gap_nats, min_evidence=thresholds.min_evidence))
    return TurnMatchResult(tuple(matches), amb, len(lib), lib.n_turns, q.N, time.perf_counter() - t0, params)


def match_candidates(query: TurnQuery, candidates: Sequence, params: TurnMatchParams = TurnMatchParams(),
                     thresholds: ConfidenceThresholds = ConfidenceThresholds(), top_k: int = 10, both_directions: bool = False) -> TurnMatchResult:
    """`candidates`: TurnPath objects or tuples `(id, s_m, theta_rad)` (arc length in metres, unwrapped heading, left positive).
    `both_directions`: also search every path reversed (ids get the suffix "~rev"; positions of a reversed hit count from the other end)."""
    paths = [c if isinstance(c, TurnPath) else TurnPath.from_theta(c[0], c[1], c[2]) for c in candidates]
    if both_directions:
        paths = paths + [p.reversed() for p in paths]
    return search(query, TurnLibrary(paths), params, thresholds, top_k)
