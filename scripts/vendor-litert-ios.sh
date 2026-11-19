#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/modules/tensorfold-vision/ios/vendor"
FRAMEWORK="$DEST/CLiteRTLM.xcframework"
URL="https://github.com/google-ai-edge/LiteRT-LM/releases/download/v0.19.1/CLiteRTLM.xcframework.zip"
SHA256="21cf294b3dfdd9c8166b0f7934ed392d5c69c8bfa57cd1a20e341a7d16874017"

if [[ -f "$FRAMEWORK/Info.plist" ]]; then
  exit 0
fi

mkdir -p "$DEST"
ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/CLiteRTLM.xcframework.XXXXXX.zip")"
trap 'rm -f "$ARCHIVE"' EXIT

curl --fail --location --max-time 600 "$URL" --output "$ARCHIVE"
printf '%s  %s\n' "$SHA256" "$ARCHIVE" | shasum -a 256 -c -
ditto -x -k "$ARCHIVE" "$DEST"
