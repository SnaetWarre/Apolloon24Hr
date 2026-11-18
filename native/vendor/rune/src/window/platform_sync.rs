use winit::dpi::{LogicalPosition, LogicalSize};

use crate::runtime::Runtime;
use super::Win;

/// What a built frame hands the window besides its pixels: secure input, the IME, the cursor,
/// help tags and the clipboard.
pub(super) fn sync_platform<S: 'static>(l: &mut Win, rt: &mut Runtime<S>, secure_input: &mut crate::input::secure_input::SecureInput,
    ime: &mut bool, clipboard: &crate::clipboard::Client) {
    let focused = l.window.has_focus();
    secure_input.set(rt.has_secure_focus() && focused);
    let ime_allowed = rt.ime_area.is_some() && !rt.has_secure_focus() && focused;
    let reset = std::mem::take(&mut rt.ime_reset);
    // Rune ended a composition itself (a blur, a click, a finished field): the input method
    // drops its copy, so it doesn't come back in the next field.
    if reset { crate::platform::ime::cancel(&l.window); }
    if reset || ime_allowed != *ime {
        l.window.set_ime_allowed(false);
        l.window.set_ime_allowed(ime_allowed);
        *ime = ime_allowed;
    }
    // A terminal's caret asks for Option as Alt (`El::ime_option_as_alt`): AppKit then hands the key
    // under Option over as itself, not the character the layout composes with it.
    #[cfg(target_os = "macos")]
    {
        use winit::platform::macos::{OptionAsAlt, WindowExtMacOS};
        let want = if ime_allowed && rt.ime_option_as_alt { OptionAsAlt::Both } else { OptionAsAlt::None };
        if l.window.option_as_alt() != want {
            l.window.set_option_as_alt(want);
        }
    }
    l.apply_cursor(rt, focused);
    #[cfg(target_os = "macos")]
    if rt.zoom() == 1.0 {
        l.native.help.sync(&l.window, rt.help_regions());
    } else {
        // Window points: the view's times its zoom.
        let regions: Vec<([f32; 4], String)> = rt.help_regions().iter().map(|(r, t)| (rt.to_window(*r), t.clone())).collect();
        l.native.help.sync(&l.window, &regions);
    }
    // The process has one menu theme: the active window's, so its window menu matches it.
    #[cfg(target_os = "windows")]
    if focused { crate::platform::win32::dark_mode::menus(rt.backdrop_dark().unwrap_or(rt.env.system_dark)); }
    clipboard.flush(rt);
    // The focused field's text, for the input method to convert again or read around the caret.
    crate::platform::ime::sync(&l.window, if ime_allowed { rt.ime_text() } else { None });
    if let Some(a) = rt.ime_area.map(|a| rt.to_window(a)) {
        l.window.set_ime_cursor_area(
            LogicalPosition::new(a[0] as f64, a[1] as f64),
            LogicalSize::new(a[2] as f64, a[3] as f64),
        );
    }
}

impl Win {
    /// The runtime's cursor while the pointer is in the window, the arrow once it leaves.
    /// `Hidden` needs focus, so it can't outlive the window being active.
    pub(super) fn apply_cursor<S>(&mut self, rt: &Runtime<S>, focused: bool) {
        #[cfg(target_os = "linux")]
        {
            if let Some(edge) = rt.pointer().and_then(|point| self.linux_resize_edge(rt, point)) {
                self.window.set_cursor_visible(true);
                self.window.set_cursor(winit::window::CursorIcon::from(edge));
                self.resize_cursor = true;
                return;
            }
            if std::mem::take(&mut self.resize_cursor) {
                self.window.set_cursor(winit::window::CursorIcon::Default);
                self.cursor = crate::cursor::os::OsCursor::new();
            }
        }
        let want = match rt.cursor() { crate::el::Cursor::Hidden if !focused => crate::el::Cursor::Default, c => c };
        self.cursor.apply(&self.window, want, rt.pointer().is_some());
    }
}

#[cfg(target_os = "linux")]
impl Win {
    pub(super) fn linux_resize_edge<S>(&self, rt: &Runtime<S>, point: (f32, f32)) -> Option<winit::window::ResizeDirection> {
        if !self.client_resize || self.window.is_maximized() || self.window.fullscreen().is_some() {
            return None;
        }
        linux_resize_edge(point, rt.window_viewport(), rt.zoom())
    }
}

#[cfg(target_os = "linux")]
fn linux_resize_edge(
    (x, y): (f32, f32),
    (width, height): (f32, f32),
    zoom: f32,
) -> Option<winit::window::ResizeDirection> {
    use winit::window::ResizeDirection::*;
    let (x, y) = (x * zoom, y * zoom);
    let margin = 5.0;
    let horizontal = if x < margin { -1 } else if x >= width - margin { 1 } else { 0 };
    let vertical = if y < margin { -1 } else if y >= height - margin { 1 } else { 0 };
    Some(match (horizontal, vertical) {
        (-1, -1) => NorthWest,
        (0, -1) => North,
        (1, -1) => NorthEast,
        (-1, 0) => West,
        (1, 0) => East,
        (-1, 1) => SouthWest,
        (0, 1) => South,
        (1, 1) => SouthEast,
        _ => return None,
    })
}
