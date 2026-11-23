use super::Update;
use std::sync::Arc;

pub(super) type Wake = Arc<dyn Fn(String) + Send + Sync>;

pub(super) fn lap(update: &Update) -> Option<&str> {
    if !update.partial { return None; }
    let (method, outcome) = update.outcome.as_ref()?;
    if method != "race.handoff" { return None; }
    outcome.as_ref().ok()?["lapId"].as_str().filter(|lap| !lap.is_empty())
}

#[cfg(test)]
#[path = "ack_draw_tests.rs"]
mod tests;
