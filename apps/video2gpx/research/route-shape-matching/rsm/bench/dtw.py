# SPDX-License-Identifier: AGPL-3.0-or-later
"""DTW as an OPTIONAL benchmark metric (not part of `rsm.core`): `dtaidistance.dtw_ndim`, squared-Euclidean local cost.

Normalised per point: sqrt(sum over the optimal warping path of d^2) / sqrt(max(N, M)) (metres); equals the RMSE when
the diagonal is the optimal path, otherwise smaller. Verified against an O(NM) reference in the tests. Local stretching
along the path is ignored; it is an L2 statistic like RMSE.

`dtaidistance` is optional (requirements-bench.txt). Its macOS wheel links /usr/local/lib/libomp.dylib; where that is
missing the C code does not load and the pure-Python path is ~700 times slower (31 ms vs 0.04 ms per 128 points), so
`available()` is False and the benchmark skips the metric with a printed note. Nothing here re-executes the process; on
Homebrew/Apple silicon you may export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/opt/libomp/lib yourself.
"""
from __future__ import annotations

import contextlib
import io
import math

from ..core.geometry import as_points

try:  # dtaidistance prints a long diagnostic at import when its C code does not load
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from dtaidistance import dtw as _dtw
        from dtaidistance import dtw_ndim

        C_AVAILABLE = bool(_dtw.try_import_c(verbose=False))
    IMPORTABLE = True
except Exception:  # not installed
    IMPORTABLE = C_AVAILABLE = False


def available() -> bool:
    """dtaidistance importable AND its C code loaded (otherwise too slow for the benchmark)."""
    return IMPORTABLE and C_AVAILABLE


def dtw(a, b, use_c: bool | None = None) -> float:
    """Per-point-normalised DTW in metres. `use_c=None`: C if it loads, else pure Python."""
    if not IMPORTABLE:
        raise ImportError("dtaidistance is not installed (requirements-bench.txt)")
    a, b = as_points(a, "a"), as_points(b, "b")
    c = C_AVAILABLE if use_c is None else use_c
    return float(dtw_ndim.distance(a, b, use_c=c) / math.sqrt(max(len(a), len(b))))


def extra_metrics() -> tuple:
    """`MatchOptions.extra_metrics` value: DTW if available, else empty (with no output; the benchmark prints the note once)."""
    return (("dtw", dtw),) if available() else ()
