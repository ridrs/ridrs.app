# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.vote.run real <video> [F ...]            real runs (default: all hypotheses of the video)
   python -m rsm.vote.run decoy <video> <family> <s0> <s1> [F ...]
   python -m rsm.vote.run foreign <map_video> <video> ...    CONTROL: these videos' vms against the map of <map_video> (F = 449)
Heavy: run under tools/memguard.py, 4 workers (PROCS)."""
from __future__ import annotations

import sys

from . import cfg, stage

PROCS = 4


def main():
    cmd, video = sys.argv[1], sys.argv[2]
    env = stage.load_env(video)
    if cmd == "real":
        Fs = [float(x) for x in sys.argv[3:]] or cfg.hypotheses(video)
        for F in Fs:
            stage.run_one(env, video, F, "real", 0, procs=PROCS)
    elif cmd == "decoy":
        fam, s0, s1 = sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
        Fs = [float(x) for x in sys.argv[6:]] or [cfg.F_REF]
        for s in range(s0, s1):
            for F in Fs:
                stage.run_one(env, video, F, fam, s, procs=PROCS)
    elif cmd == "foreign":  # video = the map's video; the remaining arguments are the videos whose vms is matched against it
        for v in sys.argv[3:]:
            stage.run_foreign(env, v, video, cfg.F_REF, procs=PROCS)


if __name__ == "__main__":
    main()
