# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.pipeline.freeze : write rsm/pipeline/frozen.json (configuration + code hash of every module the pipeline uses)."""
import json
import sys
from pathlib import Path

from . import VERSION, config as C
from .common import code_hash

CONFIG_KEYS = ["STEPS", "MAX_WORKERS", "MEMGUARD", "HMM_CAP_GB", "VMS", "F360", "CAMERA_H", "F_REF", "F_FAR", "FAR", "F_LO", "F_HI", "N_F", "K_LO", "K_HI", "N_K", "H", "D0", "REFINE_K", "REFINE_F",
               "N_FOREIGN", "N_SHUFFLE", "SEED0", "DENSITY_WINDOW", "DENSITY_RELAX", "GAP_BOXES", "CLASSES_MOTOR", "CLASSES_BIKE", "OFFSET_M", "OFFSET_SMOOTH_M", "OFFSET_MAX_FRAC",
               "VERDICT_CONFIDENT_MARGIN", "COVERAGE", "BIKE_YAW_NOISE", "YAW_RATIO", "PEAK_FLAT", "AREA_RATIO",
               "START_TOL_M", "FRAME_COST_NATS_PER_M", "HINT_BUFFER_M", "HINT_COST_FREE_M", "HINT_COST_NATS_PER_KM_PER_M", "HINT_COST_MAX_NATS_PER_KM", "F_EXT", "K_EXT", "EXT_STEPS", "EXT_MAX",
               "LOCAL_ON", "LOCAL_BUF_M", "LOCAL_D0", "LOCAL_EXTRA", "LOCAL_SAME_M", "LOCAL_MINOR_NATS_PER_KM", "GAP_MEASURED_SHARE",
               "ALIGN_ON", "ALIGN_DS", "ALIGN_SMOOTH_M", "ALIGN_REL", "ALIGN_SIG0_DEG", "ALIGN_BETA", "ALIGN_NU", "ALIGN_VMAX", "ALIGN_MEAS_SD_M", "ALIGN_MEAS_EVERY_M",
               "ALIGN_MAX_DEV_M", "ALIGN_TURN_DEG", "ALIGN_TURN_HALF_M", "ALIGN_MEAS_MODE", "ALIGN_MEAS_MODES", "ALIGN_POST_BAND_M", "ALIGN_POST_FLOOR_M", "ALIGN_POST_INFL", "ALIGN_POST_MAX_SD_M", "ALIGN_POST_GATE_M", "POST_STRAIGHT_EVERY_M", "POST_STRAIGHT_INFL",
               "BIKE_PATHS_ON", "BIKE_PATHS_FALLBACK", "BIKE_PATHS_MODES", "BIKE_PATH_RULES", "BIKE_SERVICE_UNTAGGED", "CAL_VMAX", "CAL_VMAX_BIKE", "K_GRID_BIKE",
               "CUT_ON", "CUT_IMPULSE", "CUT_INL_SHARE", "CUT_STRONG_IMPULSE", "CUT_STRONG_FACTOR", "CUT_STRONG_MIN_DIFF", "CUT_STRONG_AROUND", "CUT_STRONG_NB_SHARE", "CUT_MERGE_S", "CUT_MIN_PIECE_S", "CUT_INTRO_S", "CUT_JUMP_M", "CUT_PRIOR_SD_M", "CUT_PRIOR_SD_SOFT_M", "CUT_FUSE_SD_M", "CUT_SAME_ON", "CUT_SAME_SHARE", "CUT_SAME_WIN_S", "CUT_SAME_H",
               "ODO_FAIL_ON", "ODO_FAIL_USABLE", "ODO_FAIL_WIN_S", "ODO_FAIL_MIN_S", "ODO_FAIL_MERGE_S", "ODO_NB_S", "ODO_GAP_MU_X", "ODO_GAP_REL", "ODO_GAP_UPPER",
               "GAP_SYS_REL", "ODO_LOW_USABLE", "ODO_LOW_WIN_S", "ODO_LOW_REL", "TRUNC_MIN_S", "TRUNC_FRAC", "VERDICT_MOTOR_POST", "VEH_K_MOTOR", "VEH_V90_MOTOR", "VEH_K_BIKE", "VEH_V90_BIKE", "VERDICT_MOTOR_SAME",
               "LOCAL_EXT_CLASSES_MOTOR", "LOCAL_EXT_CLASSES_BIKE", "LOCAL_EXT_MIN_S", "LOCAL_EXT_BUF_M", "LOCAL_EXT_NATS_PER_KM",
               "LOCAL_ISL_ON", "LOCAL_ISL_CONF", "LOCAL_ISL_USABLE", "LOCAL_ISL_MIN_LM", "LOCAL_ISL_CURVE_M", "LOCAL_ISL_CURVE_DEG", "LOCAL_ISL_REACH_X", "LOCAL_ISL_REACH_MAX_M",
               "LOCAL_ISL_K", "LOCAL_ISL_ALT_WIN", "LOCAL_ISL_SHAPE_REL", "LOCAL_ISL_SCALES", "LOCAL_ISL_SCALE_SD"]


def main():
    h, files = code_hash()
    cfg = {k.lower(): getattr(C, k) for k in CONFIG_KEYS}
    cfg["f_grid"] = list(C.F_GRID); cfg["k_grid"] = list(C.K_GRID)
    out = dict(version=VERSION, code_hash=h, modules=files, config=cfg,
               provisional=["VERDICT_CONFIDENT_MARGIN", "COVERAGE", "BIKE_YAW_NOISE", "YAW_RATIO", "PEAK_FLAT", "AREA_RATIO", "vehicle votes"],
               note="thresholds marked provisional come from the development videos only (Grimone, Roanne, Rousset, Amalfi); to be calibrated on the blind test")
    f = Path(__file__).with_name("frozen.json")
    f.write_text(json.dumps(out, indent=1, default=list))
    print(f"wrote {f}: {len(files)} modules, code hash {h}")


if __name__ == "__main__":
    sys.exit(main())
