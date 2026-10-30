#!/usr/bin/env bash
# Build the Photos develop engine (photo/, Rust) to WebAssembly and copy it to
# public/photo/develop.wasm. The .wasm is committed, so deploys need no Rust.
#   rustup target add wasm32-unknown-unknown   # once
set -euo pipefail
cd "$(dirname "$0")/../photo"
cargo build --release --target wasm32-unknown-unknown
out=../public/photo/develop.wasm
cp target/wasm32-unknown-unknown/release/wisp_photo.wasm "$out"
if command -v wasm-opt >/dev/null; then wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int "$out" -o "$out"; fi
echo "built $out ($(wc -c < "$out") bytes)"
