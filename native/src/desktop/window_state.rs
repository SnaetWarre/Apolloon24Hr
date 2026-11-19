//! Port of electron/window-state.ts: where the window was when it closed (`window-state.json`).
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SavedWindowState {
    pub bounds: Rect,
    pub maximized: bool,
}

pub const DEFAULT_WINDOW_SIZE: (f32, f32) = (1400.0, 900.0);
pub const MIN_WINDOW_SIZE: (i32, i32) = (720, 480);

/// Anything unreadable counts as no stored state.
pub fn parse_window_state(text: &str) -> Option<SavedWindowState> {
    let value: Value = serde_json::from_str(text).ok()?;
    let b = &value["bounds"];
    let n = |k: &str| {
        b[k].as_f64()
            .filter(|v| v.is_finite())
            .map(|v| v.round() as i32)
    };
    Some(SavedWindowState {
        bounds: Rect {
            x: n("x")?,
            y: n("y")?,
            width: n("width")?,
            height: n("height")?,
        },
        maximized: value["maximized"] == true,
    })
}

pub fn to_json(state: &SavedWindowState) -> String {
    let b = state.bounds;
    json!({"bounds":{"x":b.x,"y":b.y,"width":b.width,"height":b.height},"maximized":state.maximized}).to_string()
}

/// The stored bounds when enough of the window still lands on a screen, so it never reopens
/// out of reach after a projector or second screen is unplugged.
pub fn restorable_bounds(saved: Option<SavedWindowState>, work_areas: &[Rect]) -> Option<Rect> {
    let saved = saved?;
    let width = saved.bounds.width.max(MIN_WINDOW_SIZE.0);
    let height = saved.bounds.height.max(MIN_WINDOW_SIZE.1);
    let b = Rect {
        width,
        height,
        ..saved.bounds
    };
    work_areas
        .iter()
        .any(|a| {
            let ox = (b.x + width).min(a.x + a.width) - b.x.max(a.x);
            let oy = (b.y + height).min(a.y + a.height) - b.y.max(a.y);
            ox >= 200 && oy >= 80 && b.y >= a.y && b.y < a.y + a.height - 40
        })
        .then_some(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_rounds_and_rejects_garbage() {
        let s = parse_window_state(
            r#"{"bounds":{"x":10.4,"y":20,"width":800.6,"height":600},"maximized":true}"#,
        )
        .unwrap();
        assert_eq!(
            s.bounds,
            Rect {
                x: 10,
                y: 20,
                width: 801,
                height: 600
            }
        );
        assert!(s.maximized);
        assert_eq!(parse_window_state(&to_json(&s)), Some(s));
        assert!(parse_window_state("nope").is_none());
        assert!(parse_window_state(r#"{"bounds":{"x":1,"y":2,"width":"a","height":3}}"#).is_none());
        assert!(
            !parse_window_state(
                r#"{"bounds":{"x":1,"y":2,"width":3,"height":3},"maximized":"yes"}"#
            )
            .unwrap()
            .maximized
        );
    }
    #[test]
    fn bounds_off_every_screen_are_not_restored() {
        let screen = [Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        }];
        let saved = |x, y| {
            Some(SavedWindowState {
                bounds: Rect {
                    x,
                    y,
                    width: 300,
                    height: 200,
                },
                maximized: false,
            })
        };
        assert_eq!(
            restorable_bounds(saved(100, 100), &screen),
            Some(Rect {
                x: 100,
                y: 100,
                width: 720,
                height: 480
            })
        );
        assert_eq!(restorable_bounds(saved(1800, 100), &screen), None);
        assert_eq!(restorable_bounds(saved(100, -10), &screen), None);
        assert_eq!(restorable_bounds(saved(100, 1050), &screen), None);
        assert_eq!(restorable_bounds(None, &screen), None);
    }
}
