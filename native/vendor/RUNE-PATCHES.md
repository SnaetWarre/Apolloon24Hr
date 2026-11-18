# Rune source pin

`rune/` is crates/rune from anomalyco/rune revision
55ef5268f22038a95344b3e9d2b4a25ddba731b1 (MIT).

Local changes:
- Cargo manifest resolves its original workspace metadata explicitly and its sibling path dependencies from the same Git revision.
- platform/web.rs: the GPU readback callback holds an Arc<Buffer>, rather than Rc<Buffer>, to support wgpu's single-threaded WASM Send/Sync configuration used by the WebGL2 build.
- The browser starts its painter on WebGL2 when WebGPU is unavailable. The CPU painter rotates text with its layer during the first frames.
- Web focus and text input retain application key handling, and the window captions use Rune’s label lookup for Dutch accessibility labels. The opt-in Linux title bar uses the client controls and keeps native edge resizing.

The application's wasm-only wgpu dependency enables
`fragile-send-sync-non-atomic-wasm`; this application does not enable WASM atomics or shared-memory threads.
