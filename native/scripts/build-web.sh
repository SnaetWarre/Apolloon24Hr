#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
bash native/scripts/prepare-rune.sh
cargo build --locked --profile wasm-release --manifest-path native/Cargo.toml --lib --target wasm32-unknown-unknown
mkdir -p native/web-dist
wasm-bindgen "${CARGO_TARGET_DIR:-native/target}/wasm32-unknown-unknown/wasm-release/apolloon_native.wasm" \
  --target web --out-dir native/web-dist --out-name app --remove-name-section --remove-producers-section
gzip -n -c native/web-dist/app_bg.wasm > native/web-dist/app_bg.wasm.gz
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { brotliCompressSync } from "node:zlib";
  const file = "native/web-dist/app_bg.wasm";
  writeFileSync(file + ".br", brotliCompressSync(readFileSync(file)));
'
cp native/web/index.html native/web/failover.js native/web-dist/
cp native/assets/logo-light.svg native/assets/logo-dark.svg native/web-dist/
