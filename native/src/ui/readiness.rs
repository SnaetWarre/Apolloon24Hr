//! Wedstrijdgereedheid: backups, disk space and the linked laptops. Port of src/lib/readiness.ts.
use super::*;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub(super) enum Level {
    Blocked,
    Warning,
    Ready,
}
pub(super) struct Check {
    pub id: &'static str,
    pub label: &'static str,
    pub level: Level,
    pub detail: String,
}
fn check(id: &'static str, label: &'static str, level: Level, detail: impl Into<String>) -> Check {
    Check {
        id,
        label,
        level,
        detail: detail.into(),
    }
}
/// The checks, blocking problems first; within a level the order of readiness.ts stays.
pub(super) fn checks(s: &State) -> Vec<Check> {
    let b = &s.recovery["status"];
    let mut checks = Vec::new();
    let count = runners(s).len();
    checks.push(check(
        "registrations",
        "Inschrijvingen",
        if count == 0 {
            Level::Blocked
        } else {
            Level::Ready
        },
        if count == 0 {
            "Er staan nog geen lopers in de databank.".into()
        } else {
            format!("Er staan {count} lopers in de databank.")
        },
    ));
    let screens = s.snapshot["screens"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|screen| {
            screen["kind"].as_str().and_then(screen_name).map(|name| {
                format!(
                    "{name} ({})",
                    screen["address"].as_str().unwrap_or("onbekend adres")
                )
            })
        })
        .collect::<Vec<_>>();
    checks.push(check("screens", "Schermen", if screens.is_empty() { Level::Warning } else { Level::Ready }, if screens.is_empty() {
        "Er zijn nog geen schermen open op deze laptop. Schermen op andere laptops tellen hier niet mee.".into()
    } else {
        format!("Open op deze laptop: {}.", screens.join(", "))
    }));
    if !s.connected || b.is_null() {
        checks.push(check(
            "server-status",
            "Serverstatus",
            Level::Blocked,
            "De serverstatus kon niet worden geladen.",
        ));
        checks.sort_by_key(|c| c.level);
        return checks;
    }
    let age = b["latest"]["createdAt"].as_i64().map(|t| (s.clock - t).max(0));
    let stale = age.is_none_or(|age| age > b["intervalMs"].as_i64().unwrap_or(300_000) * 3);
    let enabled = b["enabled"] == true;
    let error = b["lastError"].as_str();
    checks.push(check(
        "backup",
        "Herstelbackup",
        if !enabled || error.is_some() || stale { Level::Blocked } else { Level::Ready },
        if !enabled {
            "Automatische backups zijn uitgeschakeld.".to_string()
        } else if let Some(error) = error {
            format!("Laatste fout: {error}")
        } else if age.is_none() {
            "Er is nog geen gecontroleerde backup.".into()
        } else if stale {
            "De laatste backup is ouder dan drie backupintervallen.".into()
        } else {
            "Er is een recente gecontroleerde backup.".into()
        },
    ));
    let low = b["diskLow"] == true;
    let unknown = b["diskFreeBytes"].is_null();
    checks.push(check(
        "disk-space",
        "Opslagruimte",
        if low { Level::Blocked } else if unknown { Level::Warning } else { Level::Ready },
        if low {
            "De vrije ruimte zit onder de veiligheidsgrens."
        } else if unknown {
            "Vrije opslagruimte kon niet worden gemeten."
        } else {
            "Er is voldoende vrije ruimte voor nieuwe backups."
        },
    ));
    let cluster = &s.snapshot["cluster"];
    if cluster["enabled"] != true {
        checks.push(check(
            "replica",
            "Gekoppelde laptops",
            Level::Warning,
            "Koppelen staat uit op deze installatie; de gegevens staan alleen op deze laptop.",
        ));
    } else {
        checks.push(group_check(cluster));
        if let Some(error) = cluster["lastError"].as_str() {
            checks.push(check("cluster-error", "Laptops", Level::Warning, error));
        }
    }
    checks.sort_by_key(|c| c.level);
    checks
}
fn group_check(cluster: &Value) -> Check {
    let members: Vec<&Value> = cluster["members"].as_array().into_iter().flatten().collect();
    let total = members.len();
    let reachable = members.iter().filter(|m| m["reachable"] == true).count();
    let offline: Vec<&str> = members.iter().filter(|m| m["reachable"] != true).map(|m| m["name"].as_str().unwrap_or("")).collect();
    let c = |level, detail: String| check("replica", "Gekoppelde laptops", level, detail);
    match cluster["state"].as_str().unwrap_or("") {
        "solo" => c(Level::Blocked, "Deze laptop staat er alleen voor. Koppel de andere laptops in Beheer › Systeem, zodat een defecte laptop geen gegevens kost.".into()),
        "electing" => c(Level::Warning, "De laptops kiezen wie de wijzigingen ordent. Dit duurt enkele seconden.".into()),
        "no-majority" => c(Level::Blocked, "Te weinig laptops bereikbaar: wijzigingen worden niet bewaard. Zet de andere laptops aan of controleer de netwerkkabel.".into()),
        "degraded" => c(
            Level::Warning,
            if reachable < total {
                format!(
                    "{reachable} van de {total} laptops zijn bereikbaar. Alles werkt nog; zet {} weer aan.",
                    if offline.iter().all(|n| !n.is_empty()) { offline.join(" en ") } else { "de andere laptop".into() }
                )
            } else {
                "Een laptop haalt de laatste wijzigingen op.".into()
            },
        ),
        _ if total == 2 => c(Level::Warning, "Twee laptops gekoppeld. Koppel een derde: met twee stopt het bewaren als er één uitvalt.".into()),
        _ => c(Level::Ready, format!("Alle {total} laptops zijn bereikbaar en hebben alle gegevens.")),
    }
}
pub(super) fn summary(checks: &[Check]) -> Level {
    checks.iter().filter(|c| c.id != "screens").map(|c| c.level).min().unwrap_or(Level::Ready)
}
pub(super) fn open_count(checks: &[Check]) -> usize {
    checks.iter().filter(|c| c.id != "screens" && c.level != Level::Ready).count()
}
/// Whether the Systeem tab gets its attention dot.
pub(super) fn needs_attention(s: &State) -> bool {
    checks(s)
        .iter()
        .any(|c| c.id != "screens" && c.level != Level::Ready)
}

pub(super) fn screen_name(kind: &str) -> Option<&'static str> {
    match kind {
        "inside" => Some("Binnenscherm"),
        "competitions" => Some("Competitiescherm"),
        "outside" => Some("Buitenscherm"),
        _ => None,
    }
}

pub(super) fn screen_links(s: &State, url: &str, key: &str) -> El {
    let mut links = row().gap(8.0).flex_wrap();
    for kind in ["inside", "competitions", "outside"] {
        let open = s.snapshot["screens"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|screen| screen["kind"] == kind);
        let label = format!(
            "{}{}",
            screen_name(kind).unwrap(),
            if open { " · open" } else { "" }
        );
        let address = format!("{}/display/{kind}", url.trim_end_matches('/'));
        let shown = address.clone();
        links = links.child(
            col()
                .gap(4.0)
                .child(
                    admin_base::btn(
                        s,
                        &format!("{key}-{kind}"),
                        &label,
                        admin_base::Kind::Quiet,
                        true,
                        false,
                    )
                    .on_press_tx(move |_: &mut State, tx: &mut Tx| tx.copy(&address)),
                )
                .child(admin_base::copy(s, shown)),
        );
    }
    col().gap(6.0).child(links).child(admin_base::copy(s, "Kopieer de link van het scherm en open die in een browser op het tweede scherm. Druk op F11 voor volledig scherm."))
}

/// `ReadinessPanel` from PreparationSection.tsx.
pub(super) fn panel(s: &State) -> El {
    use admin_base::{copy, h2, pal, ts};
    let p = pal(s.dark);
    let checks = checks(s);
    let level = summary(&checks);
    let open = open_count(&checks);
    let (wash, ink) = match level {
        Level::Ready => (p.t.go_wash, p.go_ink),
        Level::Warning => (p.t.warn_wash, p.t.warn_ink),
        Level::Blocked => (p.t.stop_wash, p.stop_ink),
    };
    let mut list = col().key("readiness-list").role("list").mt(12.0);
    let count = checks.len();
    for (i, c) in checks.into_iter().enumerate() {
        let (mark, fill, mark_ink) = match c.level {
            Level::Ready => ("✓", p.t.go, if s.dark { rune::oklch(0.161, 0.019, 162.8) } else { p.on_brand }),
            Level::Warning => ("!", p.t.warn, rune::oklch(0.189, 0.039, 78.4)),
            Level::Blocked => ("×", p.t.stop, if s.dark { rune::oklch(0.161, 0.019, 162.8) } else { p.on_brand }),
        };
        let mut body = col()
            .grow(1.0)
            .min_w(0.0)
            .child(text(c.label).font(ts(14.0, 600.0).lh(21.0)).color(p.ink))
            .child(text(c.detail).font(ts(13.5, 400.0).lh(20.25)).color(p.t.ink3).wrap().mt(2.0));
        if c.id == "replica" && c.level != Level::Ready {
            body = body.child(
                row().mt(8.0).child(
                    admin_base::btn(s, "readiness-system", "Naar Systeem & herstel", admin_base::Kind::Ghost, true, false)
                        .on_press_tx(|s: &mut State, tx: &mut Tx| {
                            tx.instant();
                            s.admin_section = 6;
                        }),
                ),
            );
        }
        let mut item = row()
            .role("listitem")
            .gap(12.0)
            .items_start()
            .py(11.0)
            .child(
                rune::el()
                    .size(22.0, 22.0)
                    .radius(11.0)
                    .center()
                    .fill(fill)
                    .child(text(mark).font(ts(13.0, 700.0)).color(mark_ink)),
            )
            .child(body);
        if i + 1 < count {
            item = item.border_sides([0.0, 0.0, 1.0, 0.0], p.line);
        }
        list = list.child(item);
    }
    super::admin_kit::panel()
        .key("readiness-panel")
        .child(
            row()
                .gap(12.0)
                .items_start()
                .justify_between()
                .child(
                    col()
                        .min_w(0.0)
                        .shrink()
                        .child(h2(s, "Wedstrijdgereedheid"))
                        .child(copy(s, "Eén overzicht van backups, opslagruimte en de gekoppelde laptops.")),
                )
                .child(
                    text(match level {
                        Level::Ready => "Klaar".to_string(),
                        Level::Warning => format!("Aandacht nodig · {open} open"),
                        Level::Blocked => format!("Niet klaar · {open} open"),
                    })
                    .font(ts(14.0, 600.0).lh(21.0))
                    .color(ink)
                    .py(5.0)
                    .px(10.0)
                    .radius(6.0)
                    .fill(wash),
                ),
        )
        .child(list)
}
