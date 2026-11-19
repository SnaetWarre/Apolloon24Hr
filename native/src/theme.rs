//! Operator tokens from src/styles/tokens.css. Keep the two renderers on the same palette.
use rune::color::hex;
use rune::tok::Theme;
use rune::{Color, TextStyle, oklch};

pub const BODY: TextStyle = TextStyle::new(13.0, 400.0);
pub const LABEL: TextStyle = TextStyle::new(12.5, 500.0);
pub const TITLE: TextStyle = TextStyle::new(15.0, 600.0);
pub const LABEL_REGULAR: TextStyle = TextStyle::new(12.5, 400.0);
pub const NAV: TextStyle = TextStyle::new(13.5, 500.0);
pub const KPI: TextStyle = TextStyle::new(26.0, 550.0);

pub fn sidebar(dark: bool) -> Color {
    if dark {
        oklch(0.196, 0.0, 0.0)
    } else {
        oklch(0.956, 0.003, 286.3)
    }
}
pub fn muted(dark: bool) -> Color {
    if dark {
        oklch(0.64, 0.0, 0.0)
    } else {
        oklch(0.552, 0.014, 285.9)
    }
}
pub fn theme(dark: bool) -> Theme {
    let mut t = rune::tok::theme(dark);
    if dark {
        t.bg = oklch(0.218, 0.0, 0.0);
        t.card = hex("#212121").unwrap();
        t.card_border = oklch(0.301, 0.0, 0.0);
        t.text = hex("#ECECEC").unwrap();
        t.text_secondary = oklch(0.715, 0.0, 0.0);
        t.control_off = hex("#272727").unwrap();
        t.hover = oklch(0.309, 0.0, 0.0);
    } else {
        t.bg = oklch(0.976, 0.001, 286.4);
        t.card = hex("#FFFFFF").unwrap();
        t.card_border = oklch(0.92, 0.004, 286.3);
        t.text = hex("#18181B").unwrap();
        t.text_secondary = oklch(0.442, 0.015, 285.8);
        t.control_off = hex("#F4F4F5").unwrap();
        t.hover = oklch(0.932, 0.004, 286.3);
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
            ink2: oklch(0.715, 0.0, 0.0),
            ink3: oklch(0.64, 0.0, 0.0),
            line2: hex("#3D3D3D").unwrap(),
            surface2: hex("#272727").unwrap(),
            surface3: oklch(0.309, 0.0, 0.0),
            warn: oklch(0.7196, 0.1401, 79.91),
            warn_ink: oklch(0.7904, 0.1386, 85.24),
            warn_wash: oklch(0.26, 0.028, 85.5),
            warn_line: oklch(0.40, 0.065, 86.6),
            stop: oklch(0.665, 0.205, 27.0),
            stop_wash: oklch(0.247, 0.03, 19.5),
            stop_line: oklch(0.356, 0.077, 23.9),
            go: oklch(0.695, 0.181, 145.6),
            go_wash: oklch(0.25, 0.03, 153.7),
            go_line: oklch(0.359, 0.063, 150.3),
        }
    } else {
        Tones {
            ink2: oklch(0.442, 0.015, 285.8),
            ink3: oklch(0.552, 0.014, 285.9),
            line2: hex("#D4D4D8").unwrap(),
            surface2: hex("#F4F4F5").unwrap(),
            surface3: oklch(0.932, 0.004, 286.3),
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
