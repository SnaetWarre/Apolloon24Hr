pub(super) const SUCCESS_MARK: &str = "✓";

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn prepare() {
    crate::latency::frame_stage("text_warm_begin");
    rune::text::measure(SUCCESS_MARK, &[], rune::TextStyle::new(13.5, 700.0).features("'tnum' 1").lh(20.25), None);
    crate::latency::frame_stage("text_warm_end");
}
