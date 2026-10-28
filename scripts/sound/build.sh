#!/usr/bin/env bash
# Rebuilds public/assets/sound/*.m4a, the film's recorded sounds, from their public-domain and CC0
# originals. Usage: npm run preprocess:sound [-- name ...] (only the sounds named, e.g. rain surf).
#
# Needs: macOS (afconvert encodes AAC), Python 3.9 or later (override with SOUND_PYTHON), network
# access to pypi.org / files.pythonhosted.org (first run) and, on the first run, to the hosts of the
# originals listed in scripts/sound/build.py (usgs.gov's S3 buckets, upload.wikimedia.org, nps.gov).
# The originals are kept in .cache/sound-originals (or $KF_SOUND_ORIGINALS), never committed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON="${SOUND_PYTHON:-python3}"
VENV="$ROOT/.cache/venv-sound"
REQUIREMENTS="$ROOT/scripts/sound/requirements.txt"
export PYTHONDONTWRITEBYTECODE=1

if ! command -v afconvert >/dev/null; then
  echo "afconvert not found: the sounds are encoded with macOS's afconvert" >&2
  exit 1
fi
if [[ ! -x "$VENV/bin/python" ]]; then
  "$PYTHON" -m venv "$VENV"
fi
if ! cmp -s "$REQUIREMENTS" "$VENV/.requirements.txt"; then
  "$VENV/bin/python" -m pip install --quiet -r "$REQUIREMENTS"
  cp "$REQUIREMENTS" "$VENV/.requirements.txt"
fi
"$VENV/bin/python" -I "$ROOT/scripts/sound/build.py" "$@"
