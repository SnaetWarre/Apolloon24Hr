//! Building blocks of the Hex-style screens: grouped rows on the panel, section labels, a row of
//! numbers, small flags, and the block that shows who is on the track right now.
use super::*;

pub(super) fn ts(size: f32, weight: f32) -> rune::TextStyle {
    rune::TextStyle::new(size, weight).features("tnum")
}

/// A group of rows: one rounded block, rows split by a line.
pub(super) fn group(s: &State) -> El {
    let t = tok::theme(s.dark);
    col()
        .w_full()
        .min_w(0.0)
        .radius(12.0)
        .fill(t.card)
        .border(1.0, t.card_border)
        .clip_rounded(12.0)
}

/// One row of a group; every row but the first has a line above it.
pub(super) fn item(s: &State, first: bool) -> El {
    let t = tok::theme(s.dark);
    let r = row()
        .w_full()
        .min_w(0.0)
        .min_h(50.0)
        .px(18.0)
        .py(8.0)
        .gap(14.0)
        .center_y();
    if first {
        r
    } else {
        r.border_sides([1.0, 0.0, 0.0, 0.0], t.card_border)
    }
}

/// The label above a group, with an optional count beside it.
pub(super) fn label(s: &State, title: &str, count: Option<usize>) -> El {
    let c = tok::tones(s.dark);
    let mut r = row()
        .gap(6.0)
        .center_y()
        .px(4.0)
        .pb(10.0)
        .child(text(title.to_string()).font(ts(15.0, 550.0)).color(c.ink2));
    if let Some(n) = count {
        r = r.child(text(n.to_string()).font(ts(15.0, 400.0)).color(c.ink3));
    }
    r
}

/// The runner's number, quiet, in a fixed column.
pub(super) fn number(s: &State, value: &str, size: f32, w: f32) -> El {
    text(value.to_string())
        .font(ts(size, 400.0))
        .color(tok::tones(s.dark).ink3)
        .w(w)
}

/// A small tag after a name: "Snelste" in green, anything else in grey.
pub(super) fn flag(s: &State, value: &str, good: bool) -> El {
    let c = tok::tones(s.dark);
    row()
        .h(22.0)
        .px(8.0)
        .center()
        .radius(6.0)
        .fill(if good { c.go_wash } else { c.surface3 })
        .child(
            text(value.to_string())
                .font(ts(12.0, 500.0))
                .color(if good { c.go } else { c.ink2 }),
        )
}

/// A row of numbers in one group, each with its name above.
pub(super) fn stats(s: &State, facts: Vec<(&str, String)>) -> El {
    let t = tok::theme(s.dark);
    let c = tok::tones(s.dark);
    // Four numbers share a half-width panel: smaller figures keep "1:03.000" whole.
    let (size, pad) = if facts.len() > 3 { (21.0, 14.0) } else { (24.0, 18.0) };
    let mut r = row().w_full();
    for (i, (name, value)) in facts.into_iter().enumerate() {
        let mut cell = col()
            .grow(1.0)
            .w(0.0)
            .min_w(0.0)
            .px(pad)
            .py(14.0)
            .gap(2.0)
            .child(text(name.to_string()).font(ts(13.5, 400.0)).color(c.ink3))
            .child(
                text(value)
                    .font(ts(size, 550.0).tracking(-0.5))
                    .color(t.text)
                    .truncate(),
            );
        if i > 0 {
            cell = cell.border_sides([0.0, 0.0, 0.0, 1.0], t.card_border);
        }
        r = r.child(cell);
    }
    group(s).child(r)
}

/// A clock split in its whole seconds and its tenth: "1:12" and ".4".
fn split_clock(ms: i64) -> (String, String) {
    let ms = ms.max(0);
    let whole = duration(ms - ms % 1000);
    (whole, format!(".{}", (ms % 1000) / 100))
}

/// Who is on the track: number, name and the lap clock, with who runs after them.
pub(super) fn now_block(s: &State) -> El {
    let t = tok::theme(s.dark);
    let c = tok::tones(s.dark);
    let brand = super::admin_kit::pal(s.dark).brand;
    let race = &s.snapshot["race"];
    let all = runners(s);
    let current = all
        .iter()
        .find(|r| !race["activeRunnerId"].is_null() && r["id"] == race["activeRunnerId"]);
    let next = super::timing_page::waiting(s).into_iter().next();
    let mut block = group(s).key("now-block").px(20.0).pt(18.0).pb(16.0);
    let Some(current) = current else {
        let message = if !race["raceFinishedAt"].is_null() {
            "De race is afgesloten."
        } else if all.is_empty() {
            "Nog geen lopers. Importeer de inschrijvingen in Beheer of voeg lopers toe in Wachtrij."
        } else if next.is_some() {
            "Nog niemand op de piste. Start de eerste loper in Timing."
        } else {
            "Nog niemand op de piste. Zet eerst lopers klaar in Wachtrij."
        };
        return block
            .gap(4.0)
            .child(text("Op de piste").font(ts(13.5, 400.0)).color(c.ink3))
            .child(text(message).font(ts(16.0, 500.0)).color(t.text).wrap());
    };
    let started = race["activeStartedAt"].as_i64();
    let running = started.map(|start| s.clock - start).unwrap_or(0);
    let since = started
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|time| {
            time.with_timezone(&chrono_tz::Europe::Brussels)
                .format("%H:%M")
                .to_string()
        });
    let (whole, tenth) = split_clock(running);
    let (name_size, clock_size, tenth_size) = (24.0, 40.0, 22.0);
    block = block
        .child(
            row()
                .gap(8.0)
                .center_y()
                .child(rune::el().size(8.0, 8.0).radius(4.0).fill(brand))
                .child(
                    text(match &since {
                        Some(at) => format!("Op de piste sinds {at}"),
                        None => "Op de piste".into(),
                    })
                    .font(ts(13.5, 400.0))
                    .color(c.ink3),
                ),
        )
        .child(
            row()
                .mt(8.0)
                .gap(12.0)
                .items_end()
                .child(
                    row()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(12.0)
                        .items_end()
                        .pb(2.0)
                        .child(
                            text(current["runnerNumber"].as_str().unwrap_or("").to_string())
                                .font(ts(name_size * 0.66, 400.0))
                                .color(c.ink3),
                        )
                        .child(
                            text(current["name"].as_str().unwrap_or("").to_string())
                                .font(ts(name_size, 550.0).tracking(-0.4))
                                .color(t.text)
                                .truncate()
                                .min_w(0.0),
                        ),
                )
                .child(
                    row()
                        .key("now-clock")
                        .items_end()
                        .child(
                            text(whole)
                                .font(ts(clock_size, 550.0).tracking(-clock_size * 0.03))
                                .color(t.text),
                        )
                        .child(
                            text(tenth)
                                .font(ts(tenth_size, 550.0))
                                .color(c.ink3)
                                .pb(clock_size * 0.06),
                        ),
                ),
        );
    let mut foot = row().mt(14.0).w_full().center_y().child(col().grow(1.0));
    if let Some(n) = next {
        foot = foot
            .child(text("Hierna ").font(ts(13.5, 400.0)).color(c.ink3))
            .child(
                text(format!(
                    "{} {}",
                    n["runnerNumber"].as_str().unwrap_or(""),
                    n["name"].as_str().unwrap_or("")
                ))
                .font(ts(13.5, 500.0))
                .color(c.ink2),
            );
    }
    block.child(foot)
}

/// Praise beside a lap in a list: "Snelste" for the race's fastest lap, "Eigen record" for a
/// runner's own best once they ran more than one lap. Laps are never marked any other way.
pub(super) fn lap_praise(s: &State, lap: &Value) -> Option<El> {
    let all = runners(s);
    let ms = lap["durationMs"].as_i64()?;
    let race_best = all
        .iter()
        .filter_map(|r| r["bestLapMs"].as_i64())
        .filter(|n| *n > 0)
        .min();
    if race_best == Some(ms) {
        return Some(flag(s, "Snelste", true));
    }
    let runner = all.iter().find(|r| r["id"] == lap["runnerId"])?;
    (runner["lapCount"].as_i64().unwrap_or(0) > 1 && runner["bestLapMs"].as_i64() == Some(ms))
        .then(|| flag(s, "Eigen record", true))
}
