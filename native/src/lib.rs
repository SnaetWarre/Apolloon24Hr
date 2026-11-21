#[cfg(all(target_arch = "wasm32", feature = "desktop"))]
mod latency;
#[cfg(all(target_arch = "wasm32", feature = "desktop"))]
mod runner_import;
#[cfg(all(target_arch = "wasm32", feature = "desktop"))]
mod theme;
#[cfg(all(target_arch = "wasm32", feature = "desktop"))]
mod ui;
#[cfg(target_arch = "wasm32")]
mod db {
    pub fn now() -> i64 {
        js_sys::Date::now() as i64
    }
}
#[cfg(all(target_arch = "wasm32", feature = "desktop"))]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    ui::run();
}
