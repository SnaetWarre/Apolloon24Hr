//! Clocks that tick on their own (the race time, the lap on the track, time in a lane, the TV race
//! time) are bound to a `LiveText`: a tick repaints those digits without rebuilding the screen.
//! `clock::sample` only asks for a rebuild when such a text changes width.
use super::*;
use rune::LiveText;
use std::cell::RefCell;
use std::collections::HashMap;

pub(super) struct Clocks {
    race: LiveText,
    lap_whole: LiveText,
    lap_tenth: LiveText,
    public_race: LiveText,
    profile: LiveText,
    /// Time in a lane on Wachtrij, by runner id.
    lanes: RefCell<HashMap<String, LiveText>>,
}

impl Default for Clocks {
    fn default() -> Self {
        let blank = || LiveText::new("");
        Self {
            race: blank(),
            lap_whole: blank(),
            lap_tenth: blank(),
            public_race: blank(),
            profile: blank(),
            lanes: RefCell::default(),
        }
    }
}

/// A text showing `value` now and every later value `live` is given.
pub(super) fn bound(live: &LiveText, value: String) -> El {
    live.set(value.as_str());
    text(value).live_text(live)
}

/// The sidebar and Overzicht race time.
pub(super) fn race(s: &State, value: String) -> El {
    bound(&s.live_clocks.race, value)
}

/// The lap on the track on Overzicht: its whole seconds and its tenth.
pub(super) fn lap(s: &State, whole: String, tenth: String) -> (El, El) {
    (bound(&s.live_clocks.lap_whole, whole), bound(&s.live_clocks.lap_tenth, tenth))
}

/// "Racetijd" on Binnenscherm and Competitiescherm.
pub(super) fn public_race(s: &State, value: String) -> El {
    bound(&s.live_clocks.public_race, value)
}

/// "voor m:ss" in the runner profile.
pub(super) fn profile(s: &State, value: String) -> El {
    bound(&s.live_clocks.profile, value)
}

/// A runner's time in their lane on Wachtrij.
pub(super) fn lane(s: &State, id: &str, value: String) -> El {
    let live = s.live_clocks.lanes.borrow_mut().entry(id.to_owned()).or_insert_with(|| LiveText::new("")).clone();
    bound(&live, value)
}

/// Puts the current time in every clock the open page shows. Runs before the view, so a rebuild
/// finds the same text and a tick without one still shows the right digits.
pub(super) fn publish(s: &State) {
    let clocks = &s.live_clocks;
    if (5..=7).contains(&s.page) {
        if let Some(value) = public_screens::race_elapsed(s) {
            clocks.public_race.set(value);
        }
        return;
    }
    clocks.race.set(race_time(s));
    if s.page == 0
        && let Some(running) = hex::running_ms(s)
    {
        let (whole, tenth) = hex::split_clock(running);
        clocks.lap_whole.set(whole);
        clocks.lap_tenth.set(tenth);
    }
    if let Some(value) = profile::elapsed(s) {
        clocks.profile.set(value);
    }
    if s.page == 1 {
        let mut lanes = clocks.lanes.borrow_mut();
        let all: HashMap<&str, &Value> = runners(s).into_iter().filter_map(|r| Some((r["id"].as_str()?, r))).collect();
        lanes.retain(|id, live| {
            let Some(r) = all.get(id.as_str()) else { return false };
            let Some(value) = queue_page::lane_time(s, r) else { return false };
            live.set(value);
            true
        });
    }
}

#[cfg(test)]
impl Clocks {
    pub(super) fn race_text(&self) -> std::sync::Arc<str> {
        self.race.get()
    }
    pub(super) fn lap_text(&self) -> (String, String) {
        (self.lap_whole.get().to_string(), self.lap_tenth.get().to_string())
    }
}
