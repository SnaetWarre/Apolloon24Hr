//! The time every laptop in the group agrees on (port of server/clock.ts). The first leader's
//! clock is the reference; the others keep an offset to it, and a laptop that takes over keeps its
//! offset, so times stay continuous across a failover.
use std::sync::{
    Mutex,
    atomic::{AtomicI64, Ordering},
};

/// Corrections smaller than this are measurement noise on a LAN.
const CLOCK_STEP_MS: i64 = 2;
const SAMPLE_COUNT: usize = 16;

/// One process is one laptop, so the offset is process-wide, like the reference's module state.
static OFFSET_MS: AtomicI64 = AtomicI64::new(0);

pub fn offset() -> i64 {
    OFFSET_MS.load(Ordering::Relaxed)
}
pub fn set_offset(ms: i64) {
    OFFSET_MS.store(ms, Ordering::Relaxed);
}

#[derive(Default)]
pub struct Samples(Mutex<Vec<(i64, i64)>>);
impl Samples {
    /// Learns the offset from one request: sent and received on this laptop's own clock (without
    /// offset), answered with the leader's group time. The fastest recent round trip wins.
    /// Returns the new offset when it moved away from `current`.
    pub fn observe(
        &self,
        current: i64,
        reference_now: i64,
        sent_at: i64,
        received_at: i64,
    ) -> Option<i64> {
        let round_trip = received_at - sent_at;
        if round_trip < 0 {
            return None;
        }
        let mut samples = self.0.lock().unwrap();
        samples.push((reference_now - (sent_at + round_trip / 2), round_trip));
        if samples.len() > SAMPLE_COUNT {
            samples.remove(0);
        }
        let best = samples.iter().min_by_key(|s| s.1).map(|s| s.0).unwrap_or(0);
        ((best - current).abs() >= CLOCK_STEP_MS).then_some(best)
    }
    pub fn reset(&self) {
        self.0.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_fastest_round_trip_sets_the_offset_and_noise_is_ignored() {
        let samples = super::Samples::default();
        assert_eq!(samples.observe(0, 10_500, 10_000, 10_010), Some(495));
        // A slower sample does not move it; a 1 ms difference is noise.
        assert_eq!(samples.observe(495, 20_900, 20_000, 20_200), None);
        assert_eq!(samples.observe(495, 30_496, 30_000, 30_000), None);
    }
}
