#!/usr/bin/env bash
# Downloads the pinned KTX-Software release (macOS arm64 package) from the official
# KhronosGroup GitHub release, checks its sha256, and unpacks the command-line tools
# into .cache/ktx-software/prefix without installing anything system-wide.
#
# Usage: bash scripts/cmb/fetch-ktx.sh   (called by scripts/preprocess-cmb.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="4.4.2"
PKG="KTX-Software-${VERSION}-Darwin-arm64.pkg"
URL="https://github.com/KhronosGroup/KTX-Software/releases/download/v${VERSION}/${PKG}"
# GitHub's published asset digest for ${PKG}.
SHA256="500bd8f9d63358c3f3a0d83b724c8574436a72c37dc0e4bad90ec1ca38032c3c"

DIR="$ROOT/.cache/ktx-software"
PREFIX="$DIR/prefix"
STAMP="$PREFIX/SOURCE"

if [[ -x "$PREFIX/bin/ktx" && -f "$STAMP" ]] && grep -q "$SHA256" "$STAMP"; then
  echo "ktx ${VERSION} already unpacked in $PREFIX"
  exit 0
fi

if [[ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]]; then
  echo "This script unpacks the macOS arm64 package only. On other platforms install" >&2
  echo "KTX-Software ${VERSION} from ${URL%/*} and put its bin/ and lib/ in $PREFIX." >&2
  exit 1
fi

mkdir -p "$DIR/download"
if [[ ! -f "$DIR/download/$PKG" ]]; then
  curl --fail --location --silent --show-error -o "$DIR/download/$PKG.part" "$URL"
  mv "$DIR/download/$PKG.part" "$DIR/download/$PKG"
fi
actual="$(shasum -a 256 "$DIR/download/$PKG" | cut -d' ' -f1)"
if [[ "$actual" != "$SHA256" ]]; then
  echo "sha256 mismatch for $PKG: got $actual, expected $SHA256" >&2
  exit 1
fi

rm -rf "$DIR/expanded" "$PREFIX"
pkgutil --expand-full "$DIR/download/$PKG" "$DIR/expanded"
mkdir -p "$PREFIX/bin" "$PREFIX/lib"
# The binaries look for libktx in @executable_path/../lib.
cp -p "$DIR/expanded/KTX-Software-${VERSION}-Darwin-arm64-tools.pkg/Payload/usr/local/bin/"* "$PREFIX/bin/"
cp -P -p "$DIR/expanded/KTX-Software-${VERSION}-Darwin-arm64-library.pkg/Payload/usr/local/lib/"libktx* "$PREFIX/lib/"
printf 'url=%s\nsha256=%s\n' "$URL" "$SHA256" > "$STAMP"
"$PREFIX/bin/ktx" --version
