# SPDX-License-Identifier: AGPL-3.0-or-later
"""Decoy vms signals. A decoy changes the heading-rate / distance pairs of the usable vms segments BEFORE anything else reads them.

`rsm.odometry.heading.integrate` is wrapped at run time (module attribute, nothing on disk is edited). The pooled per-pair sequence
(omega = heading increment, ds = nominal metres, usable segments in time order) is cut into blocks of 2-5 km nominal distance; the time stamps,
the gaps and the segment structure stay where they are, only the (omega, ds) content moves or changes sign. Both consumers of the signal (the
quanta in `rsm.quanta.video.segments` and the tracks in `rsm.plaus.data.vms_tracks`) call `heading.integrate`, so they see the same decoy.

families
  mirror   every omega negated (the existing control)
  shuffle  blocks permuted (local statistics kept, long-range structure destroyed)
  flip     omega negated on random blocks (rejection rule: longest unflipped stretch <= 6 km, >= 30 % of the distance flipped)
  reverse  CONSISTENCY CHECK, not a decoy: pair order reversed and omega negated = the same road driven backwards
"""
from __future__ import annotations

import dataclasses
from contextlib import contextmanager

import numpy as np

from rsm.odometry import gating, heading

FAMILIES = ("mirror", "shuffle", "flip", "reverse")
BLOCK_M = (2000.0, 5000.0)
MAX_KEPT_M = 6000.0
MIN_FLIPPED = 0.3


def block_edges(ds: np.ndarray, rng: np.random.Generator, block_m=BLOCK_M) -> np.ndarray:
    """pair indices where blocks start (first 0), block length uniform in block_m nominal metres; a short last block is merged into the previous one"""
    cs = np.concatenate([[0.0], np.cumsum(ds)])
    total = cs[-1]
    cuts, pos = [0], 0.0
    while True:
        pos += rng.uniform(*block_m)
        if total - pos < block_m[0]:
            break
        cuts.append(int(np.searchsorted(cs, pos)))
    return np.unique(np.array(cuts + [len(ds)]))


def _blocks(ds, rng):
    e = block_edges(ds, rng)
    return [(int(a), int(b)) for a, b in zip(e[:-1], e[1:]) if b > a]


def transform(omega: np.ndarray, ds: np.ndarray, family: str, seed: int) -> tuple[np.ndarray, np.ndarray, dict]:
    """pooled (omega, ds) -> decoy (omega, ds, info)."""
    rng = np.random.default_rng(seed)
    n = len(omega)
    info = dict(family=family, seed=seed, n_pairs=n, km=float(ds.sum() / 1000.0))
    if family == "mirror":
        return -omega, ds.copy(), info
    if family == "reverse":
        return -omega[::-1].copy(), ds[::-1].copy(), info
    blocks = _blocks(ds, rng)
    info["n_blocks"] = len(blocks)
    if family == "shuffle":
        for _ in range(200):
            perm = rng.permutation(len(blocks))
            if len(blocks) < 2 or not np.array_equal(perm, np.arange(len(blocks))):
                break
        om = np.concatenate([omega[blocks[k][0]:blocks[k][1]] for k in perm])
        dd = np.concatenate([ds[blocks[k][0]:blocks[k][1]] for k in perm])
        info["perm"] = [int(k) for k in perm]
        return om, dd, info
    if family == "flip":
        bl_m = np.array([ds[a:b].sum() for a, b in blocks])
        for _ in range(10000):
            fl = rng.random(len(blocks)) < 0.5
            if bl_m[fl].sum() < MIN_FLIPPED * bl_m.sum():
                continue
            run = best = 0.0
            for f, m in zip(fl, bl_m):
                run = 0.0 if f else run + m
                best = max(best, run)
            if best <= MAX_KEPT_M:
                break
        om = omega.copy()
        for f, (a, b) in zip(fl, blocks):
            if f:
                om[a:b] = -om[a:b]
        info["flipped"] = [bool(x) for x in fl]
        info["kept_longest_km"] = float(best / 1000.0)
        info["flipped_share"] = float(bl_m[fl].sum() / bl_m.sum())
        return om, ds.copy(), info
    raise ValueError(family)


class Decoy:
    """context manager: while active, heading.integrate returns the decoy's theta and s. Deterministic for (family, seed)."""

    def __init__(self, family: str, seed: int = 0):
        assert family in FAMILIES
        self.family, self.seed = family, seed
        self._cache: dict = {}
        self.info: dict = {}
        self._orig = None

    def _prepare(self, p, flags, f360, kw):
        key = (len(p), float(p.time[0]), float(p.time[-1]), float(f360), kw.get("dist_scale", 1.0), int(np.count_nonzero(flags)))
        if key in self._cache:
            return self._cache[key]
        segs = [s for s in gating.build_segments(p, flags, gating.GateParams()) if s.usable]
        trs = [self._orig(p, s, flags, f360, **kw) for s in segs]
        om = np.concatenate([np.diff(t.theta) for t in trs])
        ds = np.concatenate([np.diff(t.s) for t in trs])
        om2, ds2, info = transform(om, ds, self.family, self.seed)
        self.info = info
        out, k = {}, 0
        for s, t in zip(segs, trs):
            n = len(t.theta) - 1
            out[(s.i0, s.i1)] = dataclasses.replace(t, theta=np.concatenate([[0.0], np.cumsum(om2[k:k + n])]), s=np.concatenate([[0.0], np.cumsum(ds2[k:k + n])]))
            k += n
        self._cache[key] = out
        return out

    @contextmanager
    def active(self):
        self._orig = orig = heading.integrate

        def wrapped(p, seg, flags, f360, *a, **kw):
            if a:
                return orig(p, seg, flags, f360, *a, **kw)
            tab = self._prepare(p, flags, f360, kw)
            return tab.get((seg.i0, seg.i1)) or orig(p, seg, flags, f360, **kw)

        heading.integrate = wrapped
        try:
            yield self
        finally:
            heading.integrate = orig
