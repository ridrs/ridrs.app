# SPDX-License-Identifier: AGPL-3.0-or-later
"""Side of the road from the bbox centre, offline. Approximate polygons of the left-hand-traffic countries (about +-20 km at borders; the list is
partial: UK, IE, JP, AU, NZ, ZA, IN with its neighbours, CY, MT, plus a few). Override with --traffic-side."""
from __future__ import annotations

from shapely.geometry import Point, Polygon, box

LEFT = {
    "GB": Polygon([(-5.9, 49.85), (-1.0, 50.3), (1.0, 50.7), (1.8, 51.1), (1.8, 52.8), (0.6, 53.6), (-0.3, 54.6), (-1.5, 55.8), (-1.9, 55.95), (-2.0, 57.7), (-1.6, 57.7),
                   (-4.0, 58.7), (-3.0, 59.0), (-5.0, 58.7), (-8.7, 57.9), (-7.2, 56.6), (-5.7, 55.3), (-4.5, 54.6), (-3.2, 54.3), (-3.3, 53.5), (-4.8, 53.3), (-5.3, 52.0), (-5.3, 51.5), (-4.5, 50.9), (-5.9, 49.85)]),
    "IE": Polygon([(-10.8, 51.3), (-6.2, 51.3), (-6.0, 52.2), (-5.9, 53.5), (-5.4, 54.1), (-5.4, 54.7), (-6.2, 55.3), (-7.3, 55.45), (-8.3, 55.2), (-8.8, 54.7), (-10.2, 54.4), (-10.8, 53.6)]),
    "IM": box(-4.9, 54.0, -4.3, 54.45),
    "JE_GG": box(-2.7, 49.1, -2.0, 49.55),
    "JP": box(129.4, 30.9, 146.0, 45.6),
    "AU": box(112.9, -44.0, 154.0, -10.4),
    "NZ": box(166.0, -47.5, 178.7, -34.0),
    "ZA": box(16.4, -34.95, 33.0, -22.2),
    "IN_NP_BT_BD": box(68.1, 6.7, 92.7, 35.5),
    "LK": box(79.4, 5.8, 82.0, 9.9),
    "PK": box(61.0, 23.6, 75.5, 31.0),
    "CY": box(32.2, 34.5, 34.7, 35.75),
    "MT": box(14.1, 35.75, 14.65, 36.1),
    "HK": box(113.8, 22.1, 114.5, 22.6),
    "TH": box(98.0, 6.0, 102.5, 13.0),
    "MY_SG": box(99.6, 1.2, 104.4, 6.7),
    "KE_TZ_UG": box(29.5, -11.7, 41.9, 4.6),
}


def traffic_side(lon: float, lat: float) -> tuple[str, str]:
    """-> ('left'|'right', region name or 'default')"""
    p = Point(lon, lat)
    for k, poly in LEFT.items():
        if poly.contains(p):
            return "left", k
    return "right", "default"
