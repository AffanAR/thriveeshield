#!/usr/bin/env bash
# Rebuilds contract/res/thriveeshield_vault.wasm inside the official rust image (needs only Docker).
# target-cpu=mvp keeps newer rustc from emitting wasm features the NEAR VM rejects;
# wasm-opt then shrinks the file and fails the build if any non-MVP feature slipped in.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # keeps Git Bash on Windows from rewriting /work
cd "$(dirname "$0")/.."
docker run --rm -v "$PWD/contract:/work" -v ts-target-wasm:/target -v ts-cargo:/usr/local/cargo/registry \
  -e CARGO_TARGET_DIR=/target -w /work rust:1-bookworm bash -c '
    set -euo pipefail
    apt-get update -qq && apt-get install -y -qq binaryen >/dev/null
    rustup target add wasm32-unknown-unknown
    RUSTFLAGS="-C target-cpu=mvp" cargo build --release --target wasm32-unknown-unknown
    mkdir -p res
    wasm-opt --mvp-features -Oz /target/wasm32-unknown-unknown/release/thriveeshield_vault.wasm -o res/thriveeshield_vault.wasm
    ls -l res/thriveeshield_vault.wasm
  '
