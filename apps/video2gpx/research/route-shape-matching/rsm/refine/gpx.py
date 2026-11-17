# SPDX-License-Identifier: AGPL-3.0-or-later
"""GPX export of the refined position: one trackpoint per video second, <time> = EPOCH + video seconds. No elevation (the OSM graph has none). The point is on the OSM
centre line (no lateral model yet)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np

from . import segment

EPOCH = datetime(2000, 1, 1, 0, 0, 0, tzinfo=timezone.utc)   # video second 0 = 2000-01-01T00:00:00Z


def write_gpx(path_out, ctx, anchors, name: str, step: float = 1.0) -> int:
    t = np.arange(np.ceil(ctx.t_step[0]), ctx.t_step[-1], step)
    s, _ = segment.position(t, anchors, ctx.D, ctx.gapfrac, ctx.kappa, ctx.path.sg[-1])
    ll = ctx.extra["g"].to_wgs84(ctx.path.xy_at(s))
    rows = [f'<trkpt lat="{b:.7f}" lon="{a:.7f}"><time>{(EPOCH + timedelta(seconds=float(x))).strftime("%Y-%m-%dT%H:%M:%SZ")}</time></trkpt>' for x, (a, b) in zip(t, ll)]
    txt = ('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="rsm.refine" xmlns="http://www.topografix.com/GPX/1/1">\n'
           f'<metadata><desc>{name}: refined position on the OSM centre line (anchors + per-segment distance factor). time = 2000-01-01T00:00:00Z + video seconds. Map data (c) OpenStreetMap contributors, ODbL.</desc></metadata>\n'
           f'<trk><name>{name}</name><trkseg>\n' + "\n".join(rows) + "\n</trkseg></trk></gpx>\n")
    open(path_out, "w").write(txt)
    return len(rows)
