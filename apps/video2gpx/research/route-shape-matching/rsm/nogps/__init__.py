# SPDX-License-Identifier: AGPL-3.0-or-later
"""No-GPS adapter: runs the frozen pipeline (vms -> quanta stage A -> plausibility fit stage B -> whole-video tracker v2) on a video that has no GPS.

Imports rsm.quanta, rsm.plaus and rsm.track as they are (none is edited). Copies: the graph build of rsm.quanta.area (it caches inside work/quanta and
reads the Rhone-Alpes PBF) and the window evaluation of rsm.plaus.pipeline (it asks the GPS truth for labels). Truth is not available here: `correct`
labels are always False and every quantum counts as in the area.
"""
