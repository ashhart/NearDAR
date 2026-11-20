#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
revision="7b5c1f29103c94b2d6fd7bc45bd00f8f1f4217b9"
destination="$ROOT/vendor/TensorFold"

if [[ -d "$destination/.git" ]]; then
  current="$(git -C "$destination" rev-parse HEAD)"
  if [[ "$current" != "$revision" ]]; then
    printf 'TensorFold is at %s; expected %s. Refusing to replace local work.\n' "$current" "$revision" >&2
    exit 1
  fi
else
  mkdir -p "$ROOT/vendor"
  git clone --filter=blob:none https://github.com/ashhart/TensorFold.git "$destination"
  git -C "$destination" checkout "$revision"
fi

if [[ -n "$(git -C "$destination" status --short)" ]]; then
  printf 'TensorFold has local changes. Review them before building the app.\n' >&2
  exit 1
fi

if [[ -d "$ROOT/engine/patches" ]]; then
  for patch in "$ROOT/engine/patches"/*.patch; do
    [[ -e "$patch" ]] || continue
    git -C "$destination" apply "$patch"
  done
fi
