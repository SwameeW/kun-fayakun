#!/usr/bin/env bash
# Rebuilds public/assets/jpl/{planets.json,moon.json} and the "jpl-*" entries of data/sources.json
# from NASA JPL's Solar System Dynamics pages and the Horizons API. Usage: npm run preprocess:jpl
#
# Needs network access to ssd.jpl.nasa.gov (fetched with curl) and the Python environment from
# scripts/preprocess-cmb.sh, created on first use.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${CMB_PYTHON:-$HOME/.local/bin/python3.13}"
VENV="$ROOT/.cache/venv-cmb"
REQUIREMENTS="$ROOT/scripts/cmb/requirements.txt"
export PYTHONDONTWRITEBYTECODE=1

if [[ ! -x "$VENV/bin/python" ]]; then
  "$PYTHON" -m venv "$VENV"
fi
if ! cmp -s "$REQUIREMENTS" "$VENV/.requirements.txt"; then
  "$VENV/bin/python" -m pip install --quiet -r "$REQUIREMENTS"
  cp "$REQUIREMENTS" "$VENV/.requirements.txt"
fi
for step in fetch build sources; do
  printf '\n== %s\n' "$step"
  "$VENV/bin/python" "$ROOT/scripts/jpl/build.py" "$step"
done
ls -l "$ROOT/public/assets/jpl"
