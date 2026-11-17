# SPDX-License-Identifier: AGPL-3.0-or-later
"""Vendored copy of ../video-motion-speed/vms (motion.py, decode.py) so that rsm.pipeline runs from ONE environment (no second venv).
Changes against the original (also: probe() falls back to the container duration, as mkv files carry none in the stream), nothing else: ffmpeg / ffprobe are found through rsm.pipeline.common (RSM_FFMPEG / RSM_FFPROBE), motion.analyse
takes an `on_progress(done, total, phase)` callback (default None: unchanged behaviour) and its console print is off when a callback is given."""
