use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::JsCast;

static ENABLED: AtomicBool = AtomicBool::new(false);

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub fn frame_stage(stage: &'static str) {
    if !enabled() { return; }
    send_event(json!({"stage":stage,"id":"native-frame","lapId":null,"us":realtime_us(),"cpuUs":thread_cpu_us()}));
}

fn thread_cpu_us() -> Option<f64> {
    #[cfg(unix)]
    {
        let mut time = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time) } != 0 { return None; }
        Some(time.tv_sec as f64 * 1_000_000.0 + time.tv_nsec as f64 / 1000.0)
    }
    #[cfg(not(unix))]
    { None }
}

#[cfg(not(target_arch = "wasm32"))]
static WRITER: std::sync::OnceLock<std::sync::mpsc::SyncSender<Value>> = std::sync::OnceLock::new();

pub fn init() {
    #[cfg(not(target_arch = "wasm32"))]
    if std::env::var("APOLLOON_LATENCY_TRACE").as_deref() == Ok("1") {
        WRITER.get_or_init(|| {
            let (sender, receiver) = std::sync::mpsc::sync_channel::<Value>(8192);
            std::thread::spawn(move || {
                for event in receiver {
                    let line = trace_line(&event);
                    let _ = std::io::Write::write_all(&mut std::io::stderr().lock(), line.as_bytes());
                }
            });
            sender
        });
        ENABLED.store(true, Ordering::Relaxed);
    }
    #[cfg(target_arch = "wasm32")]
    ENABLED.store(
        js_sys::Reflect::get(&js_sys::global(), &"APOLLOON_LATENCY_TRACE".into())
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        Ordering::Relaxed,
    );
}

#[cfg(not(target_arch = "wasm32"))]
fn trace_line(event: &Value) -> String {
    format!("APOLLOON_LATENCY {event}\n")
}

pub fn realtime_us() -> f64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as f64
    }
    #[cfg(target_arch = "wasm32")]
    {
        let p = web_sys::window().unwrap().performance().unwrap();
        (p.time_origin() + p.now()) * 1000.0
    }
}

pub fn emit(stage: &str, id: &str, lap: Option<&str>) {
    if !enabled() { return; }
    emit_at(stage, id, lap, realtime_us());
}

pub fn emit_at(stage: &str, id: &str, lap: Option<&str>, us: f64) {
    emit_at_request(stage, id, lap, us, None);
}

pub fn emit_at_request(stage: &str, id: &str, lap: Option<&str>, us: f64, request: Option<&str>) {
    if !enabled() {
        return;
    }
    let event = json!({"stage":stage,"id":id,"lapId":lap,"us":us,"requestId":request});
    send_event(event);
}

fn send_event(event: Value) {
    #[cfg(not(target_arch = "wasm32"))]
    if let Some(writer) = WRITER.get() {
        let _ = writer.try_send(event);
    }
    #[cfg(target_arch = "wasm32")]
    {
        let global = js_sys::global();
        if let Ok(events) = js_sys::Reflect::get(&global, &"apolloonLatencyEvents".into()) {
            if js_sys::Array::is_array(&events) {
                let events: js_sys::Array = events.unchecked_into();
                if events.length() < 100_000 {
                    events.push(&js_sys::JSON::parse(&event.to_string()).unwrap());
                }
            }
        }
        if event["stage"] == "applied" {
            let _ = js_sys::Reflect::set(
                &global,
                &"apolloonLatencyLap".into(),
                &event["lapId"].as_str().or(event["id"].as_str()).unwrap_or("").into(),
            );
        }
    }
}

/// A Space or Enter press as the window got it from the system, before Rune routes it, so a
/// trace can tell a press the window never got from one a control took before `on_key`.
pub fn window_key(key: &str, repeat: bool, control_focused: bool) {
    if enabled() {
        send_event(json!({"stage":"window_key","id":"native-input","lapId":null,"key":key,"repeat":repeat,"controlFocused":control_focused,"us":realtime_us()}));
    }
}

pub fn window_focus(focused: bool) {
    if enabled() {
        send_event(json!({"stage":"window_focus","id":"native-input","lapId":null,"focused":focused,"us":realtime_us()}));
    }
}

pub fn http_stage(stage: &str, snapshot: &Value, us: f64, request: Option<&str>) {
    if let Some(lap) = snapshot["latencyLap"].as_str() {
        emit_at_request(stage, lap, Some(lap), us, request);
    }
}

pub fn http_size(snapshot: &Value, request: Option<&str>, bytes: usize) {
    if enabled() && let Some(lap) = snapshot["latencyLap"].as_str() {
        send_event(json!({"stage":"http_size","id":lap,"lapId":lap,"requestId":request,"us":realtime_us(),"decodedBodySize":bytes}));
    }
}

pub fn handoff_id(input: &Value) -> String {
    format!(
        "{}@{}",
        input["activeRunnerId"].as_str().unwrap_or("none"),
        input["activeStartedAt"].as_i64().unwrap_or(0)
    )
}
pub fn handoff(stage: &str, input: &Value, lap: Option<&str>) {
    if enabled() {
        emit(stage, &handoff_id(input), lap);
    }
}
pub fn state_wake(snapshot: &Value, reason: Option<&str>) {
    if !enabled() { return; }
    send_event(json!({
        "stage": if reason.is_some() { "urgent_state_downgraded" } else { "urgent_state_request" },
        "us": realtime_us(), "lapId": snapshot["latencyLap"],
        "revision": snapshot["revision"], "changeToken": snapshot["changeToken"], "reason": reason,
    }));
}

pub fn snapshot(stage: &str, snapshot: &Value) {
    if enabled()
        && let Some(lap) = snapshot["latencyLap"].as_str()
    {
        emit(stage, lap, Some(lap));
    }
}

#[cfg(not(target_arch = "wasm32"))]
thread_local! { static COMMITS: std::cell::RefCell<Vec<(String, String)>> = const { std::cell::RefCell::new(Vec::new()) }; }
#[cfg(not(target_arch = "wasm32"))]
pub struct CommitContext;
#[cfg(not(target_arch = "wasm32"))]
impl Drop for CommitContext {
    fn drop(&mut self) {
        COMMITS.with(|v| v.borrow_mut().clear());
    }
}
#[cfg(not(target_arch = "wasm32"))]
pub fn commit_context(laps: Vec<(String, String)>) -> CommitContext {
    COMMITS.with(|v| *v.borrow_mut() = laps);
    CommitContext
}
#[cfg(not(target_arch = "wasm32"))]
pub fn notify() {
    if enabled() {
        COMMITS.with(|v| {
            for (id, lap) in v.borrow().iter() {
                emit("notify", id, Some(lap));
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn frame_thread_cpu_clock_is_monotonic() {
        let before = thread_cpu_us().unwrap();
        assert!(thread_cpu_us().unwrap() >= before);
    }

    #[test]
    fn trace_records_are_complete_lines_before_writing() {
        for event in [Value::Null, json!({}), json!({"stage":"http_body","id":"line\nbreak"})] {
            let line = trace_line(&event);
            assert_eq!(line.lines().count(), 1);
            assert_eq!(serde_json::from_str::<Value>(line.strip_prefix("APOLLOON_LATENCY ").unwrap()).unwrap(), event);
        }
    }

    #[test]
    fn handoff_identity_uses_the_existing_exactly_once_token() {
        assert_eq!(
            handoff_id(&json!({"activeRunnerId":"runner","activeStartedAt":123})),
            "runner@123"
        );
        assert_eq!(handoff_id(&Value::Null), "none@0");
    }
}
