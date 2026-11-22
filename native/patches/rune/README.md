# Rune dependency

[revision](revision) pins the upstream Rune workspace. The build downloads that revision into the ignored `.rune` directory at the repository root and applies [apolloon.patch](apolloon.patch). Cargo compiles Rune and its platform dependencies from that prepared workspace. Browser builds, CI and npm commands prepare it automatically. For direct Cargo commands, run `bash native/scripts/prepare-rune.sh` first.

The patch preserves Apolloon's existing window controls, browser keyboard behavior, WebGL2 handover and colors, CPU rendering for rotated labels, and idle browser performance. The upstream reports cover [Linux titlebars](https://github.com/anomalyco/rune/issues/591), [window labels](https://github.com/anomalyco/rune/issues/1232), [WebGL2 handover](https://github.com/anomalyco/rune/issues/1231), [WebGL2 colors](https://github.com/anomalyco/rune/issues/117), [keyboard activation](https://github.com/anomalyco/rune/issues/121), [rotated labels](https://github.com/anomalyco/rune/issues/1233), and [idle redraws](https://github.com/anomalyco/rune/issues/166).

## Update Rune

The opt-in frame hook reports redraw entry, macOS display-link pacing, drawable acquisition, and runtime view/layout/paint separately. Acquisition includes surface reconfiguration and any GPU/drawable wait; runtime includes application polling. These CPU wall-time brackets do not measure physical scanout. Timer-only frames can run the runtime before acquisition; input and app wakes normally acquire first.

Within the runtime bracket, the same opt-in hook reports view/tree construction, commit, layout, text shaping/line breaking, cold system-font fallback, glyph preparation/rasterization, atlas allocation and paint preparation. Commit includes view/layout/text; paint includes glyph/atlas work. Nested phases overlap and must not be summed. No runtime hook is installed outside the current window's traced runtime call. Apolloon's Unix tracer also records the frame thread's CPU clock to distinguish computation from scheduler/blocking time. Image uploads and GPU pipeline preparation remain in the existing post-runtime upload/encode bracket.

Setup callbacks lend the window's own text system to public text measurement functions, just as view callbacks do. Apps can therefore prepare text/fallback fonts before the first frame without painting hidden content or populating a throwaway thread-local cache. Apolloon measures its existing handoff-success symbol during native setup; its system-font lookup then does not run on the first lap redraw. The symbol, style, fallback order and widget remain unchanged. Opt-in `text_warm_begin/end` events locate this startup work.

Native surfaces retain upstream AutoVsync presentation and desired frame latency (one on Windows, two elsewhere). For native A/B experiments, `APOLLOON_FRAME_LATENCY=1` requests a maximum frame latency of one; leave it unset for the upstream default. Positive integers are accepted and wgpu constrains them to backend capabilities; empty, zero or invalid values preserve the default. On Metal, requests of one and two correspond to two and three drawables respectively. `RUNE_SURFACE_LOG=1` reports supported and selected modes and requested frame latency. This override does not change present mode or Rune's display-link admission policy. Apolloon's opt-in latency trace observes GPU frame build, submit and present boundaries through `App::on_frame_stage`; the hook does not schedule frames.

Ordinary native and browser GPU frames use Rune's retained damage renderer. Surfaces with `COPY_DST` receive a texture copy; others, including WebGL2, receive a full-screen textured-quad blit. The retained texture is sampled with `textureLoad`, without filtering or blending, through matching source and target view formats. Only Windows additionally supplies dirty presentation rectangles. Transparent clears, changed image/glyph atlases and renderer effects/layers/springs/surfaces retain whole-frame fallbacks. Resizing or replacing a surface discards its damage history.

Damage planning and retained/whole pixel equivalence tests run with `cargo test --manifest-path .rune/Cargo.toml -p rune --lib window::damage::tests` after preparing Rune.

1. Check out the new Rune commit in a separate clone. Reapply the patch there, drop fixes that landed upstream, and save the remaining diff with `git diff --binary HEAD -- crates/rune > /path/to/Apolloon24Hr/native/patches/rune/apolloon.patch`.
2. Put the new full commit SHA in `revision` and run `bash native/scripts/prepare-rune.sh` from Apolloon's root.
3. Run `cargo update --workspace --manifest-path native/Cargo.toml` to refresh the lockfile. Run `npm run build`, `npm run test:native`, and `npm run test:browser`.

GitHub downloads are pinned to a commit. Cargo's lockfile records the resolved crate versions.
