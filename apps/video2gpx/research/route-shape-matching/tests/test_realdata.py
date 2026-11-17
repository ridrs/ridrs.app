# SPDX-License-Identifier: AGPL-3.0-or-later
"""Real-data checks. Skipped when the files are absent. The GPX is a test fixture only."""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

from rsm.bench.gpx import GPX_SIGMA_S, gpx_window, load_gpx_local
from rsm.core.trajectory import RelativeTrajectory
from rsm.io import road_reconstruction

pytestmark = pytest.mark.realdata

# GPX-free routes (camera poses of Van Gestel rides) in the git-ignored test-data/ of this app; the GPX from the Van Gestel catalog of this repository
ROUTES = Path(__file__).resolve().parents[3] / "test-data" / "road-reconstruction" / "routes"
CATALOG = Path(__file__).resolve().parents[5] / "plugins" / "video-source-vangestel" / "catalog"
CASES = {
    "pennes-9140-nogpx": CATALOG / "col-de-pennes" / "package" / "FR_Col_de_Pennes.gpx",
    "menglonnais-240-nogpx": CATALOG / "le-petit-menglonnais" / "package" / "FR_Le_petit_Menglonnais.gpx",
}
# Heading-change profile: both curves smoothed with SHAPE_SIGMA_M, resampled to N_BINS+1 points
# equally spaced in arc length; profile = heading change per bin. GPX smoothed with sigma 4 s as in
# road-reconstruction alignment.gpx_distance. Chosen before looking at the thresholds below, then
# checked on a small grid (sigma 5/10 m, 10/20/40 bins): see FINDINGS.
SHAPE_SIGMA_M = 5.0
N_BINS = 20
# Per-route lower bounds on the correlation, set below the measured values (see FINDINGS).
MIN_CORR = {"pennes-9140-nogpx": 0.25, "menglonnais-240-nogpx": 0.7}


def need(route: str) -> Path:
    if not (ROUTES / route / "metadata" / "cameras.json").exists():
        pytest.skip(f"{ROUTES / route} missing: create it with the GPX-free alignment run (README, 'GPX-free routes')")
    return ROUTES / route


def need_gpx(route: str) -> Path:
    if not CASES[route].exists():
        pytest.skip(f"{CASES[route]} missing")
    return CASES[route]


def heading_change_profile(tr: RelativeTrajectory) -> np.ndarray:
    s = tr.smooth(SHAPE_SIGMA_M).resample_n(N_BINS + 1)
    d = np.diff(s.points, axis=0)
    return np.diff(np.unwrap(np.arctan2(d[:, 1], d[:, 0])))


@pytest.mark.parametrize("route", CASES)
def test_adapter_loads_gpx_free_route(route):
    tr = road_reconstruction.load(need(route))
    assert tr.metadata["gpx_free"] is True
    assert all("unreliable" in w for w in tr.warnings)  # the only allowed warning: z with the trajectory-plane fallback
    assert tr.metadata["z_reliable"] is (tr.metadata["up_method"] == "vertical lines")
    assert tr.metadata["scale_source"] == "camera_height" and tr.metadata["up_method"] != "GPX elevation profile"
    assert len(tr) > 100 and tr.length > 100 and tr.t is not None and np.all(np.diff(tr.t) > 0)
    print(f"\n[{route}] points={len(tr)} length={tr.length:.1f} m up_method={tr.metadata['up_method']!r} "
          f"scale_source={tr.metadata['scale_source']!r} total_turn={math.degrees(tr.total_turn()):+.1f} deg")


@pytest.mark.parametrize("route", CASES)
def test_handedness_matches_gpx(route):
    tr = road_reconstruction.load(need(route))
    g = load_gpx_local(need_gpx(route))
    gt = gpx_window(g, tr.t[0], tr.t[-1])

    turn_r, turn_g = tr.total_turn(1.0), gt.total_turn(1.0)
    assert turn_r * turn_g > 0, f"total turn sign differs: recon {turn_r:.2f} rad, gpx {turn_g:.2f} rad"
    ratio = turn_r / turn_g
    assert 0.4 < ratio < 2.5, f"total turn magnitude differs: ratio {ratio:.2f}"

    pr, pg = heading_change_profile(tr), heading_change_profile(gt)
    corr = float(np.corrcoef(pr, pg)[0, 1])
    corr_mirror = float(np.corrcoef(heading_change_profile(tr.mirrored()), pg)[0, 1])
    # control: the same reconstruction against GPX windows shifted away in time (same road, other place)
    shifted = []
    for dt in (-300, -200, -120, 120, 200, 300):
        if tr.t[0] + dt >= 0 and tr.t[-1] + dt <= g[-1, 0]:
            shifted.append(float(np.corrcoef(pr, heading_change_profile(gpx_window(g, tr.t[0] + dt, tr.t[-1] + dt)))[0, 1]))
    print(f"\n[{route}] total turn recon {math.degrees(turn_r):+.1f} deg, gpx {math.degrees(turn_g):+.1f} deg, ratio {ratio:.2f}; "
          f"heading-change corr {corr:.3f}, mirrored {corr_mirror:.3f}, time-shifted GPX windows mean {np.mean(shifted):+.3f} max {np.max(shifted):+.3f}")
    assert corr > MIN_CORR[route]
    assert corr - corr_mirror > 0.5
    assert corr > np.max(shifted)


@pytest.mark.parametrize("route", CASES)
def test_report_scale_bias(route):
    """Reported, not tightly asserted: GPX-free length vs the GPX length over the same window."""
    tr = road_reconstruction.load(need(route))
    g = load_gpx_local(need_gpx(route))
    gl = gpx_window(g, tr.t[0], tr.t[-1]).length
    gpx_version = road_reconstruction.load(ROUTES / route.removesuffix("-nogpx")) if (ROUTES / route.removesuffix("-nogpx") / "route.json").exists() else None
    line = f"\n[{route}] GPX-free length {tr.length:.1f} m, GPX length {gl:.1f} m (sigma {GPX_SIGMA_S} s), ratio {tr.length / gl:.3f}"
    if gpx_version is not None:
        line += f"; GPX-scaled reconstruction {gpx_version.length:.1f} m, scale ratio nogpx/gpx {tr.length / gpx_version.length:.3f}"
    print(line)
    assert 0.5 < tr.length / gl < 2.0  # sanity only


@pytest.mark.parametrize("route", CASES)
def test_calibration_measures_the_real_pair(route):
    """The error-model measurement runs on the real pair (numbers are printed; the assertions are sanity bounds only)."""
    from rsm.bench import calibrate

    tr = road_reconstruction.load(need(route))
    g = load_gpx_local(need_gpx(route))
    pad = 0.15 * (tr.t[-1] - tr.t[0])
    m = calibrate.measure_pair(tr, gpx_window(g, tr.t[0] - pad, tr.t[-1] + pad))
    print(f"\n[{route}] fit scale {m['fit']['scale']:.3f} (1/scale {m['fit']['inverse_scale']:.3f}), crosstrack rms {m['residual']['crosstrack_rms_m']:.1f} m "
          f"max {m['residual']['crosstrack_max_m']:.1f} m, heading drift {m['heading_drift']['slope_deg_per_100m']:+.2f} deg/100 m, "
          f"corr length {m['smoothness']['corr_length_m']:.0f} m, gpx points in window {m['n_gpx_points_in_window']}")
    assert 0.7 <= m["fit"]["scale"] <= 1.4 and m["residual"]["crosstrack_rms_m"] < 0.2 * tr.length
