use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::JsCast;

static ENABLED: AtomicBool = AtomicBool::new(false);

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub fn frame_stage(stage: &'static str) {
    emit(stage, "native-frame", None);
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
                    eprintln!("APOLLOON_LATENCY {event}");
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
    #[test]
    fn handoff_identity_uses_the_existing_exactly_once_token() {
        assert_eq!(
            handoff_id(&json!({"activeRunnerId":"runner","activeStartedAt":123})),
            "runner@123"
        );
        assert_eq!(handoff_id(&Value::Null), "none@0");
    }
}
