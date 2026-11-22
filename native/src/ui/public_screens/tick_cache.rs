use super::*;
use std::hash::Hash;

pub(super) fn version(s: &State) -> impl Hash + '_ {
    let screen = &s.public_screens;
    (
        (s.history_version, &s.snapshot["runners"], &s.snapshot["labels"], &s.snapshot["settings"], &s.snapshot["race"]),
        (&screen.ranking_label, screen.ranking_changed, screen.new_laps.len()),
        (s.page, screen.settings.light(s.page, false), screen.settings.zoom(s.page).to_bits(), win_w().to_bits(), vh_unit().to_bits()),
        (s.connected, s.busy, s.logos.len()),
    )
}
