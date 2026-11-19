#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
bash native/scripts/prepare-rune.sh
cargo build --locked --release --manifest-path native/Cargo.toml --lib --target wasm32-unknown-unknown
mkdir -p native/web-dist
wasm-bindgen native/target/wasm32-unknown-unknown/release/apolloon_native.wasm \
  --target web --out-dir native/web-dist --out-name app --remove-name-section --remove-producers-section
gzip -n -c native/web-dist/app_bg.wasm > native/web-dist/app_bg.wasm.gz
cp native/web/index.html native/web/failover.js native/web-dist/
