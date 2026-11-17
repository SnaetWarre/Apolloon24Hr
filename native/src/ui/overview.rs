//! Overzicht (route /): the overview in src/components/RolePicker.tsx, styles in
//! src/styles/shell.css (.overview*). CSS line boxes (body 1.5, h2 1.25) are fixed heights here.
use super::*;

/// A one-line CSS line box: `size * lh` high, text centred in it.
fn line(t: El, h: f32) -> El {
    row().h(h).min_w(0.0).center_y().child(t)
}

/// `.panel` with a `.panel-header`: title and a quiet "Naar …" link, 8 below it.
fn panel(title: &str, action: &str, page: usize, s: &State) -> El {
    let t = tok::theme(s.dark);
    col()
        .min_w(0.0)
        .grow(1.0)
        .padding(16.0)
        .radius(8.0)
        .fill(t.card)
        .border(1.0, t.card_border)
        .child(
            row()
                .center_y()
                .h(28.0)
                .mb(8.0)
                .child(
                    text(title)
                        .font(rune::TextStyle::new(14.0, 600.0))
                        .color(t.text)
                        .grow(1.0),
                )
                .child(shell::quiet_link(
                    format!("overview-nav-{page}"),
                    action,
                    page,
                    s.dark,
                )),
        )
}

/// `.overview-row` cell: grid `fr` share including padding (flex grow alone would not).
fn cell(share: f32, panel: El) -> El {
    col().grow(share).min_w(0.0).child(panel)
}

/// `RunnerName`: a quiet `.bib` (min-width 2.6em) and the name, `gap` apart.
fn runner_name(r: Option<&&Value>, dark: bool, size: f32, weight: f32, gap: f32) -> El {
    let t = tok::theme(dark);
    let c = tok::tones(dark);
    match r {
        Some(r) => row()
            .gap(gap)
            .center_y()
            .min_w(0.0)
            .child(
                text(r["runnerNumber"].as_str().unwrap_or(""))
                    .font(rune::TextStyle::new(size, 500.0))
                    .color(c.ink3)
                    .min_w(size * 2.6),
            )
            .child(
                text(r["name"].as_str().unwrap_or(""))
                    .font(rune::TextStyle::new(size, weight))
                    .color(t.text)
                    .truncate()
                    .min_w(0.0),
            ),
        None => text("niemand klaar")
            .font(rune::TextStyle::new(size, weight))
            .color(t.text),
    }
}

fn welcome(s: &State) -> El {
    let mut welcome = col()
        .gap(20.0)
        .child(heading("Welkom bij Apolloon", s.dark))
        .child(
            label(
                "Begin met de inschrijvingen op deze laptop of koppel met een andere laptop.",
                s.dark,
            )
            .wrap(),
        );
    if let Some(name) = s.recovery["status"]["damagedDatabase"]["fileName"].as_str() {
        welcome = welcome.child(
            label(
                format!(
                    "De databank op deze laptop was beschadigd. Apolloon zette ze opzij als {name} en startte leeg."
                ),
                s.dark,
            )
            .wrap()
            .role("alert"),
        );
    }
    welcome
        .child(button(
            "welcome-system",
            "Naar Systeem & herstel",
            s.dark,
            |s| {
                s.page = 8;
                s.admin_section = 6;
            },
        ))
        .child(button("welcome-runners", "Lopers toevoegen", s.dark, |s| {
            s.page = 8;
            s.admin_section = 1;
        }))
}

pub(super) fn overview(s: &State) -> El {
    if runners(s).is_empty() && s.snapshot["race"]["raceStartedAt"].is_null() {
        return welcome(s);
    }
    let t = tok::theme(s.dark);
    let c = tok::tones(s.dark);
    let race = &s.snapshot["race"];
    let all = runners(s);
    let history = laps(s);
    let total: i64 = all.iter().filter_map(|r| r["lapCount"].as_i64()).sum();
    let fastest = all
        .iter()
        .filter(|r| r["bestLapMs"].as_i64().is_some_and(|n| n > 0))
        .min_by_key(|r| r["bestLapMs"].as_i64());
    let pace = race["raceStartedAt"]
        .as_i64()
        .and_then(|start| {
            history
                .first()
                .and_then(|l| l["finishedAt"].as_i64())
                .map(|last| (start, race["raceFinishedAt"].as_i64().unwrap_or(last)))
        })
        .filter(|(start, last)| last > start)
        .map(|(start, last)| {
            format!("{:.1}", total as f64 * 3600000.0 / (last - start) as f64).replace('.', ",")
        })
        .unwrap_or_else(|| "—".into());
    let fastest_time = fastest
        .and_then(|r| r["bestLapMs"].as_i64())
        .map(lap_duration)
        .unwrap_or_else(|| "—".into());

    // KPI strip: 14/16 padding, 12.5px label, 26px value (lh 1.15), optional runner line.
    let mut kpis = row().radius(8.0).fill(t.card).border(1.0, t.card_border);
    for (i, (title, value)) in [
        ("Racetijd", race_time(s)),
        ("Rondes", total.to_string()),
        ("Rondes per uur", pace),
        ("Snelste ronde", fastest_time),
    ]
    .into_iter()
    .enumerate()
    {
        let mut kpi = col()
            .grow(1.0)
            .min_w(0.0)
            .px(16.0)
            .py(15.0)
            .gap(2.0)
            .child(line(
                text(title).font(type_::LABEL_REGULAR).color(c.ink3),
                18.75,
            ))
            .child(line(
                text(value).font(tok::KPI.tracking(-0.78)).color(t.text),
                29.9,
            ));
        if i < 3 {
            kpi = kpi.border_sides([0.0, 1.0, 0.0, 0.0], t.card_border);
        }
        if i == 3
            && let Some(r) = fastest
        {
            kpi = kpi.child(line(runner_name(Some(r), s.dark, 12.5, 400.0, 4.0), 18.75));
        }
        kpis = kpis.child(kpi);
    }

    // Op de piste.
    let current = all.iter().find(|r| r["id"] == race["activeRunnerId"]);
    let next = all.iter().find(|r| r["status"] == "waiting");
    let mut track = panel("Op de piste", "Naar Timing", 2, s);
    if current.is_some() {
        let mut now = row()
            .pt(8.0)
            .pb(12.0)
            .h(72.0)
            .gap(16.0)
            .center_y()
            .child(runner_name(current, s.dark, 22.0, 600.0, 8.0).grow(1.0));
        if let Some(start) = race["activeStartedAt"].as_i64() {
            now = now.child(
                text(duration(s.clock - start))
                    .font(rune::TextStyle::new(34.0, 600.0).tracking(-1.36))
                    .color(t.text),
            );
        }
        track = track.child(now);
    } else {
        track = track.child(
            line(
                text(if !race["raceFinishedAt"].is_null() {
                    "De race is afgesloten."
                } else if all.is_empty() {
                    "Nog geen lopers. Importeer de inschrijvingen in Beheer of voeg lopers toe in Wachtrij."
                } else if next.is_some() {
                    "Nog niemand op de piste. Start de eerste loper in Timing."
                } else {
                    "Nog niemand op de piste. Zet eerst lopers klaar in Wachtrij."
                })
                .font(rune::TextStyle::new(14.0, 400.0))
                .color(c.ink3),
                21.0,
            )
            .py(12.0)
            .h(45.0),
        );
    }
    track = track.child(
        row()
            .pt(12.0)
            .h(34.25)
            .gap(4.0)
            .center_y()
            .border_sides([1.0, 0.0, 0.0, 0.0], t.card_border)
            .child(
                text("Volgende:")
                    .font(rune::TextStyle::new(13.5, 400.0))
                    .color(c.ink3),
            )
            .child(runner_name(next, s.dark, 13.5, 550.0, 8.0)),
    );

    // Wisselzone.
    let warming = all.iter().filter(|r| r["status"] == "warming_up").count();
    let waiting_count = all.iter().filter(|r| r["status"] == "waiting").count();
    let ran = all
        .iter()
        .filter(|r| r["lapCount"].as_i64().unwrap_or(0) > 0)
        .count();
    let mut counts = row().gap(8.0);
    for (title, count) in [
        ("Opwarmen", warming),
        ("Klaar", waiting_count),
        ("Met rondes", ran),
    ] {
        counts = counts.child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .px(12.0)
                .py(10.0)
                .radius(6.0)
                .fill(c.surface2)
                .child(line(
                    text(title).font(type_::LABEL_REGULAR).color(c.ink3),
                    18.75,
                ))
                .child(line(
                    text(count.to_string())
                        .font(rune::TextStyle::new(24.0, 550.0))
                        .color(t.text),
                    36.0,
                )),
        );
    }
    let mut waiting = panel("Wisselzone", "Naar Wachtrij", 1, s).child(counts);
    let open = !race["raceStartedAt"].is_null() && race["raceFinishedAt"].is_null();
    if waiting_count < 3 && open {
        waiting = waiting.child(
            text(format!(
                "Nog maar {waiting_count} {} klaar. Zet lopers klaar in Wachtrij.",
                if waiting_count == 1 {
                    "loper"
                } else {
                    "lopers"
                }
            ))
            .font(type_::BODY)
            .color(c.warn_ink)
            .wrap()
            .mt(12.0),
        );
    }

    // Laatste rondes: a full-bleed table, 7/10 cell padding, rule under each row.
    let mut recent = panel("Laatste rondes", "Naar Analyse", 3, s).pb(8.0);
    let mut table = col().mx(-16.0).mt(1.0);
    let shown = history.len().min(8);
    for (i, lap) in history.iter().take(8).enumerate() {
        let clock =
            chrono::DateTime::from_timestamp_millis(lap["finishedAt"].as_i64().unwrap_or(0))
                .map(|time| {
                    time.with_timezone(&chrono_tz::Europe::Brussels)
                        .format("%H:%M:%S")
                        .to_string()
                })
                .unwrap_or_else(|| "—".into());
        table = table.child(
            row()
                .h(34.5)
                .center_y()
                .border_sides(
                    [0.0, 0.0, if i + 1 < shown { 1.0 } else { 0.0 }, 0.0],
                    t.card_border,
                )
                .child(
                    text(clock)
                        .font(type_::BODY)
                        .color(c.ink3)
                        .pl(16.0)
                        .w(146.0),
                )
                .child(
                    row()
                        .grow(1.0)
                        .min_w(0.0)
                        .px(10.0)
                        .center_y()
                        .child(
                            text(lap["runnerNumber"].as_str().unwrap_or(""))
                                .font(type_::BODY)
                                .color(c.ink3)
                                .min_w(34.0),
                        )
                        .child(
                            text(lap["runnerName"].as_str().unwrap_or(""))
                                .font(type_::BODY)
                                .color(t.text)
                                .truncate()
                                .min_w(0.0),
                        ),
                )
                .child(
                    row().px(10.0).justify_end().child(
                        text(format!("ronde {}", lap["lapNumber"]))
                            .font(type_::BODY)
                            .color(c.ink3),
                    ),
                )
                .child(
                    row().w(144.0).pl(10.0).pr(16.0).justify_end().child(
                        text(lap_duration(lap["durationMs"].as_i64().unwrap_or(0)))
                            .font(rune::TextStyle::new(13.0, 550.0))
                            .color(t.text),
                    ),
                ),
        );
    }
    if history.is_empty() {
        recent = recent.pb(16.0).child(
            line(
                text("Nog geen rondes geregistreerd.")
                    .font(type_::BODY)
                    .color(c.ink3),
                21.0,
            )
            .py(12.0)
            .h(45.0),
        );
    } else {
        recent = recent.child(table);
    }

    // Systeem.
    let mut system = panel("Systeem", "Naar Beheer", 8, s);
    if let Some(status) = shell::overview_status(s) {
        system = system.child(status);
    }
    let mut facts = col().gap(2.0).mt(12.0);
    let facts_rows = [
        (
            "Adres voor andere laptops",
            s.snapshot["host"]["url"].as_str().unwrap_or("—").to_owned(),
        ),
        ("Lopers in de databank", all.len().to_string()),
    ];
    let n = facts_rows.len();
    for (i, (name, value)) in facts_rows.into_iter().enumerate() {
        let mut fact = row()
            .gap(12.0)
            .py(6.0)
            .h(31.5 + if i + 1 < n { 1.0 } else { 0.0 })
            .center_y();
        if i + 1 < n {
            fact = fact.border_sides([0.0, 0.0, 1.0, 0.0], t.card_border);
        }
        facts = facts.child(
            fact.child(text(name).font(type_::BODY).color(c.ink3).grow(1.0))
                .child(text(value).font(type_::BODY).color(t.text)),
        );
    }
    system = system.child(facts);

    col()
        .gap(16.0)
        .max_w(1240.0)
        .child(kpis)
        .child(
            row()
                .gap(16.0)
                .child(cell(1.6, track))
                .child(cell(1.0, waiting)),
        )
        .child(
            row()
                .gap(16.0)
                .child(cell(1.6, recent))
                .child(cell(1.0, system)),
        )
}
