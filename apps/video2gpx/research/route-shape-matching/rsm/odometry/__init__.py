# SPDX-License-Identifier: AGPL-3.0-or-later
"""Heading and distance from the per-frame-pair output of `vms motion` (video-motion-speed): gating, segments, heading over
distance, turn detection and a dead-reckoned relative trajectory. numpy / scipy / stdlib only; does not import vms."""
from .calib import NOMINAL, Calibration, Nominal, load_calibration
from .gating import GateParams, Segment, build_segments, pair_flags
from .heading import SegmentTrack, dead_reckon, integrate
from .turns import Turn, TurnParams, detect_turns
from .vms_csv import Pairs, load_pairs
