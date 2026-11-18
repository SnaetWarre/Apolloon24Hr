#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
cargo build --manifest-path native/Cargo.toml --lib --target wasm32-unknown-unknown
mkdir -p native/web-dist
wasm-bindgen native/target/wasm32-unknown-unknown/debug/apolloon_native.wasm --target web --out-dir native/web-dist --out-name app
cp native/web/index.html native/web/failover.js native/web-dist/
