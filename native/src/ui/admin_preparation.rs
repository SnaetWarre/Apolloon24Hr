//! Beheer › Voorbereiding: Wedstrijdgereedheid and Inschrijvingen importeren. Port of
//! src/components/admin/PreparationSection.tsx.
use super::admin_base::{Kind, Pending, banner, btn, copy, h2, pal, send, stack, ts};
use super::*;

fn import(s: &mut State) {
    if s.busy || !s.connected {
        return;
    }
    let Some((name, bytes)) = &s.import_file else {
        return;
    };
    s.import_problems.clear();
    let (method, input) = if name.to_lowercase().ends_with(".xlsx") {
        (
            "runners.importXlsx",
            json!({"dataBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
        )
    } else {
        ("runners.importCsv", json!({"csvText":decode_csv(bytes)}))
    };
    send(s, method, input, Pending::Import);
    if s.busy {
        s.import_file = None;
        s.import_preview = None;
    }
}

pub(super) fn analysis(s: &State) -> Option<Result<Value, String>> {
    let (name, bytes) = s.import_file.as_ref()?;
    let (method, input) = if name.to_lowercase().ends_with(".xlsx") {
        (
            "runners.importXlsx",
            json!({"dataBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
        )
    } else {
        ("runners.importCsv", json!({"csvText":decode_csv(bytes)}))
    };
    Some(crate::runner_import::preview(
        method,
        &input,
        s.snapshot["runners"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    ))
}

pub(super) fn section(s: &State) -> El {
    let p = pal(s.dark);
    let importing = matches!(s.admin.pending, Some(Pending::Import));
    let file_name = s
        .import_file
        .as_ref()
        .map(|(name, _)| name.clone())
        .or_else(|| s.admin.import_failed.clone())
        .unwrap_or_else(|| "Geen bestand gekozen".into());
    let preview = s.import_preview.as_ref();
    let ready = matches!(preview, Some(Ok(_)));
    let mut import_button = btn(
        s,
        "import-runners",
        if importing {
            "Importeren..."
        } else {
            "Importeren"
        },
        Kind::Primary,
        false,
        !ready || importing,
    )
    .min_w(104.0);
    if ready && !importing {
        import_button = import_button.on_press(import);
    }
    let mut card = super::admin_kit::panel()
        .key("import-panel")
        .child(h2(s, "Inschrijvingen importeren").mb(8.0))
        .child(copy(s, "Kies het Excel-bestand of de CSV-export van het inschrijvingsformulier. Nieuwe lopers komen in de databank en verschijnen op het bord zodra je ze aanmeldt in Wachtrij. Het rijnummer wordt het lopersnummer en alle antwoorden komen in het profiel."))
        .child(
            row()
                .mt(12.0)
                .gap(12.0)
                .center_y()
                .child(
                    btn(s, "choose-import", "Bestand kiezen", Kind::Plain, false, false)
                        .on_press_tx(|s: &mut State, tx: &mut Tx| {
                            s.admin.import_failed = None;
                            choose_import(s, tx)
                        }),
                )
                .child(
                    text(file_name)
                        .font(ts(13.0, 400.0))
                        .color(p.t.ink3)
                        .grow(1.0)
                        .min_w(0.0)
                        .wrap_anywhere(),
                )
                .child(import_button),
        );
    if let Some(preview) = preview {
        let mut panel = super::admin_base::panel(s)
            .mt(12.0)
            .child(h2(s, "Importvoorbeeld — nog niet opgeslagen"));
        match preview {
            Ok(preview) => {
                panel = panel.child(copy(s, &format!("{} rijen · {} mogelijke dubbels · {} problemen. Controleer dit voor je importeert. De bestaande importregels blijven gelden; ongeldige rijen kunnen worden overgeslagen.", preview["rowCount"], preview["duplicates"].as_array().unwrap().len(), preview["problems"].as_array().unwrap().len())));
                let columns = preview["columns"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| {
                        format!(
                            "{} → {}",
                            c["header"].as_str().unwrap(),
                            c["mapping"].as_str().unwrap()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" · ");
                panel = panel.child(copy(s, &columns));
                for key in ["duplicates", "problems"] {
                    for item in preview[key].as_array().unwrap() {
                        panel = panel.child(
                            row().gap(8.0).items_start()
                                .child(text("!").font(ts(13.5, 600.0)).color(p.t.warn))
                                .child(copy(s, item.as_str().unwrap())),
                        );
                    }
                }
            }
            Err(error) => panel = panel.child(copy(s, error.as_str())),
        }
        card = card.child(
            panel.child(
                btn(
                    s,
                    "cancel-import",
                    "Annuleren",
                    Kind::Plain,
                    false,
                    importing,
                )
                .on_press(|s: &mut State| {
                    s.import_file = None;
                    s.import_preview = None;
                    s.import_problems.clear();
                }),
            ),
        );
    }
    if let Some(name) = &s.admin.import_failed {
        card = card.child(
            banner(s, true).mt(12.0).role("alert").child(
                text(format!(
                    "{name} kon niet gelezen worden. Staat het nog open in Excel? Sluit het en kies het opnieuw."
                ))
                .font(ts(13.5, 400.0).lh(20.25))
                .color(p.ink)
                .wrap(),
            ),
        );
    }
    if !s.import_problems.is_empty() {
        let mut problems = banner(s, false).key("import-problems").mt(12.0).child(
            text("Nakijken in het bestand")
                .font(ts(13.5, 600.0).lh(20.25))
                .color(p.ink),
        );
        for problem in &s.import_problems {
            problems = problems.child(
                row()
                    .gap(8.0)
                    .pl(6.0)
                    .items_start()
                    .child(text("•").font(ts(13.5, 400.0).lh(20.25)).color(p.ink))
                    .child(
                        text(problem.clone())
                            .font(ts(13.5, 400.0).lh(20.25))
                            .color(p.ink)
                            .wrap()
                            .grow(1.0)
                            .min_w(0.0),
                    ),
            );
        }
        card = card.child(problems);
    }
    let mut page = vec![readiness::panel(s)];
    if let Some(group) = group_card(s) {
        page.push(group);
    }
    page.push(card);
    stack(s, page)
}

/// Groep maken at a glance: which laptops are linked.
fn group_card(s: &State) -> Option<El> {
    let c = &s.snapshot["cluster"];
    if c["enabled"] != true {
        return None;
    }
    let members = c["members"].as_array().cloned().unwrap_or_default();
    let summary = if members.len() > 1 {
        let names: Vec<String> = members.iter().map(admin_system::laptop_label).collect();
        format!("{} laptops gekoppeld: {}.", members.len(), names.join(", "))
    } else {
        "Deze laptop werkt nog alleen. Koppel de andere laptops en test de groep, alles op één scherm.".into()
    };
    Some(
        super::admin_kit::panel()
            .key("preparation-group")
            .child(h2(s, "Groep maken").mb(8.0))
            .child(copy(s, summary).role("status"))
            .child(
                row().mt(12.0).child(
                    btn(s, "preparation-group-open", "Groep maken openen", Kind::Plain, false, false).on_press_tx(
                        |s: &mut State, tx: &mut Tx| {
                            tx.instant();
                            s.admin_section = 6;
                            s.admin.select = None;
                        },
                    ),
                ),
            ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsent_import_preserves_the_file_and_preview() {
        let mut s = init_with_url("http://127.0.0.1:1".into());
        s.fixture = true;
        let file = ("lopers.csv".to_string(), b"nummer,naam\n1,Demo Ster".to_vec());
        s.import_file = Some(file.clone());
        s.import_preview = analysis(&s);
        let preview = s.import_preview.clone();
        for (connected, busy) in [(false, false), (true, true)] {
            s.connected = connected;
            s.busy = busy;
            import(&mut s);
            assert_eq!(s.import_file, Some(file.clone()));
            assert_eq!(s.import_preview, preview);
            assert!(s.admin.pending.is_none());
        }
        let (tx, rx) = std::sync::mpsc::channel();
        s.tx = tx;
        s.connected = true;
        s.busy = false;
        import(&mut s);
        assert_eq!(rx.try_recv().unwrap().method, "runners.importCsv");
        assert!(s.import_file.is_none());
        assert!(s.import_preview.is_none());
        assert!(matches!(s.admin.pending, Some(Pending::Import)));
    }
}
