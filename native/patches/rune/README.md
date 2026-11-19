# Rune dependency

[revision](revision) pins the upstream Rune workspace. The build downloads that revision into the ignored `native/.rune` directory and applies [apolloon.patch](apolloon.patch). Cargo compiles Rune and its platform dependencies from that prepared workspace. Browser builds, CI and npm commands prepare it automatically. For direct Cargo commands, run `bash native/scripts/prepare-rune.sh` first.

The patch preserves Apolloon's existing window controls, browser keyboard behavior, WebGL2 handover and colors, CPU rendering for rotated labels, and idle browser performance. The upstream reports cover [Linux titlebars](https://github.com/anomalyco/rune/issues/591), [window labels](https://github.com/anomalyco/rune/issues/1232), [WebGL2 handover](https://github.com/anomalyco/rune/issues/1231), [WebGL2 colors](https://github.com/anomalyco/rune/issues/117), [keyboard activation](https://github.com/anomalyco/rune/issues/121), [rotated labels](https://github.com/anomalyco/rune/issues/1233), and [idle redraws](https://github.com/anomalyco/rune/issues/166).

## Update Rune

1. Check out the new Rune commit in a separate clone. Reapply the patch there, drop fixes that landed upstream, and save the remaining diff with `git diff --binary HEAD -- crates/rune > /path/to/Apolloon24Hr/native/patches/rune/apolloon.patch`.
2. Put the new full commit SHA in `revision` and run `bash native/scripts/prepare-rune.sh` from Apolloon's root.
3. Run `cargo update --workspace --manifest-path native/Cargo.toml` to refresh the lockfile. Run `npm run build`, `npm run test:native`, and `npm run test:browser`.

GitHub downloads are pinned to a commit. Cargo's lockfile records the resolved crate versions.
