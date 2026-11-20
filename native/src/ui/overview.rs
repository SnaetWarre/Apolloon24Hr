//! Overzicht (route /): the overview in src/components/RolePicker.tsx, styles in
//! src/styles/shell.css (.overview*). CSS line boxes (body 1.5, h2 1.25) are fixed heights here.
use super::*;

const WELCOME_KEY: &str = "apolloon.welcome";

pub(super) fn welcome_skipped() -> bool {
    public_screens::settings::read(WELCOME_KEY).as_deref() == Some("skipped")
}

pub(super) fn show_welcome(s: &State) -> bool {
    runners(s).is_empty() && s.snapshot["race"]["raceStartedAt"].is_null() && !s.welcome_skipped
}

fn open_admin(section: usize) -> impl Fn(&mut State, &mut Tx) {
    move |s, tx| {
        tx.instant();
        s.page = 8;
        s.admin_section = section;
    }
}

fn welcome(s: &State) -> El {
    use admin_base::{Kind, banner, btn, copy, h2, h3, panel};

    let cluster = &s.snapshot["cluster"];
    let linking = cluster["enabled"] == true;
    let automatic = cluster["autoLink"]["enabled"] == true;
    let mut welcome = col().max_w(920.0).gap(20.0).child(
        col()
            .gap(4.0)
            .child(h2(s, "Welkom bij Apolloon"))
            .child(copy(
                s,
                "Op deze laptop staan nog geen lopers. Kies hoe ze begint.",
            )),
    );
    if let Some(name) = s.recovery["status"]["damagedDatabase"]["fileName"].as_str() {
        welcome = welcome.child(
            banner(s, true)
                .role("status")
                .child(copy(s, format!("De databank op deze laptop was beschadigd. Apolloon zette ze opzij als {name} en startte leeg. Koppel deze laptop opnieuw aan de groep, of zet een backup terug.")))
                .child(row().child(btn(s, "welcome-recovery", "Naar Systeem & herstel", Kind::Plain, false, false).on_press_tx(open_admin(6)))),
        );
    }
    let first = panel(s)
        .gap(12.0)
        .padding(20.0)
        .min_w(300.0)
        .grow(1.0)
        .child(shell::icon("upload", s.dark, 0, 18.0).size(36.0, 36.0).center())
        .child(h3(s, "Dit is de eerste laptop"))
        .child(copy(s, if automatic {
            "Importeer hier de inschrijvingen: het Excel-bestand of de CSV-export van het inschrijvingsformulier. De andere laptops koppelen daarna vanzelf met deze."
        } else {
            "Importeer hier de inschrijvingen: het Excel-bestand of de CSV-export van het inschrijvingsformulier. De andere laptops koppel je daarna aan deze."
        }))
        .child(row().child(btn(s, "welcome-import", "Inschrijvingen importeren", Kind::Primary, false, false).on_press_tx(open_admin(0))));
    let choices = if linking {
        let mut second = panel(s)
            .gap(12.0)
            .padding(20.0)
            .min_w(300.0)
            .grow(1.0)
            .child(shell::icon("link", s.dark, 0, 18.0).size(36.0, 36.0).center())
            .child(h3(s, "Een andere laptop is al ingesteld"))
            .child(copy(s, if automatic {
                "Deze laptop koppelt vanzelf met die groep zodra ze die vindt. Ze neemt alle gegevens over en werkt mee."
            } else {
                "Koppel deze laptop aan die groep. Ze neemt alle gegevens over en werkt mee."
            }));
        let members = cluster["members"].as_array().map_or(1, Vec::len);
        if members > 1 {
            second = second.child(
                copy(s, format!("Gekoppeld. Deze laptop werkt samen met {}. Importeer de inschrijvingen op één van de laptops.", admin_kit::count_label((members - 1) as i64, "andere laptop", "andere laptops"))).role("status"),
            );
        } else {
            let nearby = cluster["nearby"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|laptop| laptop["runners"].as_i64().unwrap_or(0) > 0)
                .collect::<Vec<_>>();
            let busy = s.busy || admin_system::busy_state(cluster);
            for laptop in &nearby {
                second = second.child(admin_system::nearby_row(s, laptop, busy));
            }
            if let Some(status) = cluster["autoLink"]["waiting"].as_str() {
                second = second.child(copy(s, status).role("status"));
            }
            if nearby.is_empty() {
                second = second.child(copy(s, "Zoeken naar laptops op dit netwerk… Staat Apolloon aan op de andere laptop, en hangen beide aan dezelfde switch?").role("status"));
            }
            second = second.child(
                row().child(
                    btn(
                        s,
                        "welcome-system",
                        "Adres zelf invullen",
                        Kind::Ghost,
                        true,
                        false,
                    )
                    .on_press_tx(|s: &mut State, tx: &mut Tx| {
                        s.system.manual_open = !s.system.manual_open;
                        if s.system.manual_open {
                            tx.focus_when_shown("cluster-url", true);
                        }
                    }),
                ),
            );
            if s.system.manual_open {
                second = second
                    .child(copy(s, "Het adres staat onderaan de zijbalk op de andere laptop."))
                    .child(admin_system::manual_join_form(s, busy));
            }
        }
        row().gap(16.0).flex_wrap().child(first).child(second)
    } else {
        row().child(first.max_w(460.0))
    };
    let mut next = col().gap(6.0).child(h3(s, "Daarna"));
    if linking {
        let plan = if automatic {
            "Start Apolloon op de andere laptops, aan dezelfde switch. Ze koppelen vanzelf met deze laptop."
        } else {
            "Start Apolloon op de andere laptops, aan dezelfde switch, en kies daar Een andere laptop is al ingesteld."
        };
        next = next.child(copy(
            s,
            match cluster["hostName"].as_str() {
                Some(name) => format!("{plan} Deze laptop staat daar als {name}."),
                None => plan.to_string(),
            },
        ));
    }
    next = next.child(copy(
        s,
        "Kijk Beheer › Voorbereiding na: de wedstrijdgereedheid moet op Klaar staan.",
    ));
    if let Some(url) = s.snapshot["host"]["url"].as_str() {
        next = next.child(
            row().gap(6.0).center_y().flex_wrap()
                .child(copy(s, "Open het adres"))
                .child(btn(s, "welcome-copy-address", url, Kind::Quiet, true, false).on_press_tx(|s: &mut State, tx: &mut Tx| {
                    if let Some(url) = s.snapshot["host"]["url"].as_str() {
                        tx.copy(url);
                    }
                }))
                .child(copy(s, "in een browser. Zet het venster op het tweede scherm en kies Binnenscherm, Competitiescherm of Buitenscherm.")),
        );
    }
    welcome.child(choices).child(next).child(
        row().child(
            btn(
                s,
                "welcome-skip",
                "Overslaan en het lege overzicht tonen",
                Kind::Quiet,
                true,
                false,
            )
            .on_press(|s: &mut State| {
                s.welcome_skipped = true;
                if !s.fixture {
                    public_screens::settings::write(WELCOME_KEY, Some("skipped"));
                }
            }),
        ),
    )
}

pub(super) fn overview(s: &State) -> El {
    if show_welcome(s) {
        return welcome(s);
    }
    use super::hex;
    let t = tok::theme(s.dark);
    let c = tok::tones(s.dark);
    let race = &s.snapshot["race"];
    let all = runners(s);
    let history = laps(s);
    let total: i64 = all.iter().filter_map(|r| r["lapCount"].as_i64()).sum();
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
    let best = all
        .iter()
        .filter_map(|r| r["bestLapMs"].as_i64())
        .filter(|n| *n > 0)
        .min();
    // Left: who runs now, then the laps that came in.
    let mut left = col()
        .grow(1.0)
        .w(0.0)
        .min_w(0.0)
        .child(hex::now_block(s))
        .child(hex::label(s, "Laatste rondes", None).mt(22.0));
    if history.is_empty() {
        left = left.child(
            hex::group(s).child(
                hex::item(s, true).child(
                    text("Nog geen rondes geregistreerd.")
                        .font(hex::ts(14.5, 400.0))
                        .color(c.ink3),
                ),
            ),
        );
    } else {
        let mut list = hex::group(s).key("overview-laps");
        for (i, lap) in history.iter().take(7).enumerate() {
            let ms = lap["durationMs"].as_i64().unwrap_or(0);
            let at = chrono::DateTime::from_timestamp_millis(lap["finishedAt"].as_i64().unwrap_or(0))
                .map(|time| {
                    time.with_timezone(&chrono_tz::Europe::Brussels)
                        .format("%H:%M")
                        .to_string()
                })
                .unwrap_or_default();
            let mut name = row().grow(1.0).min_w(0.0).gap(10.0).center_y().child(
                text(lap["runnerName"].as_str().unwrap_or("").to_string())
                    .font(hex::ts(15.0, 450.0))
                    .color(t.text)
                    .truncate()
                    .min_w(0.0),
            );
            if best == Some(ms) {
                name = name.child(hex::flag(s, "Snelste", true));
            }
            list = list.child(
                hex::item(s, i == 0)
                    .child(hex::number(s, lap["runnerNumber"].as_str().unwrap_or(""), 14.5, 36.0))
                    .child(name)
                    .child(text(at).font(hex::ts(14.0, 400.0)).color(c.ink3))
                    .child(
                        text(lap_duration(ms))
                            .font(hex::ts(15.0, 550.0))
                            .color(t.text)
                            .w(78.0)
                            .align(rune::Align::End),
                    ),
            );
        }
        left = left.child(list);
    }

    // Right: the race in numbers, the change-over zone and the laptops.
    let warming = all.iter().filter(|r| r["status"] == "warming_up").count();
    let waiting_count = all.iter().filter(|r| r["status"] == "waiting").count();
    let ran = all
        .iter()
        .filter(|r| r["lapCount"].as_i64().unwrap_or(0) > 0)
        .count();
    let chevron = |s: &State| super::admin_kit::icon(s, "chevron", c.ink3, 14.0);
    let nav_row = |s: &State, first: bool, key: String, icon: usize, title: &str, value: String, page: usize| {
        let mut r = hex::item(s, first)
            .key(key)
            .role("link")
            .label(format!("{title}: {value}"))
            .focusable(true)
            .hover(c.surface2)
            .on_press_tx(move |s: &mut State, tx: &mut Tx| {
                tx.instant();
                s.page = page;
                s.confirm = None;
            });
        if let Some(img) = s.icons.get(icon * 3 + usize::from(s.dark)) {
            r = r.child(rune::el().size(18.0, 18.0).pixels(img.pixels()));
        }
        r.child(
            text(title.to_string())
                .font(hex::ts(15.0, 450.0))
                .color(t.text)
                .grow(1.0),
        )
        .child(text(value).font(hex::ts(15.0, 550.0)).color(t.text))
        .child(chevron(s))
    };
    let mut right = col()
        .grow(1.0)
        .w(0.0)
        .min_w(0.0)
        .child(hex::stats(
            s,
            vec![
                ("Racetijd", race_time(s)),
                ("Rondes", total.to_string()),
                ("Per uur", pace),
                ("Snelste ronde", best.map(lap_duration).unwrap_or_else(|| "—".into())),
            ],
        ))
        .child(hex::label(s, "Wisselzone", None).mt(22.0))
        .child(
            hex::group(s)
                .child(nav_row(s, true, "overview-nav-1".into(), 1, "Opwarmen", warming.to_string(), 1))
                .child(nav_row(s, false, "overview-ready".into(), 2, "Klaar om te lopen", waiting_count.to_string(), 1))
                .child(nav_row(s, false, "overview-nav-3".into(), 3, "Heeft gelopen", ran.to_string(), 3)),
        );
    let open = !race["raceStartedAt"].is_null() && race["raceFinishedAt"].is_null();
    if waiting_count < 3 && open {
        right = right.child(
            text(format!(
                "Nog maar {waiting_count} {} klaar. Zet lopers klaar in Wachtrij.",
                if waiting_count == 1 { "loper" } else { "lopers" }
            ))
            .font(hex::ts(13.5, 500.0))
            .color(c.ink2)
            .wrap()
            .mt(10.0)
            .px(4.0),
        );
    }

    let mut system = hex::group(s).key("overview-system");
    let mut first = true;
    if let Some(st) = shell::system_status(s) {
        let (dot, _, _) = shell::tone_colors(st.tone, s.dark);
        system = system.child(
            hex::item(s, true)
                .key("overview-status")
                .label(format!("{}: {}. Open Beheer › Systeem & herstel.", st.title, st.detail))
                .role(if st.tone == shell::Tone::Error { "alert" } else { "link" })
                .focusable(true)
                .hover(c.surface2)
                .on_press_tx(|s: &mut State, tx: &mut Tx| {
                    tx.instant();
                    s.page = 8;
                    s.admin_section = 6;
                })
                .child(shell::dot(dot).size(8.0, 8.0).radius(4.0))
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .child(
                            text(if st.tone == shell::Tone::Healthy { "Alles in orde" } else { st.title })
                                .font(hex::ts(15.0, 450.0))
                                .color(t.text),
                        )
                        .child(text(st.detail).font(hex::ts(13.0, 400.0)).color(c.ink3).wrap()),
                )
                .child(chevron(s)),
        );
        first = false;
    }
    let cluster = &s.snapshot["cluster"];
    if cluster["enabled"] == true {
        let members = cluster["members"].as_array().map_or(1, Vec::len);
        let healthy = cluster["state"] == "healthy" || cluster["state"] == "solo";
        let (dot, _, _) = shell::tone_colors(
            if healthy { shell::Tone::Healthy } else { shell::Tone::Warning },
            s.dark,
        );
        system = system.child(
            hex::item(s, first)
                .key("overview-laptops")
                .label("Laptops in de groep. Open Beheer › Systeem & herstel.")
                .role("link")
                .focusable(true)
                .hover(c.surface2)
                .on_press_tx(|s: &mut State, tx: &mut Tx| {
                    tx.instant();
                    s.page = 8;
                    s.admin_section = 6;
                })
                .child(shell::dot(dot).size(8.0, 8.0).radius(4.0))
                .child(text("Laptops").font(hex::ts(15.0, 450.0)).color(t.text).grow(1.0))
                .child(
                    text(if members == 1 {
                        "Alleen deze".to_string()
                    } else if healthy {
                        format!("{members} bijgewerkt")
                    } else {
                        format!("{members} in de groep")
                    })
                    .font(hex::ts(15.0, 550.0))
                    .color(t.text),
                )
                .child(chevron(s)),
        );
        first = false;
    }
    system = system.child(
        hex::item(s, first)
            .child(shell::dot(c.ink3).size(8.0, 8.0).radius(4.0))
            .child(text("Lopers in de databank").font(hex::ts(15.0, 450.0)).color(t.text).grow(1.0))
            .child(text(all.len().to_string()).font(hex::ts(15.0, 550.0)).color(t.text)),
    );
    right = right.child(hex::label(s, "Systeem", None).mt(22.0)).child(system);

    row()
        .key("overview")
        .w_full()
        .max_w(1280.0)
        .gap(24.0)
        .items_start()
        .child(left)
        .child(right)
}
