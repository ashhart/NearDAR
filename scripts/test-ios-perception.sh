#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
scratch=$(mktemp -d "${TMPDIR:-/tmp}/neardar-perception.XXXXXXXX")
trap 'rm -f "$scratch/perception-tests"; rmdir "$scratch"' EXIT

xcrun swiftc \
  modules/tensorfold-perception/ios/PerceptionDepth.swift \
  modules/tensorfold-perception/ios/LiveObstacleIdentity.swift \
  modules/tensorfold-perception/ios/CorridorAnalyzer.swift \
  modules/tensorfold-perception/ios/ThermalGovernor.swift \
  modules/tensorfold-perception/ios/LightAnalyzer.swift \
  modules/tensorfold-perception/ios/MonocularDepthFallback.swift \
  modules/tensorfold-perception/ios/PerceptionContract.swift \
  tests/ios-perception.swift \
  -o "$scratch/perception-tests"
"$scratch/perception-tests"
