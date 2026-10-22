#!/usr/bin/env bash
# Rebuilds public/assets/cmb/{cmb-4096.ktx2,cmb-2048.ktx2,cmb.json} from the Planck
# PR3 SMICA HEALPix map. Usage: npm run preprocess:cmb
#
# Needs: .cache/planck/COM_CMB_IQU-smica_2048_R3.00_full.fits (2.0 GB, see the URL in
# scripts/cmb/config.py), Python 3.13 (override with CMB_PYTHON), network access to
# pypi.org / files.pythonhosted.org (first run), github.com and its release-asset hosts
# (KTX-Software, first run) and, optionally, arxiv.org (reference figure, first run).
# Intermediate files, previews and a lossless PNG copy go to .cache/cmb-work.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${CMB_PYTHON:-$HOME/.local/bin/python3.13}"
VENV="$ROOT/.cache/venv-cmb"
REQUIREMENTS="$ROOT/scripts/cmb/requirements.txt"
BUILD="$ROOT/scripts/cmb/build.py"
# Keep scripts/cmb free of __pycache__ (it is source, not a cache).
export PYTHONDONTWRITEBYTECODE=1

step() { printf '\n== %s\n' "$*"; }

step "Python environment ($VENV)"
if [[ ! -x "$VENV/bin/python" ]]; then
  "$PYTHON" -m venv "$VENV"
fi
if ! cmp -s "$REQUIREMENTS" "$VENV/.requirements.txt"; then
  # pip's default macOS trust store can be unavailable in sandboxes; fall back to certifi.
  "$VENV/bin/python" -m pip install --quiet -r "$REQUIREMENTS" \
    || "$VENV/bin/python" -m pip install --quiet --use-deprecated=legacy-certs -r "$REQUIREMENTS"
  cp "$REQUIREMENTS" "$VENV/.requirements.txt"
fi

step "KTX-Software"
bash "$ROOT/scripts/cmb/fetch-ktx.sh"

step "Planck 2018 reference figure (optional, for verification only)"
bash "$ROOT/scripts/cmb/fetch-reference.sh" || echo "skipped: the figure comparison will be recorded as null"

for name in verify-source grid images encode preview manifest; do
  step "$name"
  "$VENV/bin/python" "$BUILD" "$name"
done

step "done"
ls -l "$ROOT/public/assets/cmb"
