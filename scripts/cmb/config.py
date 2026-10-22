"""Pinned inputs and output parameters for the Planck CMB texture pipeline.

Every value that ends up in public/assets/cmb/cmb.json is defined here once,
so the pipeline is reproducible from the FITS file alone.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache"
WORK = CACHE / "cmb-work"
PUBLIC = ROOT / "public" / "assets" / "cmb"

# --- Source map -------------------------------------------------------------

FITS_NAME = "COM_CMB_IQU-smica_2048_R3.00_full.fits"
FITS_PATH = CACHE / "planck" / FITS_NAME
# sha256 of the file as served by IRSA (size matches IRSA's Content-Length).
# Neither IRSA nor the PLA publishes a checksum, so this pins our own download.
FITS_SHA256 = "60952c645eb33d151905ddf5837477e15ca02a3261feca4ceca3c3feece4f9ac"
FITS_BYTES = 2_013_312_960
FITS_URL = (
    "https://irsa.ipac.caltech.edu/data/Planck/release_3/all-sky-maps/maps/"
    "component-maps/cmb/COM_CMB_IQU-smica_2048_R3.00_full.fits"
)
FITS_PLA_URL = (
    "https://pla.esac.esa.int/pla/aio/product-action?MAP.MAP_ID="
    "COM_CMB_IQU-smica_2048_R3.00_full.fits"
)
RELEASE = "PR3 (2018)"
METHOD = "SMICA"

# The inpainted column has no masked pixels and no Galactic-plane residuals.
PREFERRED_COLUMN = "I_STOKES_INP"
FALLBACK_COLUMN = "I_STOKES"
EXPECTED_UNIT = "K_CMB"
EXPECTED_COORDSYS = "GALACTIC"
K_TO_MICROKELVIN = 1.0e6

# --- Processing -------------------------------------------------------------

# Extra Gaussian smoothing on top of the map's native beam: about one texel
# of the 4096-wide grid at the equator (5.27 arcmin), so resampling does not alias.
SMOOTHING_FWHM_ARCMIN = 5.0
WIDTH = 4096
HEIGHT = 2048

# Colour scale of the Planck 2018 SMICA figure (see RANGE_SOURCE).
RANGE_MICROKELVIN = (-300.0, 300.0)
RANGE_SOURCE = (
    "Planck Collaboration 2020, A&A 641, A1 (Planck 2018 results. I), figure "
    "'Planck CMB sky', top panel (2018 SMICA temperature map): colour bar "
    "-300 to 300 uK. Checked in the arXiv:1807.06205 source, file moll_temp_v2.jpg."
)

# --- Colour map -------------------------------------------------------------

# Planck "Parchment" table (also called colombi1), 256 sRGB entries. healpy ships
# an identical copy; we load it from the pinned healpy install and check its hash.
COLORMAP_NAME = "planck-parchment"
COLORMAP_TABLE_SHA256 = "d36d071d63373f48aa9e1e5339e4966cc822763f7fbdd06495d619c6895464e5"
COLORMAP_SOURCE = {
    "table": "Planck_Parchment_RGB.txt (256 RGB entries, 0-255)",
    "url": "https://github.com/zonca/paperplots/blob/3d647c154fe448d3eafc43687fe72b2580957fee/data/Planck_Parchment_RGB.txt",
    "via": "healpy 1.20.1 healpy/data/planck_cmap.dat (numerically identical)",
    "note": (
        "From the Planck collaboration's public figure style-guide examples "
        "(github.com/zonca/paperplots, A. Zonca, 2013). No primary ESA/PLA "
        "download of the table was found. Verified against the colour bar of "
        "the Planck 2018 results I SMICA figure: mean absolute difference "
        "about 2.5/255 per channel (JPEG noise)."
    ),
}
# The table is close to piecewise linear with 7 knots. Legend stops are those knots
# plus this many equal subdivisions of each segment (6 x 4 + 1 = 25 stops).
LEGEND_SUBDIVISIONS = 4

# --- Outputs ----------------------------------------------------------------

GRID_PATH = WORK / "grid-4096x2048-uK.npy"
GRID_STATS_PATH = WORK / "grid-stats.json"
# Mip-level PNGs stored bottom-up (first row = south), the row order of the KTX2 files.
LEVELS_DIR = WORK / "levels-bottom-up"
LOSSLESS_PNG = WORK / "cmb-4096-lossless.png"
PREVIEW_DIR = WORK / "preview"
DECODED_DIR = WORK / "decoded"
ENCODE_REPORT_PATH = WORK / "encode-report.json"

CREDIT = "ESA and the Planck Collaboration"
OUTPUT_FILES = {"4096": "cmb-4096.ktx2", "2048": "cmb-2048.ktx2"}
SIZE_BUDGET_BYTES = {"4096": 4 * 1024 * 1024, "2048": int(1.2 * 1024 * 1024)}

# --- KTX2 encoding ----------------------------------------------------------

# KTX-Software command-line tools, unpacked by scripts/cmb/fetch-ktx.sh.
KTX_PREFIX = CACHE / "ktx-software" / "prefix"
# UASTC + zstd does not fit the size budget: the map is close to incompressible
# noise at texel scale (UASTC q2 + zstd 20 is 8.8 MB at 4096 and 7.4 MB even with
# RDO lambda 10), so we use ETC1S/BasisLZ at its highest quality setting.
KTX_CODEC = "ETC1S (BasisLZ)"
KTX_ENCODE_ARGS = ["--encode", "basis-lz", "--clevel", "5", "--qlevel", "255"]

# A known large-scale feature used to check orientation.
COLD_SPOT_LON_LAT = (209.0, -57.0)
