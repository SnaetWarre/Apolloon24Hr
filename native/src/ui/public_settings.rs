//! Beheer › Publiek: Burgie gepakt and the record flash on the Buitenscherm, and the ways to the
//! public screens. Port of src/components/admin/PublicSection.tsx.
use super::admin_kit::{self as kit, Kind};
use super::*;

const RECORD_MODES: [(&str, &str); 4] = [("off", "Uit"), ("day", "Dagrecord"), ("two_hour", "Per 2 uur"), ("hour", "Per uur")];

pub(super) fn record_mode_label(mode: &str) -> &'static str {
    match mode {
        "off" => "uit",
        "hour" => "per uur",
        "two_hour" => "per 2 uur",
        _ => "dagrecord",
    }
}

fn moment(s: &State, title: &str, body: &str, action: El) -> El {
    let p = kit::pal(s.dark);
    col()
        .grow(1.0)
        .min_w(0.0)
        .self_stretch()
        .gap(8.0)
        .padding(16.0)
        .radius(8.0)
        .fill(p.t.surface2)
        .border(1.0, p.line)
        .items_start()
        .child(kit::h3(title, s.dark))
        .child(
            text(body.to_string())
                .font(kit::ts(13.5, 400.0).lh(20.25))
                .color(p.t.ink2)
                .wrap()
                .min_w(0.0)
                .w_full(),
        )
        .child(action)
}

pub(super) fn panel(s: &State) -> El {
    let mode = s.snapshot["settings"]["publicRecordMode"].as_str().unwrap_or("day").to_string();
    let pending = s.busy;
    let burgie = kit::btn(
        s,
        "burgie",
        if pending { "Opslaan..." } else { "Burgie gepakt" },
        Kind::Primary,
        false,
        None,
        pending,
        |s| s.send("events.burgieGepakt", json!({})),
    );
    let modes = kit::segmented(s, "Recordflits", &RECORD_MODES, &mode, "record", pending, |s, mode| {
        if !s.busy {
            s.send("settings.updatePublicRecordMode", json!({"publicRecordMode":mode}));
        }
    });
    let link = |key: &str, title: &str, glyph: &'static str, page: usize| {
        kit::btn(s, key.to_string(), title, Kind::Plain, true, Some(glyph), false, move |s| {
            s.page = page
        })
        .role("link")
    };
    col()
        .w_full()
        .min_w(0.0)
        .child(kit::h2("Publieke momenten", s.dark).mb(8.0))
        .child(
            kit::copy(
                "Wat het publiek op het Buitenscherm ziet, bovenop de huidige en volgende loper.",
                s.dark,
            )
            .mb(12.0),
        )
        .child(
            row()
                .w_full()
                .gap(12.0)
                .items_stretch()
                .child(moment(
                    s,
                    "Burgie gepakt",
                    "Toont 8 seconden “Burgie gepakt, ZINGEN” met de loper die nu op de piste is, en bewaart het moment in de analyse.",
                    burgie,
                ))
                .child(moment(
                    s,
                    "Recordflits",
                    "Een nieuwe snelste ronde verschijnt 8 seconden groot op het Buitenscherm.",
                    modes,
                )),
        )
        .child(
            row()
                .mt(16.0)
                .gap(8.0)
                .flex_wrap()
                .child(link("open-outside", "Buitenscherm openen", "displayOutside", 7))
                .child(link("open-inside", "Binnenscherm openen", "displayInside", 5))
                .child(link("open-competitions", "Competitiescherm openen", "displayCompetitions", 6)),
        )
}
