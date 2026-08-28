#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable
  export PATH="$HOME/.cargo/bin:$PATH"
fi

if ! rustup run stable rustc --version >/dev/null 2>&1; then
  rustup toolchain install stable --profile minimal
fi
rustup default stable

"$HOME/.cargo/bin/cargo" build --release \
  --manifest-path products/anydoc-rag/Cargo.toml --locked
