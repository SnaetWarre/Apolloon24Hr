//! The desktop window around the operator UI: title bar (src/components/DesktopTitleBar.tsx),
//! start screen (electron/splash.ts), start error with retry, the race question on closing,
//! F11 full screen, and saving and restoring where the window was.
use super::{Phase, Request, race_guard, supervisor, window_state};
use crate::theme as tok;
use rune::{AppSpec, Color, Cx, El, Key, KeyEvent, Tx, col, row, text};
use std::cell::RefCell;

pub const TITLEBAR_HEIGHT: f32 = 36.0;

thread_local! {
    static WINDOW: RefCell<Option<rune::WindowHandle>> = const { RefCell::new(None) };
    /// The Apolloon wordmark for light and dark title bars (`.brand-mark`).
    static LOGOS: RefCell<Option<[rune::Image; 2]>> = const { RefCell::new(None) };
}

/// Hands the title bar the wordmark images the app already loaded.
pub fn set_logos(light: rune::Image, dark: rune::Image) {
    LOGOS.with(|l| *l.borrow_mut() = Some([light, dark]));
}

fn state_path() -> Option<std::path::PathBuf> {
    super::data_dir().map(|d| d.join("window-state.json"))
}

fn saved_state() -> Option<window_state::SavedWindowState> {
    window_state::parse_window_state(&std::fs::read_to_string(state_path()?).ok()?)
}

fn save_window_state() {
    let Some(path) = state_path() else { return };
    let placement = WINDOW.with(|w| w.borrow().as_ref().and_then(|w| w.placement()));
    let Some(p) = placement else { return };
    let ((x, y), (width, height)) = p.restore.unwrap_or((p.position, p.content_size));
    let state = window_state::SavedWindowState {
        bounds: window_state::Rect {
            x,
            y,
            width: width as i32,
            height: height as i32,
        },
        maximized: p.maximized,
    };
    if let Err(error) = std::fs::write(path, window_state::to_json(&state)) {
        supervisor::desktop_log(&format!("Window position not saved: {error}"));
    }
}

/// Runs the operator UI in the desktop window. Without `boot` (headless, tests, a remote
/// server through APOLLOON_NATIVE_URL), it is the plain Rune app.
pub fn run<S: 'static>(mut spec: AppSpec<S>) {
    rune::set_labels(|label| {
        Some(match label {
            rune::Label::Minimize => "Minimaliseren",
            rune::Label::Maximize => "Maximaliseren",
            rune::Label::Restore => "Herstellen",
            rune::Label::Close => "Sluiten",
            _ => return None,
        }.into())
    });
    if super::DESKTOP.get().is_none() {
        rune::run(spec);
        return;
    }
    spec.size = window_state::DEFAULT_WINDOW_SIZE;
    spec.min_size = Some((
        window_state::MIN_WINDOW_SIZE.0 as f32,
        window_state::MIN_WINDOW_SIZE.1 as f32,
    ));
    let saved = saved_state();
    let mut options = rune::WindowOptions::default();
    if let Some(s) = saved {
        let b = window_state::restorable_bounds(Some(s), &[s.bounds]).unwrap_or(s.bounds);
        options.position = Some((b.x, b.y));
        options.physical_size = Some((b.width as u32, b.height as u32));
    }
    let app = rune::App::new(spec)
        .window_options(options)
        .maximized(saved.is_some_and(|s| s.maximized))
        .titlebar(rune::Titlebar::new(TITLEBAR_HEIGHT).linux_client_controls())
        .keep_running()
        .on_close(on_close::<S>)
        .on_quit(|_: &mut S, _| {
            save_window_state();
            super::window_closed();
            super::shut_down();
        })
        .on_focus(|_: &mut S, focused, _| {
            super::with(|d| d.focused = focused);
        })
        .on_window(|handle| WINDOW.with(|w| *w.borrow_mut() = Some(handle.clone())))
        .on_ready(move |handle| {
            // Reopen out of reach (a projector or second screen unplugged): centre instead.
            if let (Some(s), Some(p)) = (saved, handle.placement()) {
                let on_screen = p.display.is_some_and(|((x, y), (w, h))| {
                    window_state::restorable_bounds(
                        Some(s),
                        &[window_state::Rect {
                            x,
                            y,
                            width: w as i32,
                            height: h as i32,
                        }],
                    )
                    .is_some()
                });
                if !on_screen {
                    handle.center();
                }
            }
        });
    let handle = app.handle();
    super::set_hook(Box::new(move |r| match r {
        Request::Wake => handle.wake(),
        Request::Show => handle.open(),
        Request::Quit => handle.quit(),
    }));
    app.run();
}

/// The window's close button: while the race runs, ask first (electron guardClose).
fn on_close<S>(_: &mut S, tx: &mut Tx) {
    let race = race_guard::is_race_active();
    let confirmed = super::with(|d| d.quit_confirmed).unwrap_or(true);
    let failed = super::with(|d| matches!(d.phase, Phase::Failed(_))).unwrap_or(false);
    if !failed && race_guard::on_close(race, confirmed) == race_guard::Close::Ask {
        super::with(|d| d.ask_close = true);
        super::request(Request::Show);
        return;
    }
    save_window_state();
    super::shut_down();
    tx.quit();
}

/// F11 toggles full screen (the title bar hides), as in electron/main.ts.
pub fn key(event: &KeyEvent, tx: &mut Tx) -> bool {
    if super::DESKTOP.get().is_none() || !matches!(event.key, Key::Function(11)) {
        return false;
    }
    super::with(|d| d.full_screen = !d.full_screen);
    tx.toggle_full_screen();
    true
}

/// --brand in tokens.css, as the splash uses it.
fn brand(dark: bool) -> Color {
    rune::color::hex(if dark { "#5AA9F0" } else { "#0D78D3" }).unwrap()
}

fn ink(dark: bool) -> Color {
    tok::theme(dark).text
}

fn button<S: 'static>(
    key: &str,
    label: &str,
    primary: bool,
    dark: bool,
    f: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tok::theme(dark);
    let tones = tok::tones(dark);
    let (fill, color) = if primary {
        (brand(dark), Color::WHITE)
    } else {
        (t.control_off, t.text)
    };
    row()
        .key(key.to_string())
        .role("button")
        .label(label.to_string())
        .focusable(true)
        .h(32.0)
        .px(14.0)
        .center_y()
        .radius(8.0)
        .fill(fill)
        .border(1.0, if primary { fill } else { tones.line2 })
        .child(text(label.to_string()).font(tok::LABEL).color(color))
        .on_press_tx(f)
}

fn dialog<S: 'static>(
    key: &str,
    title: &str,
    message: &str,
    detail: &str,
    buttons: El,
    dark: bool,
) -> El {
    let t = tok::theme(dark);
    rune::el()
        .key(format!("{key}-overlay"))
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .padding(24.0)
        .center()
        .fill(rune::oklcha(0.21, 0.006, 285.9, 0.4))
        .child(
            col()
                .key(key.to_string())
                .role("alertdialog")
                .label(title.to_string())
                .w_full()
                .max_w(520.0)
                .min_w(0.0)
                .radius(10.0)
                .gap(12.0)
                .padding(20.0)
                .fill(t.card)
                .modal(true, |_: &mut S| {})
                .child(text(title.to_string()).font(tok::TITLE).color(t.text))
                .child(
                    text(message.to_string())
                        .font(tok::BODY)
                        .color(t.text)
                        .wrap()
                        .min_w(0.0),
                )
                .child(
                    text(detail.to_string())
                        .font(tok::BODY)
                        .color(tok::theme(dark).text_secondary)
                        .wrap()
                        .min_w(0.0),
                )
                .child(buttons),
        )
}

/// electron/splash.ts as a screen: shown after half a second, with a note after eight.
fn start_screen(status: &str, waited: f32, dark: bool) -> El {
    let t = tok::theme(dark);
    let mut screen = col()
        .key("start-screen")
        .w_full()
        .h_full()
        .center()
        .gap(14.0)
        .fill(t.bg);
    if waited >= 0.5 {
        let line = tok::tones(dark).line2;
        screen = screen
            .child(text("Apolloon").font(rune::TextStyle::new(28.0, 700.0)).color(ink(dark)))
            .child(rune::el().w(160.0).h(3.0).radius(3.0).fill(line).child(rune::el().w(64.0).h(3.0).radius(3.0).fill(brand(dark))))
            .child(text(status.to_string()).font(rune::TextStyle::new(14.0, 500.0)).color(ink(dark)).role("status"))
            .child(
                text(if waited >= 8.0 { "Dit duurt langer dan gewoonlijk. Een grote databank of een virusscanner kan het opstarten vertragen." } else { "" })
                    .font(rune::TextStyle::new(12.5, 400.0))
                    .color(tok::muted(dark))
                    .wrap()
                    .max_w(300.0),
            )
            .child(text(format!("Apolloon Telsysteem {}", super::version())).font(tok::LABEL_REGULAR).color(tok::muted(dark)));
    }
    screen
}

fn title_bar<S: 'static>(cx: &Cx<S>, dark: bool, public: bool, home: fn(&mut S)) -> El {
    let insets = cx.chrome_insets();
    let focused = super::with(|d| d.focused).unwrap_or(true);
    let t = tok::theme(dark);
    let tones = tok::tones(dark);
    let bar = row()
        .key("titlebar")
        .w_full()
        .h(TITLEBAR_HEIGHT)
        .center_y()
        .pl(insets.leading.max(8.0))
        .pr(insets.trailing)
        .fill(if public { rune::oklch(0.178, 0.0, 0.0) } else { tok::sidebar(dark) })
        .border_sides([0.0, 0.0, 1.0, 0.0], if public { rune::oklch(0.269, 0.0, 0.0) } else { t.card_border })
        .window_drag()
        .child(
            row()
                .key("titlebar-brand")
                .role("button")
                .label("Apolloon, naar het overzicht")
                .focusable(true)
                .h(24.0)
                .px(8.0)
                .center_y()
                .radius(6.0)
                .hover(tones.surface3)
                .child(
                    // `.titlebar__brand .brand-mark`: the 60x18 wordmark, dimmed while unfocused.
                    match LOGOS.with(|l| l.borrow().as_ref().map(|l| l[usize::from(dark)].clone())) {
                        Some(image) => rune::el()
                            .size(60.0, 18.0)
                            .opacity(if focused { 1.0 } else { 0.6 })
                            .pixels_fit(image.pixels(), rune::SurfaceFit::Fit),
                        None => text("Apolloon")
                            .font(rune::TextStyle::new(13.0, 700.0))
                            .color(if focused { t.text } else { tok::muted(dark) }),
                    },
                )
                .on_press(move |s: &mut S| home(s)),
        );
    #[cfg(target_os = "linux")]
    return bar.child(rune::el().grow(1.0)).child(caption_buttons::<S>(dark, focused));
    #[cfg(not(target_os = "linux"))]
    bar
}

#[cfg(target_os = "linux")]
fn caption_buttons<S: 'static>(dark: bool, focused: bool) -> El {
    let maximized = WINDOW.with(|window| {
        window.borrow().as_ref().and_then(|window| window.placement())
            .is_some_and(|placement| placement.maximized)
    });
    let tones = tok::tones(dark);
    let ink = if focused { tones.ink2 } else { tones.ink3 };
    let minimize = rune::Shape::new().line([0.5, 5.0], [9.5, 5.0], 1.0, rune::LineCap::Round, ink);
    let maximize = if maximized {
        rune::Shape::new()
            .stroke([[2.5, 2.5], [2.5, 0.5], [9.5, 0.5], [9.5, 7.5], [7.5, 7.5]], 1.0, ink)
            .stroke_with([[0.5, 2.5], [7.5, 2.5], [7.5, 9.5], [0.5, 9.5]], true, 1.0, rune::LineCap::Round, ink)
    } else {
        rune::Shape::new().stroke_with([[0.5, 0.5], [9.5, 0.5], [9.5, 9.5], [0.5, 9.5]], true, 1.0, rune::LineCap::Round, ink)
    };
    let close = rune::Shape::new()
        .line([0.5, 0.5], [9.5, 9.5], 1.0, rune::LineCap::Round, ink)
        .line([9.5, 0.5], [0.5, 9.5], 1.0, rune::LineCap::Round, ink);
    let button = |key, label, shape, hover| {
        row().key(key).role("button").label(label).help(label)
            .no_window_drag().focusable(true).size(46.0, TITLEBAR_HEIGHT).center().hover(hover)
            .child(rune::canvas(shape).size(10.0, 10.0))
    };
    row().role("group").label("Venster")
        .child(button("titlebar-minimize", "Minimaliseren", minimize, tones.surface3)
            .on_press_tx(|_: &mut S, tx: &mut Tx| tx.minimize()))
        .child(button("titlebar-maximize", if maximized { "Herstellen" } else { "Maximaliseren" }, maximize, tones.surface3)
            .on_press_tx(|_: &mut S, tx: &mut Tx| tx.toggle_maximized()))
        .child(button("titlebar-close", "Sluiten", close, rune::oklch(0.536, 0.191, 30.1))
            .press(rune::oklch(0.499, 0.175, 30.1))
            .on_press_tx(|_: &mut S, tx: &mut Tx| tx.close_window()))
}

/// The operator view inside the desktop window.
pub fn frame<S: 'static>(cx: &mut Cx<S>, dark: bool, public: bool, content: El, home: fn(&mut S)) -> El {
    let Some((phase, ask_close, full_screen)) =
        super::with(|d| (d.phase.clone(), d.ask_close, d.full_screen))
    else {
        return content;
    };
    cx.caption_color(if public { rune::oklch(0.686, 0.0, 0.0) } else if dark { Color::WHITE } else { Color::BLACK });
    let body = match &phase {
        Phase::Ready => content,
        Phase::Starting { status, since } => {
            start_screen(status, since.elapsed().as_secs_f32(), dark)
        }
        Phase::Failed(_) => start_screen("", 0.0, dark),
    };
    let mut root = col()
        .key("desktop-root")
        .w_full()
        .h_full()
        .fill(tok::theme(dark).bg);
    if !full_screen {
        root = root.child(title_bar(cx, dark || public, public, home));
    }
    root = root.child(col().grow(1.0).min_h(0.0).w_full().child(body));
    if let Phase::Failed(message) = &phase {
        let buttons = row()
            .gap(10.0)
            .child(button(
                "start-retry",
                "Opnieuw proberen",
                true,
                dark,
                |_: &mut S, _| super::retry_start(),
            ))
            .child(button(
                "start-log",
                "Logmap openen",
                false,
                dark,
                |_: &mut S, _| {
                    if let Some(dir) = super::data_dir() {
                        let _ = super::open_folder(&dir);
                    }
                },
            ))
            .child(button(
                "start-quit",
                "Afsluiten",
                false,
                dark,
                |_: &mut S, tx: &mut Tx| {
                    super::shut_down();
                    tx.quit();
                },
            ));
        root = root.child(dialog::<S>(
            "start-error",
            "Apolloon kon niet starten",
            &message.message,
            &message.detail,
            buttons,
            dark,
        ));
    } else if ask_close {
        let buttons = row()
            .gap(10.0)
            .child(button(
                "close-stay",
                "Blijven",
                true,
                dark,
                |_: &mut S, _| {
                    super::with(|d| d.ask_close = false);
                    super::quit_cancelled();
                },
            ))
            .child(button(
                "close-anyway",
                "Toch afsluiten",
                false,
                dark,
                |_: &mut S, tx: &mut Tx| {
                    super::with(|d| {
                        d.ask_close = false;
                        d.quit_confirmed = true;
                    });
                    supervisor::desktop_log("Closed during the race after confirmation");
                    save_window_state();
                    super::shut_down();
                    tx.quit();
                },
            ));
        root = root.child(dialog::<S>(
            "close-race",
            "Apolloon afsluiten?",
            "De wedstrijd loopt nog. Toch afsluiten?",
            "Deze laptop valt dan weg uit de groep. De andere laptops werken verder, maar dan mag er geen enkele meer uitvallen. Start Apolloon daarna meteen opnieuw.",
            buttons,
            dark,
        ));
    }
    root
}
