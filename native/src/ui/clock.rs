use super::*;
use std::hash::{DefaultHasher, Hash, Hasher};

pub(super) struct Sample {
    now: i64,
    values: u64,
    due: i64,
}

impl Sample {
    fn new(now: i64) -> Self {
        Self { now, values: 0, due: i64::MAX }
    }

    pub(super) fn value(&mut self, value: impl Hash) {
        let mut hash = DefaultHasher::new();
        self.values.hash(&mut hash);
        value.hash(&mut hash);
        self.values = hash.finish();
    }

    pub(super) fn bucket(&mut self, start: i64, width: i64) {
        let bucket = (self.now - start).max(0) / width;
        self.value(bucket);
        self.live_bucket(start, width);
    }

    /// A live-bound display updates itself; the frame only has to wake often enough to publish it.
    pub(super) fn live_bucket(&mut self, start: i64, width: i64) {
        let bucket = (self.now - start).max(0) / width;
        self.due = self.due.min(start + (bucket + 1) * width);
    }

    pub(super) fn until(&mut self, due: i64) {
        self.value(self.now < due);
        if self.now < due {
            self.due = self.due.min(due);
        }
    }
}

fn sample(s: &State) -> Sample {
    let mut out = Sample::new(s.clock);
    if (5..=7).contains(&s.page) {
        public_screens::clocks(s, &mut out);
        return out;
    }
    shell::clocks(s, &mut out);
    readiness::clocks(s, &mut out);
    profile::clocks(s, &mut out);
    admin_base::clocks(s, &mut out);
    match s.page {
        0 => {
            let race = &s.snapshot["race"];
            if runners(s).iter().any(|r| !race["activeRunnerId"].is_null() && r["id"] == race["activeRunnerId"]) {
                if let Some(start) = race["activeStartedAt"].as_i64() {
                    out.value(hex::split_clock(s.clock - start).0.len());
                    out.live_bucket(start, 100);
                }
            }
        }
        1 => queue_page::clocks(s, &mut out),
        2 => timing_page::clocks(s, &mut out),
        // Tactiek's numbers and chart move far slower than a second: refresh them every five.
        4 if s.snapshot["race"]["raceFinishedAt"].is_null() => {
            if let Some(start) = s.snapshot["race"]["raceStartedAt"].as_i64() { out.bucket(start, 5000) }
        }
        8 if s.admin_section == 6 => admin_system::clocks(s, &mut out),
        _ => {}
    }
    out
}

pub(super) fn advance(s: &mut State, tx: &mut Tx) -> bool {
    let now = s.server_now();
    advance_at(s, now, tx)
}

fn advance_at(s: &mut State, now: i64, tx: &mut Tx) -> bool {
    let before = sample(s);
    s.clock = now;
    timing_page::update_live_clock(s);
    live_clock::publish(s);
    let after = sample(s);
    // The transport's mpsc receiver also needs servicing when no display clock is running.
    let due = after.due.min(s.clock + 200);
    tx.wake_at(tx.clock() + (due - s.clock).max(1) as f64 / 1000.0);
    before.values != after.values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_and_expiry_change_only_at_their_display_deadlines() {
        let key = |now| {
            let mut clock = Sample::new(now);
            clock.bucket(37, 100);
            clock.until(250);
            (clock.values, clock.due)
        };
        assert_eq!(key(100), key(136));
        assert_ne!(key(136).0, key(137).0);
        assert_ne!(key(249).0, key(250).0);
        assert_eq!(Sample::new(0).values, 0);
    }

    #[test]
    fn running_clocks_tick_through_live_text_without_a_rebuild() {
        let mut s = init_with_url("http://127.0.0.1:0".into());
        s.snapshot = json!({"race":{"activeRunnerId":"runner","activeStartedAt":37,"raceStartedAt":37},"runners":[{"id":"runner","status":"running"}]});
        for page in [0, 1, 2, 5, 6] {
            s.page = page;
            s.clock = 100;
            let initial = sample(&s);
            assert_eq!(initial.due, if matches!(page, 0 | 2) { 137 } else { 1037 }, "page {page}");
            for now in [137, 1037, 9037] {
                s.clock = now;
                assert_eq!(initial.values, sample(&s).values, "page {page} at {now}");
            }
            // "9:59" becomes "10:00": the wider text needs a new layout.
            s.clock = 600_037;
            assert_ne!(initial.values, sample(&s).values, "page {page}");
        }
    }

    #[test]
    fn advancing_the_clock_puts_the_new_time_in_the_live_texts() {
        let mut s = init_with_url("http://127.0.0.1:0".into());
        s.snapshot = json!({"race":{"activeRunnerId":"runner","activeStartedAt":1000,"raceStartedAt":0},"runners":[{"id":"runner","status":"running"}]});
        s.page = 0;
        let mut tx = Tx::default();
        advance_at(&mut s, 62_500, &mut tx);
        assert_eq!(&*s.live_clocks.race_text(), "1:02");
        assert_eq!(s.live_clocks.lap_text(), ("1:01".into(), ".5".into()));
        assert!(!advance_at(&mut s, 63_000, &mut tx));
        assert_eq!(&*s.live_clocks.race_text(), "1:03");
    }

    #[test]
    fn empty_and_failed_snapshots_do_not_create_a_running_clock() {
        let mut s = init_with_url("http://127.0.0.1:0".into());
        for snapshot in [Value::Null, json!({"race":{"activeStartedAt":37},"runners":[]})] {
            s.snapshot = snapshot;
            for page in [0, 1, 2, 5, 6, 7, 8] {
                s.page = page;
                s.clock = 100_000;
                let before = sample(&s).values;
                s.clock += 1000;
                assert_eq!(before, sample(&s).values, "page {page}");
            }
        }
    }

    #[test]
    fn lane_timers_tick_together_on_the_race_second_without_a_rebuild() {
        let mut s = init_with_url("http://127.0.0.1:0".into());
        s.page = 1;
        s.snapshot = json!({"race":{"raceStartedAt":500},"runners":[
            {"id":"a","status":"waiting","statusSince":37},{"id":"b","status":"warming_up","statusSince":810}]});
        s.clock = 4036;
        let before = sample(&s);
        assert_eq!(before.due, 4500);
        s.clock = 4500;
        assert_eq!(before.values, sample(&s).values);
        // At the shared second each lane shows the whole seconds it has had by then.
        assert_eq!(queue_page::lane_time(&s, &s.snapshot["runners"][0]).as_deref(), Some("0:04"));
        assert_eq!(queue_page::lane_time(&s, &s.snapshot["runners"][1]).as_deref(), Some("0:03"));
    }

    #[test]
    fn a_long_warm_up_rebuilds_once_for_its_colour() {
        let mut s = init_with_url("http://127.0.0.1:0".into());
        s.page = 1;
        s.snapshot = json!({"runners":[{"status":"warming_up","statusSince":0}]});
        s.clock = 599_999;
        let before = sample(&s).values;
        s.clock = 600_000;
        assert_ne!(before, sample(&s).values);
    }

    #[test]
    fn queue_clock_only_wakes_redraw_once_per_displayed_second_not_active_tenth() {
        let mut s = init_with_url("http://127.0.0.1:0".into());
        s.page = 1;
        s.clock = 10_000;
        s.snapshot = json!({"race":{"raceStartedAt":37,"activeRunnerId":"active","activeStartedAt":45},
            "runners":[{"id":"active","status":"running"},{"id":"waiting","status":"waiting","statusSince":37}]});
        let mut changed = Vec::new();
        for now in 10_001..=13_000 {
            let mut tx = Tx::default();
            if advance_at(&mut s, now, &mut tx) { changed.push(now); }
            assert!(!advance_at(&mut s, now, &mut tx), "duplicate wake at {now}");
        }
        assert_eq!(changed, Vec::<i64>::new());
        for snapshot in [Value::Null, json!({"error":"unavailable"})] {
            s.snapshot = snapshot;
            for now in 14_000..15_000 {
                assert!(!advance_at(&mut s, now, &mut Tx::default()));
            }
        }
    }

    #[test]
    fn sidebar_race_seconds_keep_running_without_an_active_runner() {
        let mut s = init_with_url("http://127.0.0.1:0".into());
        s.snapshot = json!({"race":{"raceStartedAt":37},"runners":[]});
        for page in [0, 1, 2, 3, 4, 8] {
            s.page = page;
            s.clock = 1036;
            assert_eq!(sample(&s).due, 1037, "page {page}");
            let mut tx = Tx::default();
            advance_at(&mut s, 1037, &mut tx);
            assert_eq!(&*s.live_clocks.race_text(), "0:01", "page {page}");
        }
    }

    #[test]
    fn timing_milestone_expires_even_after_the_clock_stops() {
        let mut s = init_with_url("http://127.0.0.1:0".into());
        s.page = 2;
        s.snapshot = json!({"race":{"raceFinishedAt":100},"runners":[{"lapCount":100}]});
        s.history = json!({"laps":[{"finishedAt":37}]});
        s.clock = 120036;
        let before = sample(&s).values;
        s.clock = 120037;
        let expired = sample(&s).values;
        assert_ne!(before, expired);
        s.clock += 200000;
        assert_eq!(expired, sample(&s).values);
    }

    #[test]
    fn personal_averages_do_not_commit_for_a_live_clock_tick() {
        let mut s = init_with_url("http://127.0.0.1:0".into());
        s.page = 2;
        s.connected = true;
        s.snapshot = json!({"race":{"raceStartedAt":0,"activeStartedAt":1000,"activeRunnerId":"a"},
            "runners":[{"id":"a","averageLapMs":65000.25,"historicalAvgMs":65000.25}]});
        s.clock = 131000;
        let before = sample(&s);
        assert_eq!(before.due, 131100);
        s.clock = 131001;
        assert_eq!(before.values, sample(&s).values);
        s.clock = 131100;
        assert_eq!(before.values, sample(&s).values);
    }

    #[test]
    fn resting_operator_poll_does_not_invalidate_an_unchanged_or_disconnected_view() {
        let mut s = init_with_url("http://127.0.0.1:0".into());
        let (_sender, receiver) = mpsc::channel();
        s.rx = receiver;
        let mut tx = Tx::default();
        for page in [0, 2, 3, 8] {
            s.page = page;
            poll(&mut s, 0.0, &mut tx);
            assert!(!poll(&mut s, 0.0, &mut tx), "page {page}");
        }
    }
}
