#!/usr/bin/env bash
# Rebuilds public/assets/sdss/{galaxies.bin,galaxies.json} and the "sdss-dr20" entry of
# data/sources.json from the SDSS DR20 SkyServer. Usage: npm run preprocess:sdss
#
# Needs network access to skyserver.sdss.org and the four SDSS acknowledgement sites
# (www.sdss.org, www.sdss4.org, www.sdss3.org, classic.sdss.org), and the Python
# environment from scripts/preprocess-cmb.sh (astropy, numpy), created on first use.
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
for step in fetch credits build sources; do
  printf '\n== %s\n' "$step"
  "$VENV/bin/python" "$ROOT/scripts/sdss/build.py" "$step"
done
ls -l "$ROOT/public/assets/sdss"
