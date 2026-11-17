# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fusion of the HMM posterior, anchors (any kind) and the vms distance increments into one position s(t) along the fixed route: an RTS smoother over [s, k]
with robust (Huber) measurement updates, plus a-priori gating of curve anchors by local yaw quality.
posterior.py (posterior mean + spread), gate.py (anchor quality), rts.py (smoother), run.py (variants, scoring, GPX, figures)."""
