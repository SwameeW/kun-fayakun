#!/usr/bin/env bash
# Rebuilds public/assets/planets/ (KTX2 textures of the Earth, Moon, Jupiter and Saturn at the
# Low, Medium, High and Ultra detail tiers, plus planets.json) and the planet entries of
# data/sources.json from pinned sources that are public domain, CC0 or (Hubble OPAL) CC BY 4.0.
# Ultra (8192) is published with the rest; maps narrower than 8192 at source serve their High file.
# Usage: bash scripts/preprocess-planets.sh
#
# Needs network access (first run only; files already in .cache/planets/download are checked,
# not fetched again) to assets.science.nasa.gov, gibs.earthdata.nasa.gov (the clouds' day, 26
# map requests), www.ngdc.noaa.gov, raw.githubusercontent.com, svs.gsfc.nasa.gov and
# archive.stsci.edu, about 735 MB; pypi.org and files.pythonhosted.org (tifffile, imagecodecs);
# github.com and its release-asset hosts (KTX-Software, first run). The Cassini ring profile comes
# from the JPL builder's cache (run npm run preprocess:jpl first). Peak memory is about 4 GB.
#
# Steps (scripts/planets): fetch (pin check) -> build (landmark checks, mip chains) -> encode
# (KTX2, decoded and checked again, budgets) -> manifest (planets.json, sources) -> preview
# (review images in .cache/planets/preview).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${CMB_PYTHON:-$HOME/.local/bin/python3.13}"
VENV="$ROOT/.cache/venv-cmb"
CMB_REQUIREMENTS="$ROOT/scripts/cmb/requirements.txt"
REQUIREMENTS="$ROOT/scripts/planets/requirements.txt"
# Keep scripts/planets free of __pycache__ (it is source, not a cache).
export PYTHONDONTWRITEBYTECODE=1

step() { printf '\n== %s\n' "$*"; }

pip_install() {
  # pip's default macOS trust store can be unavailable in sandboxes; fall back to certifi.
  "$VENV/bin/python" -m pip install --quiet -r "$1" \
    || "$VENV/bin/python" -m pip install --quiet --use-deprecated=legacy-certs -r "$1"
}

step "Python environment ($VENV, shared with scripts/preprocess-cmb.sh)"
if [[ ! -x "$VENV/bin/python" ]]; then
  "$PYTHON" -m venv "$VENV"
fi
if ! cmp -s "$CMB_REQUIREMENTS" "$VENV/.requirements.txt"; then
  pip_install "$CMB_REQUIREMENTS"
  cp "$CMB_REQUIREMENTS" "$VENV/.requirements.txt"
fi
if ! cmp -s "$REQUIREMENTS" "$VENV/.requirements-planets.txt"; then
  pip_install "$REQUIREMENTS"
  cp "$REQUIREMENTS" "$VENV/.requirements-planets.txt"
fi

step "KTX-Software"
bash "$ROOT/scripts/cmb/fetch-ktx.sh"

step "fetch"
"$VENV/bin/python" "$ROOT/scripts/planets/fetch.py"
step "build"
"$VENV/bin/python" "$ROOT/scripts/planets/build.py"
step "encode"
"$VENV/bin/python" "$ROOT/scripts/planets/encode.py"
step "manifest and sources"
"$VENV/bin/python" "$ROOT/scripts/planets/manifest.py" --sources
step "preview"
"$VENV/bin/python" "$ROOT/scripts/planets/preview.py" low medium high ultra

step "done"
du -sh "$ROOT/public/assets/planets"
