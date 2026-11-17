# SPDX-License-Identifier: AGPL-3.0-or-later
"""Run a command and kill its whole process group before it can exhaust the Mac's memory.

    python tools/memguard.py --max-gb 12 --min-free 20 -- <command> [args...]

Every 2 s it sums the resident memory of the command's process group (ps) and reads the system-wide free
percentage (memory_pressure). If the group exceeds --max-gb, or free memory drops below --min-free percent,
the group gets SIGTERM, then SIGKILL after 5 s, and memguard exits with code 137 and a message on stderr.
Stdlib only; macOS (memory_pressure) with a Linux fallback (/proc/meminfo).
"""
from __future__ import annotations

import argparse
import os
import re
import signal
import subprocess
import sys
import time


def group_rss_gb(pgid: int) -> float:
    out = subprocess.run(["ps", "-A", "-o", "rss=,pgid="], capture_output=True, text=True).stdout
    kb = 0
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == str(pgid):
            kb += int(parts[0])
    return kb / 1024 / 1024


def free_percent() -> float | None:
    try:
        out = subprocess.run(["memory_pressure"], capture_output=True, text=True, timeout=10).stdout
        m = re.search(r"free percentage:\s*(\d+)%", out)
        if m:
            return float(m.group(1))
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        info = dict(l.split(":", 1) for l in open("/proc/meminfo"))
        return 100.0 * int(info["MemAvailable"].split()[0]) / int(info["MemTotal"].split()[0])
    except (OSError, KeyError, ValueError):
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-gb", type=float, default=12.0, help="limit for the summed RSS of the command's process group")
    ap.add_argument("--min-free", type=float, default=20.0, help="kill when system-wide free memory falls below this percent")
    ap.add_argument("--interval", type=float, default=2.0)
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
    if not cmd:
        ap.error("no command given")
    p = subprocess.Popen(cmd, start_new_session=True)
    pgid = os.getpgid(p.pid)
    peak, reason = 0.0, None
    while True:
        try:
            p.wait(timeout=a.interval)   # returns at once when the command ends (a sleep here cost every pipeline step 2 s)
            break
        except subprocess.TimeoutExpired:
            pass
        rss = group_rss_gb(pgid)
        peak = max(peak, rss)
        free = free_percent()
        if rss > a.max_gb:
            reason = f"process group RSS {rss:.1f} GB > {a.max_gb} GB"
        elif free is not None and free < a.min_free:
            reason = f"system free memory {free:.0f} % < {a.min_free} %"
        if reason:
            print(f"memguard: killing {cmd[0]}: {reason}", file=sys.stderr, flush=True)
            try:
                os.killpg(pgid, signal.SIGTERM)
                for _ in range(10):
                    if p.poll() is not None:
                        break
                    time.sleep(0.5)
                if p.poll() is None:
                    os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            p.wait()
            print(f"memguard: peak group RSS {peak:.1f} GB", file=sys.stderr)
            return 137
    print(f"memguard: done, exit {p.returncode}, peak group RSS {peak:.1f} GB", file=sys.stderr)
    return p.returncode


if __name__ == "__main__":
    raise SystemExit(main())
