# SPDX-License-Identifier: AGPL-3.0-or-later
"""Worker and memory policy of this machine: how many heavy workers, which memory budget (one budget for everything that runs at the same time)."""
from __future__ import annotations

import os
import subprocess

from . import config as C

#: one fused analysis worker (Python + ffmpeg) is counted with this much memory
GB_PER_WORKER = 1.0
#: budget of the video analysis when the map prewarm runs beside it (measured peak 1.6 GB); the prewarm gets the rest
ANALYSIS_GB = 3.0
#: below this total budget the prewarm does not run beside the analysis (measured map peak 8.0 GB)
CONCURRENT_MIN_GB = 8.0
#: the prewarm's guard stops it this many percent of free memory before the guard of a step would stop the step
PREWARM_FREE_MARGIN = 5.0


def _sysctl(name: str) -> int | None:
    try:
        return int(subprocess.run(["sysctl", "-n", name], capture_output=True, text=True, timeout=5).stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def machine() -> tuple[int, float]:
    """(performance cores, RAM in GB)"""
    perf = _sysctl("hw.perflevel0.physicalcpu") or max(1, (os.cpu_count() or 2) // 2)
    mem = _sysctl("hw.memsize")
    if mem is None:
        try:
            mem = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        except (ValueError, OSError):
            mem = 8 * 2 ** 30
    return int(perf), mem / 2 ** 30


def policy(perf_cores: int | None = None, ram_gb: float | None = None, env: dict | None = None) -> dict:
    """{workers, max_gb, min_free, perf_cores, ram_gb}. workers never exceeds C.MAX_WORKERS; RSM_MAX_WORKERS=n lowers it."""
    env = os.environ if env is None else env
    if perf_cores is None or ram_gb is None:
        pc, rg = machine()
        perf_cores, ram_gb = perf_cores or pc, ram_gb or rg
    workers = min(perf_cores - 2, int((0.33 * ram_gb - 2) / GB_PER_WORKER))
    try:
        workers = min(workers, int(env["RSM_MAX_WORKERS"]))
    except (KeyError, ValueError):
        pass
    workers = max(1, min(workers, C.MAX_WORKERS))
    return dict(workers=workers, max_gb=round(min(C.MEMGUARD["max_gb"], 0.4 * ram_gb), 1), min_free=C.MEMGUARD["min_free"], perf_cores=int(perf_cores), ram_gb=round(ram_gb, 1))


def budgets(pol: dict | None = None) -> dict:
    """{step_gb, concurrent, analysis_gb, prewarm_gb, prewarm_min_free}: the guard limits. While the prewarm runs beside the analysis the two limits add up to max_gb."""
    pol = pol or policy()
    conc = pol["max_gb"] >= CONCURRENT_MIN_GB
    return dict(step_gb=pol["max_gb"], concurrent=conc, analysis_gb=ANALYSIS_GB if conc else pol["max_gb"], prewarm_gb=round(pol["max_gb"] - ANALYSIS_GB, 1) if conc else pol["max_gb"],
                prewarm_min_free=pol["min_free"] + PREWARM_FREE_MARGIN)
