// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Called first thing in `run()`, so monotonic times count from process start.
pub fn process_start() -> Instant {
    static START: OnceLock<Instant> = OnceLock::new();
    *START.get_or_init(Instant::now)
}

pub fn monotonic_micros() -> u64 {
    process_start().elapsed().as_micros() as u64
}

pub fn wall_clock_millis() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}
