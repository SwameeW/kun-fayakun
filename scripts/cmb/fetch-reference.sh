#!/usr/bin/env bash
# Fetches the Planck 2018 results I SMICA figure (arXiv:1807.06205v2 source, 24 MB) used
# only to verify the colour table, the -300..300 uK range and the map orientation.
# Optional: the pipeline still runs without it and records the check as null.
#
# Usage: bash scripts/cmb/fetch-reference.sh   (called by scripts/preprocess-cmb.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
URL="https://arxiv.org/e-print/1807.06205v2"
FIGURE="moll_temp_v2.jpg"
FIGURE_SHA256="83b252588f072415492efc9c89b298f39e929e11a5154c099c57f866514fd85c"

DIR="$ROOT/.cache/planck-2018-I"
TARGET="$DIR/src/$FIGURE"

if [[ -f "$TARGET" ]] && [[ "$(shasum -a 256 "$TARGET" | cut -d' ' -f1)" == "$FIGURE_SHA256" ]]; then
  echo "$FIGURE already present"
  exit 0
fi

mkdir -p "$DIR/src"
curl --fail --location --silent --show-error -o "$DIR/1807.06205v2.tar.gz" "$URL"
tar -xzf "$DIR/1807.06205v2.tar.gz" -C "$DIR/src" "$FIGURE"
actual="$(shasum -a 256 "$TARGET" | cut -d' ' -f1)"
if [[ "$actual" != "$FIGURE_SHA256" ]]; then
  echo "sha256 mismatch for $FIGURE: got $actual" >&2
  rm -f "$TARGET"
  exit 1
fi
echo "$FIGURE OK"
