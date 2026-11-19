//! A display's own choices (src/components/display/displaySettings.ts): Licht/Donker as
//! `?thema=licht|donker` and Ctrl +, Ctrl − and Ctrl 0 as `?zoom=125`. The address wins, then what
//! this browser (or, on the desktop, this laptop) remembers, then the screen's default. A choice
//! always goes into the address too, so failover reopens the same look on another laptop.
//! F11 puts the screen full screen: the Fullscreen API in a browser, the window on the desktop.
use rune::{Key, KeyEvent};

/// Binnenscherm, Competitiescherm, Buitenscherm: pages 5, 6 and 7.
const DISPLAYS: [&str; 3] = ["inside", "competitions", "outside"];
/// The levels Ctrl + and Ctrl − step through, as in a browser (lib/zoom.ts ZOOM_LEVELS).
const ZOOM_LEVELS: [f32; 11] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];

#[derive(Default)]
pub(in crate::ui) struct Settings {
    loaded: bool,
    #[cfg(not(target_arch = "wasm32"))]
    operator_zoom: Option<u32>,
    /// `Some(true)` for Licht; `None` keeps the screen's default.
    light: [Option<bool>; 3],
    /// Percent; 100 is the normal size and leaves the address alone.
    zoom: [Option<u32>; 3],
}

fn index(page: usize) -> Option<usize> {
    (5..=7).contains(&page).then(|| page - 5)
}
fn theme_key(i: usize) -> String {
    format!("apolloon.display.{}", DISPLAYS[i])
}
fn zoom_key(i: usize) -> String {
    format!("apolloon.display.{}.zoom", DISPLAYS[i])
}
fn parse_theme(v: &str) -> Option<bool> {
    // Older versions stored 'light' and 'dark'.
    match v {
        "licht" | "light" => Some(true),
        "donker" | "dark" => Some(false),
        _ => None,
    }
}
fn parse_zoom(v: &str) -> Option<u32> {
    let percent: f32 = v.trim_matches('"').parse().ok()?;
    (50.0..=200.0)
        .contains(&percent)
        .then_some(percent.round() as u32)
        .filter(|p| *p != 100)
}

impl Settings {
    fn load(&mut self) {
        if std::mem::replace(&mut self.loaded, true) {
            return;
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.operator_zoom = read("apolloon.zoom").as_deref().and_then(parse_zoom);
        }
        for i in 0..3 {
            self.light[i] = read(&theme_key(i)).as_deref().and_then(parse_theme);
            self.zoom[i] = read(&zoom_key(i)).as_deref().and_then(parse_zoom);
        }
    }
    /// Licht for this page, else `default_light`.
    pub(in crate::ui) fn light(&self, page: usize, default_light: bool) -> bool {
        index(page)
            .and_then(|i| self.light[i])
            .unwrap_or(default_light)
    }
    pub(in crate::ui) fn zoom(&self, page: usize) -> f32 {
        index(page)
            .and_then(|i| self.zoom[i])
            .map_or(1.0, |p| p as f32 / 100.0)
    }
    #[cfg(not(target_arch = "wasm32"))]
    pub(in crate::ui) fn operator_zoom(&self) -> f32 {
        self.operator_zoom
            .map_or(1.0, |percent| percent as f32 / 100.0)
    }
    /// The Licht/Donker switch: remembered here and put in the address.
    pub(in crate::ui) fn choose_light(&mut self, page: usize, light: bool) {
        let Some(i) = index(page) else { return };
        self.load();
        self.light[i] = Some(light);
        write(&theme_key(i), Some(if light { "licht" } else { "donker" }));
    }
    fn step_zoom(&mut self, page: usize, step: Step) {
        let Some(i) = index(page) else { return };
        self.load();
        self.zoom[i] = stepped_zoom(self.zoom(page), step);
        write(&zoom_key(i), self.zoom[i].map(|p| p.to_string()).as_deref());
    }
    /// Opening a display's address: `?thema=` and `?zoom=` win over what is remembered.
    #[cfg_attr(not(any(test, target_arch = "wasm32")), allow(dead_code))]
    pub(in crate::ui) fn apply_query(&mut self, page: usize, query: &str) {
        self.load();
        let Some(i) = index(page) else { return };
        for (name, value) in query.split('&').filter_map(|p| p.split_once('=')) {
            match name {
                "thema" => {
                    if let Some(light) = parse_theme(value) {
                        self.light[i] = Some(light);
                    }
                }
                "zoom" => self.zoom[i] = parse_zoom(value),
                _ => {}
            }
        }
    }
    /// The address of this display's choices, `?thema=licht&zoom=125`, or empty.
    #[cfg_attr(not(any(test, target_arch = "wasm32")), allow(dead_code))]
    pub(in crate::ui) fn query(&self, page: usize) -> String {
        let Some(i) = index(page) else {
            return String::new();
        };
        let mut parts = Vec::new();
        if let Some(light) = self.light[i] {
            parts.push(format!("thema={}", if light { "licht" } else { "donker" }));
        }
        if let Some(z) = self.zoom[i] {
            parts.push(format!("zoom={z}"));
        }
        if parts.is_empty() {
            String::new()
        } else {
            format!("?{}", parts.join("&"))
        }
    }
    /// Remembered choices count from the first frame a display shows.
    pub(in crate::ui) fn ensure_loaded(&mut self) {
        self.load();
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Step {
    In,
    Out,
    Reset,
}

fn stepped_zoom(current: f32, step: Step) -> Option<u32> {
    let next = match step {
        Step::Reset => 1.0,
        Step::In => ZOOM_LEVELS
            .into_iter()
            .find(|l| *l > current + 0.001)
            .unwrap_or(2.0),
        Step::Out => ZOOM_LEVELS
            .into_iter()
            .rev()
            .find(|l| *l < current - 0.001)
            .unwrap_or(0.5),
    };
    let percent = (next * 100.0).round() as u32;
    (percent != 100).then_some(percent)
}

/// Ctrl (Cmd on a Mac) with +, − or 0 (lib/zoom.ts zoomStep). AltGr reports Ctrl+Alt and never zooms.
fn zoom_step(event: &KeyEvent) -> Option<Step> {
    let m = event.mods;
    if !(m.ctrl || m.cmd) || m.alt {
        return None;
    }
    let c = match &event.key {
        Key::Command(c) => *c,
        Key::Text(t) => t.chars().next()?,
        _ => return None,
    };
    match c {
        '+' | '=' => Some(Step::In),
        '-' | '−' => Some(Step::Out),
        '0' | 'à' => Some(Step::Reset),
        _ => None,
    }
}

/// Keys on a public screen: zoom, and F11 for full screen in the browser (the desktop window's
/// F11 is handled by its chrome before this).
pub(in crate::ui) fn key(settings: &mut Settings, page: usize, event: &KeyEvent) -> bool {
    if index(page).is_none() {
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(step) = zoom_step(event) {
            settings.load();
            settings.operator_zoom = stepped_zoom(settings.operator_zoom(), step);
            write(
                "apolloon.zoom",
                settings.operator_zoom.map(|p| p.to_string()).as_deref(),
            );
            return true;
        }
        return false;
    }
    if let Some(step) = zoom_step(event) {
        settings.step_zoom(page, step);
        return true;
    }
    if matches!(event.key, Key::Function(11)) {
        return toggle_full_screen();
    }
    false
}

#[cfg(target_arch = "wasm32")]
fn toggle_full_screen() -> bool {
    let Some(document) = web_sys::window().and_then(|w| w.document()) else {
        return false;
    };
    if document.fullscreen_element().is_some() {
        document.exit_fullscreen();
    } else if let Some(root) = document.document_element() {
        let _ = root.request_fullscreen();
    }
    true
}
#[cfg(not(target_arch = "wasm32"))]
fn toggle_full_screen() -> bool {
    false
}

#[cfg(all(target_arch = "wasm32", not(test)))]
fn storage() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok().flatten()
}
#[cfg(all(target_arch = "wasm32", not(test)))]
pub(in crate::ui) fn read(key: &str) -> Option<String> {
    storage()?.get_item(key).ok().flatten()
}
#[cfg(all(target_arch = "wasm32", not(test)))]
pub(in crate::ui) fn write(key: &str, value: Option<&str>) {
    // Without storage the choice lasts for this session only.
    if let Some(s) = storage() {
        let _ = match value {
            Some(v) => s.set_item(key, v),
            None => s.remove_item(key),
        };
    }
}

/// The desktop app remembers display choices in one small file next to the theme choice.
#[cfg(all(not(target_arch = "wasm32"), not(test)))]
fn settings_file() -> Option<std::path::PathBuf> {
    if let Some(p) = std::env::var_os("APOLLOON_NATIVE_DISPLAY_FILE") {
        return Some(p.into());
    }
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("APPDATA").map(std::path::PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".config")))?;
    Some(base.join("apolloon").join("displays.json"))
}
#[cfg(all(not(target_arch = "wasm32"), not(test)))]
fn stored() -> serde_json::Map<String, serde_json::Value> {
    settings_file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}
#[cfg(all(not(target_arch = "wasm32"), not(test)))]
pub(in crate::ui) fn read(key: &str) -> Option<String> {
    stored().get(key)?.as_str().map(str::to_string)
}
#[cfg(all(not(target_arch = "wasm32"), not(test)))]
pub(in crate::ui) fn write(key: &str, value: Option<&str>) {
    let Some(path) = settings_file() else { return };
    let mut all = stored();
    match value {
        Some(v) => all.insert(key.into(), v.into()),
        None => all.remove(key),
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, serde_json::Value::Object(all).to_string());
}

// Tests remember in memory, so they never touch a real profile.
#[cfg(test)]
thread_local! {
    static MEMORY: std::cell::RefCell<std::collections::HashMap<String, String>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}
#[cfg(test)]
pub(in crate::ui) fn read(key: &str) -> Option<String> {
    MEMORY.with(|m| m.borrow().get(key).cloned())
}
#[cfg(test)]
pub(in crate::ui) fn write(key: &str, value: Option<&str>) {
    MEMORY.with(|m| match value {
        Some(v) => m.borrow_mut().insert(key.into(), v.into()),
        None => m.borrow_mut().remove(key),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::Mods;

    fn ctrl(c: char) -> KeyEvent {
        KeyEvent {
            key: Key::Command(c),
            mods: Mods {
                ctrl: true,
                ..Default::default()
            },
        }
    }

    #[test]
    fn address_wins_then_remembered_choice_then_default() {
        let mut s = Settings::default();
        assert!(!s.light(5, false), "Binnenscherm defaults to Donker");
        s.choose_light(5, true);
        assert_eq!(s.query(5), "?thema=licht");
        // A new page load remembers Licht ...
        let mut reloaded = Settings::default();
        reloaded.ensure_loaded();
        assert!(reloaded.light(5, false));
        // ... unless the address asks for Donker.
        reloaded.apply_query(5, "thema=donker");
        assert!(!reloaded.light(5, false));
        // Older versions stored 'light'.
        reloaded.apply_query(6, "thema=light");
        assert!(reloaded.light(6, false));
    }

    #[test]
    fn ctrl_plus_minus_and_zero_step_the_zoom_like_a_browser() {
        let mut s = Settings::default();
        assert!(key(&mut s, 7, &ctrl('+')));
        assert_eq!(s.zoom(7), 1.1);
        assert_eq!(s.query(7), "?zoom=110");
        key(&mut s, 7, &ctrl('+'));
        assert_eq!(s.zoom(7), 1.25);
        for _ in 0..9 {
            key(&mut s, 7, &ctrl('-'));
        }
        assert_eq!(s.zoom(7), 0.5, "stops at 50%");
        key(&mut s, 7, &ctrl('0'));
        assert_eq!(s.zoom(7), 1.0);
        assert_eq!(s.query(7), "", "100% leaves the address alone");
        let mut opened = Settings::default();
        opened.apply_query(5, "zoom=150");
        assert_eq!(opened.zoom(5), 1.5);
        opened.apply_query(5, "zoom=900");
        assert_eq!(opened.zoom(5), 1.0, "out of range is the normal size");
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn operator_zoom_is_remembered_separately_from_public_screens() {
        let mut settings = Settings::default();
        assert!(key(&mut settings, 2, &ctrl('+')));
        assert!(key(&mut settings, 2, &ctrl('+')));
        let mut reloaded = Settings::default();
        reloaded.ensure_loaded();
        assert_eq!(reloaded.operator_zoom(), 1.25);
        assert_eq!(reloaded.zoom(7), 1.0);
        assert!(key(&mut reloaded, 2, &ctrl('0')));
        assert_eq!(reloaded.operator_zoom(), 1.0);
    }
}
