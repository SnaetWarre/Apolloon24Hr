//! Lopersprofiel: number and name, the live status, queue action, contact and hours, labels,
//! notes, the registration answers and the last laps. Port of src/components/RunnerProfileModal.tsx
//! and AvailableHoursPicker.tsx.
use super::admin_base::{
    Confirm, ConfirmAction, Kind, Pending, btn, field, fold, overlay, overlay_shadow, pal, pill, runner_label, send, st,
    ts,
};
use super::*;

const WEEKDAYS: [&str; 7] = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];

pub(super) fn clocks(s: &State, clock: &mut clock::Sample) {
    if let Some(form) = &s.profile {
        if let Some(r) = runner(s, &form.id) {
            if !matches!(st(r, "status"), "registered" | "ran") {
                if let Some(at) = r["statusSince"].as_i64() {
                    clock.value(elapsed(s).map(|t| t.len()));
                    clock.live_bucket(at, 1000);
                }
            }
        }
    }
}

/// "voor m:ss": how long the open profile's runner has been in their lane.
pub(super) fn elapsed(s: &State) -> Option<String> {
    let r = runner(s, &s.profile.as_ref()?.id)?;
    if matches!(st(r, "status"), "registered" | "ran") { return None; }
    r["statusSince"].as_i64().map(|since| format!("voor {}", duration(s.clock - since)))
}

pub(super) struct Form {
    id: String,
    pub(super) number: TextEdit,
    name: TextEdit,
    notes: TextEdit,
    phone: TextEdit,
    email: TextEdit,
    hours: Vec<String>,
    labels: Vec<String>,
    /// The stored profile the form started from, to spot unsaved edits and edits made elsewhere.
    baseline: String,
    close_prompt: bool,
    error: String,
    /// What a drag over the hour slots paints.
    paint: Option<bool>,
}
fn strings(v: &Value) -> Vec<String> {
    v.as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_owned)).collect()
}
fn label_ids(r: &Value) -> Vec<String> {
    r["labels"].as_array().into_iter().flatten().map(|l| st(l, "id").to_string()).collect()
}
/// `getEditableRunnerKey`: what the form edits, as stored.
fn stored_key(r: &Value, reg: &Value) -> String {
    let mut labels = label_ids(r);
    labels.sort();
    [
        st(r, "id").to_string(),
        st(r, "runnerNumber").to_string(),
        st(r, "name").to_string(),
        st(r, "notes").to_string(),
        labels.join("|"),
        st(reg, "phone").to_string(),
        st(reg, "email").to_string(),
        strings(&reg["availableHours"]).join("|"),
    ]
    .join("\u{1}")
}
impl Form {
    pub(super) fn runner_id(&self) -> &str { &self.id }
    pub(super) fn new(runner: &Value, registration: &Value) -> Self {
        Self {
            id: st(runner, "id").to_string(),
            number: TextEdit::new(st(runner, "runnerNumber")),
            name: TextEdit::new(st(runner, "name")),
            notes: TextEdit::new(st(runner, "notes")),
            phone: TextEdit::new(st(registration, "phone")),
            email: TextEdit::new(st(registration, "email")),
            hours: strings(&registration["availableHours"]),
            labels: label_ids(runner),
            baseline: stored_key(runner, registration),
            close_prompt: false,
            error: String::new(),
            paint: None,
        }
    }
    fn draft_key(&self) -> String {
        let mut labels = self.labels.clone();
        labels.sort();
        [
            self.id.clone(),
            self.number.text.trim().to_string(),
            self.name.text.trim().to_string(),
            self.notes.text.clone(),
            labels.join("|"),
            self.phone.text.trim().to_string(),
            self.email.text.trim().to_string(),
            self.hours.join("|"),
        ]
        .join("\u{1}")
    }
}
fn runner<'a>(s: &'a State, id: &str) -> Option<&'a Value> {
    runners(s).into_iter().find(|r| st(r, "id") == id)
}
fn registration<'a>(s: &'a State, id: &str) -> &'a Value {
    &s.admin.registrations[id]
}
pub(super) fn open(s: &mut State, id: &str) {
    #[cfg(target_arch = "wasm32")]
    if s.history["scope"] != "full" {
        s.send("runners.profile", json!({"id":id}));
        return;
    }
    let Some(r) = runner(s, id) else { return };
    let form = Form::new(r, registration(s, id));
    s.profile = Some(form);
}
fn form_mut(s: &mut State) -> &mut Form {
    s.profile.as_mut().expect("profile field without its dialog")
}
fn dirty(s: &State, f: &Form) -> bool {
    f.draft_key() != f.baseline && runner(s, &f.id).is_some()
}
fn changed_elsewhere(s: &State, f: &Form) -> bool {
    runner(s, &f.id).is_some_and(|r| stored_key(r, registration(s, &f.id)) != f.baseline)
}
/// An untouched profile follows the stored one; an unsaved draft is never replaced.
pub(super) fn follow_stored(s: &mut State) {
    let Some(f) = &s.profile else { return };
    if f.close_prompt || f.draft_key() != f.baseline {
        return;
    }
    if let Some(r) = runner(s, &f.id)
        && stored_key(r, registration(s, &f.id)) != f.baseline
    {
        let id = f.id.clone();
        open(s, &id);
    }
}
pub(super) fn load_latest(s: &mut State) {
    if let Some(id) = s.profile.as_ref().map(|f| f.id.clone()) {
        open(s, &id);
    }
}
fn saving(s: &State) -> bool {
    matches!(s.admin.pending, Some(Pending::ProfileSaved(_)))
}
fn save(s: &mut State) {
    let Some(f) = &s.profile else { return };
    if saving(s) || changed_elsewhere(s, f) {
        return;
    }
    let name = f.name.text.trim().to_string();
    if name.is_empty() {
        form_mut(s).error = "Naam is verplicht.".into();
        return;
    }
    let input = json!({"id": f.id, "fields": {
        "runnerNumber": f.number.text,
        "name": f.name.text,
        "notes": f.notes.text,
        "registrationDetails": {"phone": f.phone.text, "email": f.email.text, "availableHours": f.hours},
        "labels": f.labels,
    }});
    form_mut(s).error.clear();
    send(s, "runners.update", input, Pending::ProfileSaved(name));
}
pub(super) fn save_failed(s: &mut State) {
    let message = std::mem::take(&mut s.error);
    if let Some(f) = &mut s.profile {
        f.error = if message.is_empty() { "Profiel opslaan mislukt".into() } else { message };
    }
}
fn request_close(s: &mut State) {
    if saving(s) {
        return;
    }
    match &s.profile {
        Some(f) if dirty(s, f) => form_mut(s).close_prompt = true,
        _ => s.profile = None,
    }
}
fn set_status(s: &mut State, status: &str) {
    let Some(f) = &s.profile else { return };
    let Some(r) = runner(s, &f.id) else { return };
    let (id, name) = (st(r, "id").to_string(), st(r, "name").to_string());
    match status {
        "registered" => {
            s.admin.confirm = Some(Confirm {
                title: "Uit de wachtrij halen?".into(),
                message: format!("{name} verdwijnt uit de wachtrij en opwarming."),
                confirm_label: "Uit wachtrij halen".into(),
                danger: false,
                action: ConfirmAction::LeaveQueue { id, name },
            });
        }
        _ => send(
            s,
            "runners.setStatus",
            json!({"id":id,"status":"warming_up"}),
            Pending::Status { ok: format!("{name} staat bij opwarming."), failure: "Loper activeren mislukt" },
        ),
    }
}
/// A runner runs for one speedteam, so picking one drops the other.
fn toggle_label(s: &mut State, id: &str) {
    let kinds: Vec<(String, String)> = s.snapshot["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|l| (st(l, "id").to_string(), st(l, "kind").to_string()))
        .collect();
    let kind_of = |x: &str| kinds.iter().find(|(i, _)| i == x).map(|(_, k)| k.clone()).unwrap_or_default();
    let speed = kind_of(id) == "speedteam";
    let f = form_mut(s);
    if f.labels.iter().any(|l| l == id) {
        f.labels.retain(|l| l != id);
    } else {
        if speed {
            f.labels.retain(|l| kind_of(l) != "speedteam");
        }
        f.labels.push(id.to_string());
    }
}

// ---------- Hours (AvailableHoursPicker, setHourBlock) ----------

fn parse_block(text: &str) -> Option<(u32, u32, Option<String>)> {
    let t = text.trim();
    let (hours, weekday) = match t.find('(') {
        Some(i) => {
            let day = t[i + 1..].trim().strip_suffix(')')?.trim().to_lowercase();
            (t[..i].trim(), (!day.is_empty()).then_some(day))
        }
        None => (t, None),
    };
    let (a, b) = hours.split_once(['-', '–'])?;
    let num = |v: &str| -> Option<u32> {
        let v = v.trim().trim_end_matches(['u', 'U']).trim();
        (!v.is_empty() && v.len() <= 2 && v.chars().all(|c| c.is_ascii_digit())).then(|| v.parse().ok()).flatten()
    };
    let (start, end) = (num(a)?, num(b)?);
    if start > 23 || end > 24 || start == end {
        return None;
    }
    Some((start, if end == 24 { 0 } else { end }, weekday))
}
fn block_covers(b: &(u32, u32, Option<String>), weekday: &str, hour: u32) -> bool {
    if b.2.as_deref().is_some_and(|d| d != weekday) {
        return false;
    }
    if b.1 <= b.0 { hour >= b.0 || hour < b.1 } else { hour >= b.0 && hour < b.1 }
}
fn has_hour(texts: &[String], weekday: &str, hour: u32) -> bool {
    texts.iter().any(|t| parse_block(t).is_some_and(|b| block_covers(&b, weekday, hour)))
}
fn block_text(hour: u32, weekday: Option<&str>) -> String {
    match weekday {
        Some(d) => format!("{hour:02}-{:02}u ({d})", (hour + 1) % 24),
        None => format!("{hour:02}-{:02}u", (hour + 1) % 24),
    }
}
fn position(text: &str) -> usize {
    match parse_block(text) {
        Some((start, _, Some(day))) => {
            WEEKDAYS.iter().position(|d| *d == day).unwrap_or(WEEKDAYS.len()) * 24 + start as usize
        }
        _ => usize::MAX,
    }
}
fn set_hour(texts: &[String], weekday: &str, hour: u32, on: bool) -> Vec<String> {
    if on {
        if has_hour(texts, weekday, hour) {
            return texts.to_vec();
        }
        let mut list = texts.to_vec();
        list.push(block_text(hour, Some(weekday)));
        list.sort_by(|a, b| position(a).cmp(&position(b)).then(fold(a).cmp(&fold(b))));
        return list;
    }
    texts
        .iter()
        .flat_map(|t| match parse_block(t) {
            Some(b) if block_covers(&b, weekday, hour) => {
                let mut out = Vec::new();
                let mut h = b.0;
                while h != b.1 {
                    if h != hour {
                        out.push(block_text(h, b.2.as_deref()));
                    }
                    h = (h + 1) % 24;
                }
                out
            }
            _ => vec![t.clone()],
        })
        .collect()
}
fn paint(s: &mut State, weekday: &'static str, hour: u32, start: bool) {
    let f = form_mut(s);
    let on = if start {
        let on = !has_hour(&f.hours, weekday, hour);
        f.paint = Some(on);
        on
    } else {
        match f.paint {
            Some(on) if has_hour(&f.hours, weekday, hour) != on => on,
            _ => return,
        }
    };
    f.hours = set_hour(&f.hours, weekday, hour, on);
}
fn hours_picker(s: &State, f: &Form) -> El {
    let p = pal(s.dark);
    let mut days: Vec<(&'static str, Vec<u32>)> = Vec::new();
    let (mut day, mut hour) = (1usize, 20u32);
    for _ in 0..24 {
        match days.last_mut() {
            Some((d, hs)) if *d == WEEKDAYS[day] => hs.push(hour),
            _ => days.push((WEEKDAYS[day], vec![hour])),
        }
        hour = (hour + 1) % 24;
        if hour == 0 {
            day = (day + 1) % 7;
        }
    }
    let mut picker = col()
        .key("profile-hours")
        .role("group")
        .label("Beschikbare uren")
        .gap(8.0)
        .mt(12.0)
        .on_hover_change(|s: &mut State, on, _| {
            if !on && let Some(f) = &mut s.profile {
                f.paint = None;
            }
        })
        .child(text("Beschikbare uren").font(ts(13.5, 500.0)).color(p.t.ink2).mb(8.0));
    for (weekday, hours) in days {
        let mut slots = row().gap(4.0).flex_wrap().grow(1.0).min_w(0.0);
        for h in hours {
            let on = has_hour(&f.hours, weekday, h);
            slots = slots.child(
                row()
                    .key(format!("profile-hour-{weekday}-{h}"))
                    .role("button")
                    .label(block_text(h, Some(weekday)))
                    .checked(on)
                    .focusable(true)
                    .press_on_return()
                    .min_w(58.0)
                    .h(28.0)
                    .px(6.0)
                    .center()
                    .radius(6.0)
                    .fill(if on { p.brand_wash } else { p.surface })
                    .border(if on { 2.0 } else { 1.0 }, if on { p.brand } else { p.t.line2 })
                    .hover(if on { p.brand_wash } else { p.t.surface2 })
                    .on_press(move |s: &mut State| {
                        paint(s, weekday, h, true);
                        form_mut(s).paint = None;
                    })
                    .on_hover_change(move |s: &mut State, entered, _| {
                        if entered && s.profile.as_ref().is_some_and(|f| f.paint.is_some()) {
                            paint(s, weekday, h, false);
                        }
                    })
                    .child(
                        text(format!("{h:02}–{:02}", (h + 1) % 24))
                            .font(ts(13.0, 500.0))
                            .color(if on { p.brand_ink } else { p.ink }),
                    ),
            );
        }
        let mut name = weekday.to_string();
        name[..1].make_ascii_uppercase();
        picker = picker.child(
            row()
                .gap(12.0)
                .items_start()
                .child(text(name).font(ts(13.0, 400.0)).color(p.t.ink2).w(88.0).pt(5.0))
                .child(slots),
        );
    }
    picker.child(
        text("Sleep over meerdere uren om ze in één keer aan of uit te zetten.")
            .font(ts(12.5, 400.0))
            .color(p.t.ink3)
            .mt(4.0),
    )
}

// ---------- The dialog ----------

fn labelled(s: &State, title: &str, input: El) -> El {
    col()
        .gap(6.0)
        .grow(1.0)
        .w(0.0)
        .min_w(0.0)
        .child(text(title.to_string()).font(ts(13.0, 500.0)).color(pal(s.dark).t.ink2))
        .child(input)
}
macro_rules! profile_field {
    ($s:expr, $f:expr, $field:ident, $key:expr, $title:expr) => {
        field($s, &$f.$field, $key, $title, "").on_edit(|s: &mut State| &mut form_mut(s).$field)
    };
}
fn stat(s: &State, title: &str, value: El, last: bool) -> El {
    let p = pal(s.dark);
    let mut c = col()
        .grow(1.0)
        .w(0.0)
        .py(10.0)
        .px(16.0)
        .child(text(title.to_string()).font(ts(12.5, 400.0)).color(p.t.ink3))
        .child(value.font(ts(17.0, 550.0)).color(p.ink).mt(2.0));
    if !last {
        c = c.border_sides([0.0, 1.0, 0.0, 0.0], p.line);
    }
    c
}
fn h3(s: &State, title: &str, color: rune::Color) -> El {
    let _ = s;
    text(title.to_string()).font(ts(13.0, 600.0).lh(16.25)).color(color).role("heading").level(3)
}
pub(super) fn modal(s: &State) -> El {
    let f = s.profile.as_ref().unwrap();
    let p = pal(s.dark);
    let Some(r) = runner(s, &f.id) else {
        return overlay(s, "profile-overlay", |s: &mut State| s.profile = None);
    };
    let reg = registration(s, &f.id);
    let busy = saving(s);
    let elsewhere = changed_elsewhere(s, f);
    let status = st(r, "status");
    let mut laps: Vec<&Value> = laps(s).into_iter().filter(|l| st(l, "runnerId") == f.id).collect();
    laps.sort_by_key(|l| std::cmp::Reverse(l["finishedAt"].as_i64().unwrap_or(0)));

    let header = row()
        .mb(16.0)
        .gap(12.0)
        .items_start()
        .justify_between()
        .child(
            col()
                .min_w(0.0)
                .child(text("Lopersprofiel").font(ts(12.5, 400.0)).color(p.t.ink3).mb(2.0))
                .child(text(runner_label(r)).font(ts(20.0, 600.0).lh(25.0)).color(p.ink).role("heading").level(2)),
        )
        .child(
            row()
                .key("profile-close")
                .role("button")
                .label("Sluiten")
                .focusable(true)
                .press_on_return()
                .size(28.0, 28.0)
                .center()
                .radius(6.0)
                .hover(p.t.surface3)
                .on_press(request_close)
                .child(text("✕").font(ts(14.0, 400.0)).color(p.t.ink3)),
        );
    let elapsed = match elapsed(s) {
        Some(value) => super::live_clock::profile(s, value),
        None => text("—"),
    };
    let mut body = col()
        .min_w(0.0)
        .child(header)
        .child(
            row()
                .gap(12.0)
                .my(16.0)
                .child(labelled(s, "Lopersnummer", profile_field!(s, f, number, "profile-number", "Lopersnummer")))
                .child(labelled(s, "Naam", profile_field!(s, f, name, "profile-name", "Naam"))),
        )
        .child(
            row()
                .my(16.0)
                .radius(8.0)
                .border(1.0, p.line)
                .clip_rounded(8.0)
                .child(stat(s, admin_runners::status_label(status), elapsed, false))
                .child(stat(s, "Rondes", text(r["lapCount"].as_i64().unwrap_or(0).to_string()), false))
                .child(stat(
                    s,
                    "Laatste ronde",
                    text(laps.first().map(|l| lap_duration(l["durationMs"].as_i64().unwrap_or(0))).unwrap_or("—".into())),
                    false,
                ))
                .child(stat(
                    s,
                    "Snelste ronde",
                    text(r["bestLapMs"].as_i64().filter(|v| *v > 0).map(lap_duration).unwrap_or("—".into())),
                    true,
                )),
        );
    let queue = match status {
        "warming_up" => Some(("Uit opwarmen halen", "Haal deze loper uit de actieve lijst zonder profiel of rondedata te verwijderen.", false)),
        "waiting" => Some(("Uit wachtrij halen", "Haal deze loper uit de actieve lijst zonder profiel of rondedata te verwijderen.", false)),
        "registered" | "ran" => Some(("Opwarmen", "Zet deze loper bij opwarming.", true)),
        _ => None,
    };
    if let Some((title, detail, warm)) = queue {
        let pending = matches!(s.admin.pending, Some(Pending::Status { .. }));
        let mut action = btn(
            s,
            "profile-queue-action",
            if pending { "Bezig..." } else { title },
            if warm { Kind::Primary } else { Kind::Ghost },
            false,
            pending,
        );
        if !pending {
            action = action.on_press(move |s: &mut State| set_status(s, if warm { "warming_up" } else { "registered" }));
        }
        body = body.child(
            row()
                .mt(16.0)
                .gap(12.0)
                .py(12.0)
                .px(16.0)
                .center_y()
                .justify_between()
                .radius(8.0)
                .border(1.0, p.line)
                .child(
                    col()
                        .min_w(0.0)
                        .shrink()
                        .child(h3(s, "Wachtrij", p.t.ink2).mb(8.0))
                        .child(text(detail).font(ts(14.0, 400.0).lh(21.0)).color(p.t.ink2).wrap()),
                )
                .child(action),
        );
    }
    let mut contact = row().gap(12.0).child(labelled(
        s,
        "Telefoon",
        row().gap(8.0).child(profile_field!(s, f, phone, "profile-phone", "Telefoon").grow(1.0).w(0.0)),
    ));
    let mail = f.email.text.trim().to_string();
    let mut email_row = row().gap(8.0).child(profile_field!(s, f, email, "profile-email", "E-mail").grow(1.0).w(0.0));
    if mail.contains('@') {
        email_row = email_row.child(
            btn(s, "profile-mail", "Mailen", Kind::Ghost, false, false).on_press_tx(move |_: &mut State, tx: &mut Tx| {
                let _ = tx.open_url(&format!("mailto:{mail}"));
            }),
        );
    }
    contact = contact.child(labelled(s, "E-mail", email_row));
    let mut essentials = col()
        .role("group")
        .label("Contact en beschikbaarheid")
        .mt(16.0)
        .mb(20.0)
        .py(16.0)
        .px(20.0)
        .radius(8.0)
        .border(1.0, p.line)
        .fill(p.brand_wash)
        .child(text("Contact en beschikbaarheid").font(ts(14.0, 600.0).lh(17.5)).color(p.ink).mb(12.0))
        .child(contact)
        .child(hours_picker(s, f));
    if reg.is_null() {
        essentials = essentials.child(
            text(if st(r, "registrationSource") == "manual" {
                "Manueel toegevoegd, geen inschrijving."
            } else {
                "Geen inschrijvingsgegevens."
            })
            .font(ts(13.5, 400.0))
            .color(p.t.ink2)
            .mt(12.0),
        );
    }
    body = body.child(essentials);

    // Labels by kind, speedteams first.
    let mut labels: Vec<&Value> = s.snapshot["labels"].as_array().into_iter().flatten().collect();
    let order = |k: &str| match k {
        "speedteam" => 0,
        "zustervereniging" | "association" => 1,
        "andere" | "group" => 2,
        _ => 3,
    };
    labels.sort_by(|a, b| order(st(a, "kind")).cmp(&order(st(b, "kind"))).then(fold(st(a, "name")).cmp(&fold(st(b, "name")))));
    let mut groups = col().gap(16.0);
    let mut i = 0;
    while i < labels.len() {
        let kind = st(labels[i], "kind").to_string();
        let title = match order(&kind) {
            0 => "Speedteams",
            1 => "Zusterverenigingen",
            2 => "Andere",
            _ => "Custom",
        };
        let mut picker = row().gap(6.0).flex_wrap();
        while i < labels.len() && st(labels[i], "kind") == kind {
            let l = labels[i];
            let id = st(l, "id").to_string();
            let on = f.labels.contains(&id);
            let chip = pill(s, l, false)
                .key(format!("profile-label-{id}"))
                .role("checkbox")
                .label(st(l, "name").to_string())
                .checked(on)
                .focusable(true)
                .press_on_return()
                .h(30.0)
                .pl(8.0)
                .pr(10.0)
                .radius(6.0)
                .fill(if on { p.brand_wash } else { p.surface })
                .border(if on { 2.0 } else { 1.0 }, if on { p.brand } else { p.t.line2 })
                .on_press(move |s: &mut State| toggle_label(s, &id));
            picker = picker.child(chip);
            i += 1;
        }
        groups = groups.child(col().gap(8.0).child(h3(s, title, p.t.ink2)).child(picker));
    }
    body = body.child(groups).child(
        col().mt(16.0).gap(6.0).child(text("Notities").font(ts(13.0, 500.0)).color(p.t.ink2)).child(
            text_input(&f.notes, ts(13.5, 400.0).lh(20.25))
                .key("profile-notes")
                .label("Notities")
                .min_h(88.0)
                .px(10.0)
                .py(8.0)
                .w_full()
                .radius(6.0)
                .fill(p.surface)
                .color(p.ink)
                .border(1.0, p.t.line2)
                .focus_within_ring(3.0, 0.0, p.brand.alpha(0.22))
                .on_edit(|s: &mut State| &mut form_mut(s).notes),
        ),
    );

    let answers: Vec<(&str, String)> = [
        ("Studiefase", st(reg, "studyPhase").to_string()),
        ("Geschat totaal rondjes", st(reg, "estimatedLaps").to_string()),
        ("Geschat gemiddeld tempo op 515 m", st(reg, "estimatedPace").to_string()),
        ("Maximum rondjes per blok van 2 uur", st(reg, "maxLapsPerBlock").to_string()),
        ("Snelste (test)ronde", st(reg, "fastestLap").to_string()),
        ("Flexibiliteit", st(reg, "flexibility").to_string()),
        ("Categorieën", strings(&reg["categories"]).join(", ")),
        ("Toestemming voor hergebruik", st(reg, "reuseConsent").to_string()),
        ("Opmerking bij inschrijving", st(reg, "remarks").to_string()),
        ("Ingeschreven op", st(reg, "submittedAt").to_string()),
    ]
    .into_iter()
    .filter(|(_, v)| !v.trim().is_empty())
    .collect();
    if !answers.is_empty() {
        let mut grid = row().gap(12.0).flex_wrap();
        for (title, value) in answers {
            grid = grid.child(
                col()
                    .w(220.0)
                    .min_w(0.0)
                    .child(text(title).font(ts(12.5, 400.0)).color(p.t.ink3))
                    .child(text(value).font(ts(13.5, 400.0)).color(p.ink).wrap_anywhere().mt(1.0)),
            );
        }
        body = body.child(
            col()
                .role("group")
                .label("Inschrijvingsgegevens")
                .my(16.0)
                .padding(16.0)
                .radius(8.0)
                .border(1.0, p.line)
                .child(h3(s, "Inschrijvingsgegevens", p.t.ink2).mb(8.0))
                .child(grid),
        );
    }
    let mut recent = col().my(16.0).child(h3(s, "Laatste rondes", p.t.ink2).mb(8.0));
    if laps.is_empty() {
        recent = recent.child(text("Nog geen rondes geregistreerd.").font(ts(13.5, 400.0)).color(p.t.ink3).padding(16.0));
    } else {
        let cell = |v: String, head: bool| {
            text(v)
                .font(ts(if head { 12.0 } else { 13.0 }, if head { 500.0 } else { 400.0 }))
                .color(if head { p.t.ink3 } else { p.ink })
                .grow(1.0)
                .w(0.0)
                .px(10.0)
                .py(7.0)
        };
        let mut table = col()
            .radius(6.0)
            .border(1.0, p.line)
            .max_h(240.0)
            .clip_rounded(6.0)
            .child(
                row()
                    .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
                    .child(cell("Ronde".into(), true))
                    .child(cell("Tijd".into(), true))
                    .child(cell("Rondetijd".into(), true)),
            );
        let n = laps.len().min(10);
        for (i, l) in laps.iter().take(10).enumerate() {
            let finished = l["finishedAt"].as_i64().unwrap_or(0);
            let clock = chrono::DateTime::from_timestamp_millis(finished)
                .map(|d| format!("{}.{:03}", d.with_timezone(&chrono_tz::Europe::Brussels).format("%H:%M:%S"), finished.rem_euclid(1000)))
                .unwrap_or("—".into());
            let mut line = row()
                .child(cell(l["lapNumber"].as_i64().unwrap_or(0).to_string(), false))
                .child(cell(clock, false))
                .child(cell(lap_duration(l["durationMs"].as_i64().unwrap_or(0)), false));
            if i + 1 < n {
                line = line.border_sides([0.0, 0.0, 1.0, 0.0], p.line);
            }
            table = table.child(line);
        }
        recent = recent.child(table);
    }
    body = body.child(recent);
    if elsewhere {
        body = body.child(
            admin_base::banner(s, true)
                .role("alert")
                .child(
                    text("Dit profiel is intussen elders gewijzigd. Je invoer is bewaard. Kopieer je aanpassingen voordat je de nieuwste versie laadt en opnieuw bewerkt.")
                        .font(ts(13.5, 400.0).lh(20.25))
                        .color(p.ink)
                        .wrap(),
                )
                .child(row().child(btn(s, "profile-load-latest", "Nieuwste profiel laden", Kind::Ghost, false, false).on_press(
                    |s: &mut State| {
                        s.admin.confirm = Some(Confirm {
                            title: "Nieuwste profiel laden?".into(),
                            message: "Je niet-opgeslagen aanpassingen worden vervangen.".into(),
                            confirm_label: "Nieuwste laden".into(),
                            danger: true,
                            action: ConfirmAction::LoadLatestProfile,
                        })
                    },
                ))),
        );
    }
    if !f.error.is_empty() {
        body = body.child(
            admin_base::banner(s, true)
                .role("alert")
                .mt(8.0)
                .child(text(f.error.clone()).font(ts(13.5, 400.0).lh(20.25)).color(p.ink).wrap()),
        );
    }
    let mut ok = btn(s, "profile-save", if busy { "Opslaan..." } else { "Opslaan" }, Kind::Primary, false, busy || elsewhere);
    if !busy && !elsewhere {
        ok = ok.on_press(save);
    }
    body = body.child(
        row()
            .mt(20.0)
            .pt(16.0)
            .gap(8.0)
            .justify_end()
            .border_sides([1.0, 0.0, 0.0, 0.0], p.line)
            .child(btn(s, "profile-cancel", "Annuleer", Kind::Ghost, false, false).on_press(request_close))
            .child(ok),
    );
    let max_h = 860.0_f32.min(s.admin.window_h() * 0.9);
    let dialog = col()
        .key("profile-dialog")
        .role("dialog")
        .label("Lopersprofiel")
        .w(820.0)
        .max_w(820.0)
        .min_w(0.0)
        .max_h(max_h)
        .padding(20.0)
        .radius(10.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .shadow(16.0, 48.0, overlay_shadow(s))
        .scroll(ScrollSpec { stick_bottom: false })
        .child(body);
    let base = overlay(s, "profile-overlay", request_close).child(dialog);
    if !f.close_prompt {
        return base;
    }
    let back = |s: &mut State| form_mut(s).close_prompt = false;
    let mut question = col()
        .key("profile-close-dialog")
        .role("dialog")
        .label("Wijzigingen opslaan?")
        .w(420.0)
        .max_w(420.0)
        .padding(20.0)
        .radius(10.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .shadow(16.0, 48.0, overlay_shadow(s))
        .child(text("Wijzigingen opslaan?").font(ts(16.0, 600.0).lh(20.0)).color(p.ink).mb(6.0))
        .child(text("Er zijn aanpassingen aan dit lopersprofiel.").font(ts(13.5, 400.0).lh(20.25)).color(p.t.ink2).wrap());
    if !f.error.is_empty() {
        question = question.child(
            admin_base::banner(s, true)
                .role("alert")
                .mt(8.0)
                .child(text(f.error.clone()).font(ts(13.5, 400.0)).color(p.ink).wrap()),
        );
    }
    if elsewhere {
        question = question.child(
            text("Dit profiel is elders gewijzigd. Kies Verder bewerken om je invoer te bekijken.")
                .font(ts(13.5, 400.0))
                .color(p.t.ink2)
                .wrap()
                .role("alert"),
        );
    }
    let mut keep = btn(s, "profile-keep-editing", "Verder bewerken", Kind::Ghost, false, busy);
    let mut discard = btn(s, "profile-discard", "Niet opslaan", Kind::Ghost, false, busy);
    let mut ok2 = btn(s, "profile-prompt-save", if busy { "Opslaan..." } else { "Opslaan" }, Kind::Primary, false, busy || elsewhere);
    if !busy {
        keep = keep.on_press(back);
        discard = discard.on_press(|s: &mut State| s.profile = None);
        if !elsewhere {
            ok2 = ok2.on_press(save);
        }
    }
    rune::el()
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .child(base.inert())
        .child(
            overlay(s, "profile-close-overlay", back)
                .child(question.child(row().mt(20.0).gap(8.0).justify_end().child(keep).child(discard).child(ok2))),
        )
}
