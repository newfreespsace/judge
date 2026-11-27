#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "$0")/.."

# The locked simple-sandbox package declares CMake 3.0 and formats filesystem paths.
export CMAKE_POLICY_VERSION_MINIMUM="${CMAKE_POLICY_VERSION_MINIMUM:-3.5}"
export CXXFLAGS="${CXXFLAGS:+$CXXFLAGS }-include \"$PWD/native/fmt-compat.h\""
exec yarn install --frozen-lockfile "$@"
