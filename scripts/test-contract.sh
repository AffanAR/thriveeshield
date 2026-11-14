#!/usr/bin/env bash
# Runs the contract unit tests inside the official rust image (needs only Docker).
set -euo pipefail
export MSYS_NO_PATHCONV=1 # keeps Git Bash on Windows from rewriting /work
cd "$(dirname "$0")/.."
docker run --rm -v "$PWD/contract:/work" -v ts-target:/target -v ts-cargo:/usr/local/cargo/registry \
  -e CARGO_TARGET_DIR=/target -w /work rust:1-bookworm cargo test
