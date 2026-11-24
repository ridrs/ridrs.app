# SPDX-License-Identifier: AGPL-3.0-or-later
"""Optional native C / 4-wide SIMD (ARM NEON + x86_64 SSE2/FMA) backend for rsm.hmm_cal.dp (falls back transparently to NumPy when absent or RSM_NO_NATIVE=1)."""
from __future__ import annotations

import ctypes
import dataclasses
import os
import platform
from pathlib import Path

import numpy as np

NEG = np.float32(-np.inf)


class _GroupBase(ctypes.Structure):
    _fields_ = [
        ("n", ctypes.c_int32), ("n_ud", ctypes.c_int32),
        ("src", ctypes.c_void_p), ("D", ctypes.c_void_p), ("dphi", ctypes.c_void_p),
        ("w", ctypes.c_void_p), ("starts", ctypes.c_void_p), ("ud", ctypes.c_void_p),
        ("loc", ctypes.c_void_p),
        ("d_min", ctypes.c_float), ("d_max", ctypes.c_float),
        ("utf", ctypes.c_void_p),
    ]


class _GroupBack(ctypes.Structure):
    _fields_ = [
        ("n", ctypes.c_int32), ("n_us", ctypes.c_int32),
        ("b_dst", ctypes.c_void_p), ("b_D", ctypes.c_void_p), ("b_dphi", ctypes.c_void_p),
        ("b_w", ctypes.c_void_p), ("b_starts", ctypes.c_void_p), ("b_us", ctypes.c_void_p),
        ("d_min", ctypes.c_float), ("d_max", ctypes.c_float),
        ("b_utf", ctypes.c_void_p),
    ]


class _Batch4Job(ctypes.Structure):
    _fields_ = [
        ("N", ctypes.c_int32), ("T", ctypes.c_int32), ("n_groups", ctypes.c_int32),
        ("groups", ctypes.POINTER(_GroupBase)),
        ("ls4", ctypes.POINTER(ctypes.c_void_p)), ("is2_4", ctypes.POINTER(ctypes.c_void_p)),
        ("mus", ctypes.c_void_p), ("sds", ctypes.c_void_p),
        ("has_dth", ctypes.c_void_p), ("dths4", ctypes.c_void_p),
        ("c1", ctypes.c_float),
        ("start_init", ctypes.c_void_p), ("end_lp", ctypes.c_void_p),
        ("n_step_ok", ctypes.c_int32), ("step_ok_steps", ctypes.c_void_p),
        ("step_ok_masks", ctypes.POINTER(ctypes.c_void_p)),
        ("out_scores", ctypes.c_float * 4),
        ("ute4", ctypes.c_void_p),
        ("is_jump", ctypes.c_void_p),
    ]


def _bind(p: Path):
    lib = ctypes.CDLL(str(p))
    lib.viterbi_scan_batches.argtypes = [ctypes.c_int32, ctypes.c_int32, ctypes.POINTER(_Batch4Job)]
    lib.viterbi_scan_batches.restype = None
    lib.viterbi_single.argtypes = [
        ctypes.c_int32, ctypes.c_int32, ctypes.c_int32, ctypes.POINTER(_GroupBase),
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_float, ctypes.c_int32,
        ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_int32), ctypes.c_void_p,
        ctypes.c_void_p, ctypes.c_void_p,
    ]
    lib.viterbi_single.restype = ctypes.c_float
    lib.fb_forward_step.argtypes = [
        ctypes.c_int32, ctypes.c_int32, ctypes.POINTER(_GroupBase),
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_float, ctypes.c_float, ctypes.c_int32, ctypes.c_float, ctypes.c_float, ctypes.c_float,
    ]
    lib.fb_forward_step.restype = None
    lib.fb_backward_step.argtypes = [
        ctypes.c_int32, ctypes.c_int32, ctypes.POINTER(_GroupBack),
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_float, ctypes.c_float, ctypes.c_int32, ctypes.c_float, ctypes.c_float, ctypes.c_float,
    ]
    lib.fb_backward_step.restype = None
    return lib


def _load():
    if os.environ.get("RSM_NO_NATIVE") == "1":
        return None
    here = Path(__file__).resolve().parent
    arch = platform.machine().lower()
    candidates = [here / f"_dp_native_{arch}.so", here / "_dp_native.so"]
    for p in candidates:
        if not p.is_file():
            continue
        try:
            return _bind(p)
        except OSError:
            continue
    return None


LIB = _load()


def available() -> bool:
    return LIB is not None


def _utf(ut, on: bool):
    """float 0/1 view of a Group's U-turn flags for the C kernels, or None (no flags, none set, or the U-turn cost is off)"""
    if not on or ut is None or not np.any(ut):
        return None
    return np.ascontiguousarray(ut, np.float32)


def _pack_groups(grid, locs=None, ut: bool = False):
    n_g = len(grid.groups)
    arr = (_GroupBase * n_g)()
    refs = []
    for gi, gr in enumerate(grid.groups):
        src = np.ascontiguousarray(gr.src, np.int32)
        D = np.ascontiguousarray(gr.D, np.float32)
        dphi = np.ascontiguousarray(gr.dphi, np.float32)
        w = np.ascontiguousarray(gr.w, np.float32)
        starts = np.ascontiguousarray(gr.starts, np.int64)
        ud = np.ascontiguousarray(gr.ud, np.int32)
        loc = np.ascontiguousarray(locs[gi], np.uint16) if locs is not None else None
        utf = _utf(getattr(gr, "ut", None), ut)
        refs.append((src, D, dphi, w, starts, ud, loc, utf))
        dmin = float(getattr(gr, "d_min", D.min() if len(D) else 0.0)) if gr.n else 0.0
        dmax = float(getattr(gr, "d_max", D.max() if len(D) else 0.0)) if gr.n else 0.0
        arr[gi] = _GroupBase(
            gr.n, len(ud),
            src.ctypes.data, D.ctypes.data, dphi.ctypes.data, w.ctypes.data,
            starts.ctypes.data, ud.ctypes.data,
            loc.ctypes.data if loc is not None else 0,
            dmin, dmax,
            utf.ctypes.data if utf is not None else 0,
        )
    return arr, refs


def _pack_groups_back(grid, ut: bool = False):
    n_g = len(grid.groups)
    arr = (_GroupBack * n_g)()
    refs = []
    for gi, gr in enumerate(grid.groups):
        b_dst = np.ascontiguousarray(gr.b_dst, np.int32)
        b_D = np.ascontiguousarray(gr.b_D, np.float32)
        b_dphi = np.ascontiguousarray(gr.b_dphi, np.float32)
        b_w = np.ascontiguousarray(gr.b_w, np.float32)
        b_starts = np.ascontiguousarray(gr.b_starts, np.int64)
        b_us = np.ascontiguousarray(gr.b_us, np.int32)
        b_utf = _utf(getattr(gr, "b_ut", None), ut)
        refs.append((b_dst, b_D, b_dphi, b_w, b_starts, b_us, b_utf))
        dmin = float(getattr(gr, "d_min", b_D.min() if len(b_D) else 0.0)) if gr.n else 0.0
        dmax = float(getattr(gr, "d_max", b_D.max() if len(b_D) else 0.0)) if gr.n else 0.0
        arr[gi] = _GroupBack(
            gr.n, len(b_us),
            b_dst.ctypes.data, b_D.ctypes.data, b_dphi.ctypes.data, b_w.ctypes.data,
            b_starts.ctypes.data, b_us.ctypes.data,
            dmin, dmax,
            b_utf.ctypes.data if b_utf is not None else 0,
        )
    return arr, refs


def _pack_step_ok(step_ok: dict | None, N: int):
    if not step_ok:
        return 0, None, None, []
    items = [(int(j), np.ascontiguousarray(m, np.uint8)) for j, m in step_ok.items() if j > 0]
    if not items:
        return 0, None, None, []
    steps = np.array([j for j, _ in items], np.int32)
    ptrs = (ctypes.c_void_p * len(items))(*(m.ctypes.data for _, m in items))
    return len(items), steps, ptrs, [m for _, m in items]


def _step_arrays(par, floor: float, st):
    T = st.T
    mus = np.zeros(T, np.float32)
    sds = np.zeros(T, np.float32)
    has_dth = np.zeros(T, np.int32)
    for j in range(1, T):
        mu = par.kappa * st.mu[j] * (1.0 + par.b_speed * max(st.v[j] - 3.0, 0.0))
        sd = np.sqrt((max(par.rel, st.rel[j]) * mu) ** 2 + floor ** 2)
        mus[j] = mu
        sds[j] = sd
        has_dth[j] = 0 if np.isnan(st.dth[j]) else 1
    return mus, sds, has_dth


def _init_end_arrays(N: int, start_ok, end_ok, step_ok, s_lp, e_lp):
    a0 = np.zeros(N, np.float32) if start_ok is None else np.where(start_ok, np.float32(0), NEG).astype(np.float32)
    if step_ok and 0 in step_ok:
        a0 = np.where(step_ok[0], a0, NEG).astype(np.float32)
    if s_lp is not None:
        a0 = (a0 + s_lp).astype(np.float32)
    a0 = np.ascontiguousarray(a0, np.float32)
    end_arr = None
    if end_ok is not None or e_lp is not None:
        end_arr = np.zeros(N, np.float32) if end_ok is None else np.where(end_ok, np.float32(0), NEG).astype(np.float32)
        if e_lp is not None:
            end_arr = (end_arr + e_lp).astype(np.float32)
        end_arr = np.ascontiguousarray(end_arr, np.float32)
    return a0, end_arr


def viterbi_scan(grid, base_par, st, a_angs, start_ok=None, end_ok=None, step_ok=None, s_lp=None, e_lp=None, threads: int = 3) -> np.ndarray:
    """score (including Jacobian, without (T-1)*log(kappa)) for every a_ang in a_angs using 4-wide NEON batches across pthreads"""
    from . import dp as _dp
    n_f = len(a_angs)
    if n_f == 0:
        return np.zeros(0, np.float64)
    N, T, n_g = grid.N, st.T, len(grid.groups)
    floor = base_par.floor_frac * grid.h
    ut_on = base_par.ut_extra > 0
    gbases, grefs = _pack_groups(grid, ut=ut_on)
    mus, sds, has_dth = _step_arrays(base_par, floor, st)
    a0, end_arr = _init_end_arrays(N, start_ok, end_ok, step_ok, s_lp, e_lp)
    n_so, so_steps, so_ptrs, so_refs = _pack_step_ok(step_ok, N)

    padded = list(a_angs)
    while len(padded) % 4 != 0:
        padded.append(padded[-1])
    nb = len(padded) // 4
    jobs = (_Batch4Job * nb)()
    is_jump = np.ascontiguousarray(st.jump, np.uint8) if getattr(st, "jump", None) is not None else None
    refs = [grefs, mus, sds, has_dth, a0, end_arr, so_steps, so_ptrs, so_refs, is_jump]
    dth_clean = np.nan_to_num(st.dth, nan=0.0).astype(np.float64)
    n_emit = int(np.count_nonzero(~np.isnan(st.dth[1:])))
    c1 = np.float32((base_par.nu + 1) / 2)

    for bi in range(nb):
        sub = padded[bi * 4:(bi + 1) * 4]
        ls4_list, is2_list = [], []
        for gr in grid.groups:
            dp64 = gr.dphi.astype(np.float64)
            ls_cols, is2_cols = [], []
            for a_ang in sub:
                sd = np.sqrt((a_ang * base_par.sv) ** 2 + base_par.sig0 ** 2 + (base_par.beta * dp64) ** 2)
                ls_cols.append((-np.log(sd)).astype(np.float32))
                is2_cols.append((1.0 / (sd ** 2 * base_par.nu)).astype(np.float32))
            ls4_list.append(np.ascontiguousarray(np.stack(ls_cols, axis=-1), np.float32))
            is2_list.append(np.ascontiguousarray(np.stack(is2_cols, axis=-1), np.float32))
        ls4_ptrs = (ctypes.c_void_p * n_g)(*(x.ctypes.data for x in ls4_list))
        is2_ptrs = (ctypes.c_void_p * n_g)(*(x.ctypes.data for x in is2_list))
        dths4 = np.ascontiguousarray(np.stack([(dth_clean * a_ang).astype(np.float32) for a_ang in sub], axis=-1), np.float32)
        # the U-turn cost depends on the video heading range, which scales with a_ang: one column per lane (dp.ut_cost)
        ute4 = np.ascontiguousarray(np.stack([_dp.ut_cost(dataclasses.replace(base_par, a_ang=float(a_ang)), st) for a_ang in sub], axis=-1), np.float32) if ut_on else None
        refs.extend([ls4_list, is2_list, ls4_ptrs, is2_ptrs, dths4, ute4])
        jobs[bi] = _Batch4Job(
            N, T, n_g, gbases, ls4_ptrs, is2_ptrs,
            mus.ctypes.data, sds.ctypes.data, has_dth.ctypes.data, dths4.ctypes.data,
            float(c1),
            a0.ctypes.data, end_arr.ctypes.data if end_arr is not None else 0,
            n_so, so_steps.ctypes.data if so_steps is not None else 0,
            so_ptrs if so_ptrs is not None else ctypes.POINTER(ctypes.c_void_p)(),
            (ctypes.c_float * 4)(),
            ute4.ctypes.data if ute4 is not None else 0,
            is_jump.ctypes.data if is_jump is not None else 0,
        )
    LIB.viterbi_scan_batches(nb, max(1, int(threads)), jobs)
    out = np.empty(n_f, np.float64)
    for i in range(n_f):
        raw = float(jobs[i // 4].out_scores[i % 4])
        out[i] = float("-inf") if not np.isfinite(raw) else raw + float(n_emit * np.log(a_angs[i]))
    return out


def viterbi_one(pre, st, backptr: bool = False, start_ok=None, end_ok=None, step_ok=None, s_lp=None, e_lp=None) -> dict:
    grid, par = pre.grid, pre.par
    N, T, n_g = grid.N, st.T, len(grid.groups)
    from . import dp as _dp
    ut_on = par.ut_extra > 0
    gbases, grefs = _pack_groups(grid, pre.loc if backptr else None, ut=ut_on)
    utes = np.ascontiguousarray(_dp.ut_cost(par, st), np.float32) if ut_on else None
    ls_arrs = [np.ascontiguousarray(x, np.float32) for x in pre.ls]
    is2_arrs = [np.ascontiguousarray(x, np.float32) for x in pre.is2]
    ls_ptrs = (ctypes.c_void_p * n_g)(*(x.ctypes.data for x in ls_arrs))
    is2_ptrs = (ctypes.c_void_p * n_g)(*(x.ctypes.data for x in is2_arrs))
    mus, sds, has_dth = _step_arrays(par, pre.floor, st)
    dths = np.ascontiguousarray(np.nan_to_num(st.dth * par.a_ang, nan=0.0), np.float32)
    a0, end_arr = _init_end_arrays(N, start_ok, end_ok, step_ok, s_lp, e_lp)
    n_so, so_steps, so_ptrs, so_refs = _pack_step_ok(step_ok, N)
    is_jump = np.ascontiguousarray(st.jump, np.uint8) if getattr(st, "jump", None) is not None else None
    jump_src = np.full(T, -1, np.int32) if (backptr and is_jump is not None) else None
    bps = np.empty((max(0, T - 1), N), np.uint16) if backptr else None
    final_cell = ctypes.c_int32(-1)
    best = float(LIB.viterbi_single(
        N, T, n_g, gbases, ls_ptrs, is2_ptrs,
        mus.ctypes.data, sds.ctypes.data, has_dth.ctypes.data, dths.ctypes.data,
        float(pre.c1), int(par.slot_bits),
        a0.ctypes.data, end_arr.ctypes.data if end_arr is not None else 0,
        n_so, so_steps.ctypes.data if so_steps is not None else 0,
        so_ptrs if so_ptrs is not None else ctypes.POINTER(ctypes.c_void_p)(),
        bps.ctypes.data if bps is not None else 0,
        ctypes.byref(final_cell),
        utes.ctypes.data if utes is not None else 0,
        is_jump.ctypes.data if is_jump is not None else 0,
        jump_src.ctypes.data if jump_src is not None else 0,
    ))
    c = int(final_cell.value)
    if c < 0 or not np.isfinite(best):
        return dict(score=float("-inf"), final_cell=-1, cell_path=None)
    jac = float(np.count_nonzero(~np.isnan(st.dth[1:])) * np.log(par.a_ang))
    out = dict(score=best + jac, final_cell=c, cell_path=None)
    if backptr:
        path = np.empty(T, np.int64)
        path[-1] = c
        mask = (1 << par.slot_bits) - 1
        for j in range(T - 1, 0, -1):
            if jump_src is not None and jump_src[j] >= 0:
                c = int(jump_src[j])
                path[j - 1] = c
                continue
            cd = int(bps[j - 1, c])
            if cd == 65535:
                path[:j] = -1
                break
            gr = grid.groups[cd >> par.slot_bits]
            c = int(gr.src[gr.starts[gr.first[c]] + (cd & mask)])
            path[j - 1] = c
        out["cell_path"] = path
    return out


class FBContext:
    """pre-packed C views for fast forward-backward steps on a Prepared HMM"""

    def __init__(self, pre):
        grid = pre.grid
        n_g = len(grid.groups)
        self.N = grid.N
        self.n_g = n_g
        self.c1 = float(pre.c1)
        self.pre = pre                     # pre._ute: the extra U-turn cost of the current step, set by dp._step_terms right before every step
        ut_on = pre.par.ut_extra > 0
        self.gbases, self._frefs = _pack_groups(grid, ut=ut_on)
        self.gbacks, self._brefs = _pack_groups_back(grid, ut=ut_on)
        self._ls = [np.ascontiguousarray(x, np.float32) for x in pre.ls]
        self._is2 = [np.ascontiguousarray(x, np.float32) for x in pre.is2]
        self._bls = [np.ascontiguousarray(x, np.float32) for x in pre.b_ls]
        self._bis2 = [np.ascontiguousarray(x, np.float32) for x in pre.b_is2]
        self.ls_ptrs = (ctypes.c_void_p * n_g)(*(x.ctypes.data for x in self._ls))
        self.is2_ptrs = (ctypes.c_void_p * n_g)(*(x.ctypes.data for x in self._is2))
        self.bls_ptrs = (ctypes.c_void_p * n_g)(*(x.ctypes.data for x in self._bls))
        self.bis2_ptrs = (ctypes.c_void_p * n_g)(*(x.ctypes.data for x in self._bis2))
        self._buf = np.empty(self.N, np.float32)

    def forward_step(self, a: np.ndarray, mu: float, sd: float, dth) -> np.ndarray:
        a_c = np.ascontiguousarray(a, np.float32)
        LIB.fb_forward_step(
            self.N, self.n_g, self.gbases, self.ls_ptrs, self.is2_ptrs,
            a_c.ctypes.data, self._buf.ctypes.data,
            float(mu), float(sd), 0 if dth is None else 1, 0.0 if dth is None else float(dth), self.c1,
            float(getattr(self.pre, "_ute", 0.0)),
        )
        return self._buf

    def backward_step(self, beta: np.ndarray, mu: float, sd: float, dth) -> np.ndarray:
        b_c = np.ascontiguousarray(beta, np.float32)
        LIB.fb_backward_step(
            self.N, self.n_g, self.gbacks, self.bls_ptrs, self.bis2_ptrs,
            b_c.ctypes.data, self._buf.ctypes.data,
            float(mu), float(sd), 0 if dth is None else 1, 0.0 if dth is None else float(dth), self.c1,
            float(getattr(self.pre, "_ute", 0.0)),
        )
        return self._buf
