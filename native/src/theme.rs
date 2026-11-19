//! Operator tokens from src/styles/tokens.css. Keep the two renderers on the same palette.
use rune::color::hex;
use rune::tok::Theme;
use rune::{Color, TextStyle, oklch};

pub const BODY: TextStyle = TextStyle::new(13.0, 400.0);
pub const LABEL: TextStyle = TextStyle::new(12.5, 500.0);
pub const TITLE: TextStyle = TextStyle::new(18.0, 600.0);
pub const LABEL_REGULAR: TextStyle = TextStyle::new(12.5, 400.0);
pub const NAV: TextStyle = TextStyle::new(14.5, 500.0);

pub fn sidebar(dark: bool) -> Color {
    if dark {
        hex("#0A0A0B").unwrap()
    } else {
        hex("#ECECEE").unwrap()
    }
}
pub fn muted(dark: bool) -> Color {
    if dark {
        hex("#85858D").unwrap()
    } else {
        hex("#8A8A93").unwrap()
    }
}
pub fn theme(dark: bool) -> Theme {
    let mut t = rune::tok::theme(dark);
    if dark {
        t.bg = hex("#18181A").unwrap();
        t.card = hex("#1F1F22").unwrap();
        t.card_border = hex("#2A2A2E").unwrap();
        t.text = hex("#F2F2F3").unwrap();
        t.text_secondary = hex("#A1A1A8").unwrap();
        t.control_off = hex("#2B2B2F").unwrap();
        t.hover = hex("#2A2A2D").unwrap();
    } else {
        t.bg = hex("#FFFFFF").unwrap();
        t.card = hex("#F6F6F7").unwrap();
        t.card_border = hex("#E6E6E9").unwrap();
        t.text = hex("#111114").unwrap();
        t.text_secondary = hex("#5C5C66").unwrap();
        t.control_off = hex("#EDEDF0").unwrap();
        t.hover = hex("#EDEDF0").unwrap();
    }
    t.separator = t.card_border;
    t
}
/// Status and secondary tokens from tokens.css that the Rune theme has no slot for.
pub struct Tones {
    pub ink2: Color,
    pub ink3: Color,
    pub line2: Color,
    pub surface2: Color,
    pub surface3: Color,
    pub warn: Color,
    pub warn_ink: Color,
    pub warn_wash: Color,
    pub warn_line: Color,
    pub stop: Color,
    pub stop_wash: Color,
    pub stop_line: Color,
    pub go: Color,
    pub go_wash: Color,
    pub go_line: Color,
}
pub fn tones(dark: bool) -> Tones {
    if dark {
        Tones {
            ink2: hex("#A1A1A8").unwrap(),
            ink3: hex("#85858D").unwrap(),
            line2: hex("#34343A").unwrap(),
            surface2: hex("#26262A").unwrap(),
            surface3: hex("#2B2B2F").unwrap(),
            warn: oklch(0.7196, 0.1401, 79.91),
            warn_ink: oklch(0.7904, 0.1386, 85.24),
            warn_wash: oklch(0.26, 0.028, 85.5),
            warn_line: oklch(0.40, 0.065, 86.6),
            stop: oklch(0.665, 0.205, 27.0),
            stop_wash: oklch(0.247, 0.03, 19.5),
            stop_line: oklch(0.356, 0.077, 23.9),
            go: oklch(0.74, 0.19, 145.0),
            go_wash: oklch(0.25, 0.03, 153.7),
            go_line: oklch(0.359, 0.063, 150.3),
        }
    } else {
        Tones {
            ink2: hex("#5C5C66").unwrap(),
            ink3: hex("#8A8A93").unwrap(),
            line2: hex("#D9D9DE").unwrap(),
            surface2: hex("#F1F1F3").unwrap(),
            surface3: hex("#E1E1E5").unwrap(),
            warn: oklch(0.6095, 0.1447, 56.74),
            warn_ink: oklch(0.4732, 0.1247, 46.2),
            warn_wash: oklch(0.975, 0.018, 81.3),
            warn_line: oklch(0.885, 0.066, 79.5),
            stop: oklch(0.577, 0.215, 27.3),
            stop_wash: oklch(0.965, 0.014, 17.4),
            stop_line: oklch(0.862, 0.055, 18.3),
            go: oklch(0.527, 0.137, 150.1),
            go_wash: oklch(0.97, 0.014, 155.6),
            go_line: oklch(0.883, 0.05, 156.1),
        }
    }
}
