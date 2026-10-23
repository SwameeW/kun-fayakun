"""Pinned inputs, tiers, codecs and checks for the planet texture pipeline.

Run through scripts/preprocess-planets.sh. Every value that ends up in
public/assets/planets/planets.json or in the planet entries of data/sources.json is
defined here once, so the textures can be rebuilt from the pinned downloads alone.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache" / "planets"
# Each source gets its own directory below DOWNLOAD (downloads are untrusted data).
DOWNLOAD = CACHE / "download"
# Mip-level PNGs (rows bottom-up), decoded outputs and reports.
WORK = CACHE / "work"
REPORTS = CACHE / "reports"
PREVIEW = CACHE / "preview"
# A tier left out of PUBLISHED_TIERS would be built here and not published (every tier is published now).
ULTRA = CACHE / "ultra"
PUBLIC = ROOT / "public" / "assets" / "planets"
# The site path that planets.json paths start with (resolved by assets.url at runtime).
SITE_PREFIX = "assets/planets"
MANIFEST = PUBLIC / "planets.json"
SOURCES_JSON = ROOT / "data" / "sources.json"
# The JPL builder already downloads and pins the Cassini RSS ring profile (scripts/jpl/build.py).
JPL_CACHE = ROOT / ".cache" / "jpl"
# Its published elements and pole give Saturn's geometry when the ring mosaic was taken.
JPL_PUBLIC = ROOT / "public" / "assets" / "jpl"
KTX_PREFIX = ROOT / ".cache" / "ktx-software" / "prefix"
USER_AGENT = "kun-fayakun/0.1 (educational; github.com/SwameeW/kun-fayakun)"

# 21600 x 10800 sources are 233 megapixels; Pillow refuses anything above about 179 MP.
MAX_IMAGE_PIXELS = 300_000_000


# --- Sources ----------------------------------------------------------------------------


@dataclass(frozen=True)
class SourceFile:
    """One pinned download: its URL, byte count and sha256 (taken on first download)."""

    source_id: str
    url: str
    bytes: int
    sha256: str
    last_modified: str
    fallback: str | None = None

    @property
    def name(self) -> str:
        return self.url.rsplit("/", 1)[-1]

    @property
    def path(self) -> Path:
        return DOWNLOAD / self.source_id / self.name


SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/"
OPAL = "https://archive.stsci.edu/missions/hlsp/opal/cycle32/"
NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/"
CLOUDS_URL = "https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif"

FILES: dict[str, SourceFile] = {
    "bmng": SourceFile(
        "nasa-bmng-2004",
        "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/july/world.200407.3x21600x10800.jpg",
        21_125_326, "dea8b4dc8a4f93f5f8bce0c8c85a508a178e7901e9ed8e6bf86e6ce7ef6d61e2", "served 2026-10-23",
    ),
    "blackMarble": SourceFile(
        "nasa-black-marble-2016",
        "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144897/BlackMarble_2016_3km_gray.jpg",
        3_064_569, "3fbc8aae3529dc1ebfcf3aa9361bd3dfc11d19950a6af6d8ed2df61bd8b0134d", "2024-11-27",
    ),
    "clouds": SourceFile(
        "nasa-blue-marble-clouds-2002",
        CLOUDS_URL,
        35_870_468, "d137775d8966ab8d443fd5126dc6e7ad72072bc1ed50555c5818d221735daf0f", "2011-10-05",
        # eoimages.gsfc.nasa.gov is the last host still serving the 2002 files (assets.science.nasa.gov
        # answers 404); this Wayback copy has the same byte count.
        fallback="http://web.archive.org/web/20260318202426/" + CLOUDS_URL,
    ),
    "etopo": SourceFile(
        "noaa-etopo-2022",
        "https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif",
        465_969_062, "9d27d4b8ea8e76977e2988bca667d7c8fa68b927355feffcddd6b4875a7fd08e", "2022-10-04",
    ),
    "neLand": SourceFile(
        "natural-earth-5.1.2", NE + "ne_10m_land.geojson",
        10_157_965, "1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416", "tag v5.1.2",
    ),
    "neLakes": SourceFile(
        "natural-earth-5.1.2", NE + "ne_10m_lakes.geojson",
        5_043_554, "2d036f53dedec578001c5c30c2959ee7d4eebc1306900fa4367c49929ec8f2d9", "tag v5.1.2",
    ),
    "moonColour": SourceFile(
        "nasa-svs-cgi-moon-kit", SVS + "lroc_color_poles_8k.tif",
        50_641_970, "4af8b0cd4d50c30851359d98e7e72040240dd8d03256b58b345b5b76e9edb4ef", "2019-06-05",
    ),
    # SVS's own 2k and 4k reductions of the same map: used only to check that this pipeline's
    # reduction of the 8k file lands on the same texels (no shift, no flip).
    "moonColour2k": SourceFile(
        "nasa-svs-cgi-moon-kit", SVS + "lroc_color_poles_2k.tif",
        3_339_438, "13b797422e8c4b8607ff2b2623ac3a046a6da0132d567c2d272d92fad7052c4a", "2019-06-05",
    ),
    "moonColour4k": SourceFile(
        "nasa-svs-cgi-moon-kit", SVS + "lroc_color_poles_4k.tif",
        13_095_388, "918649a7f8ed2f1329b2cd95bb0d25483befdcb60ae1a66db681a637cc21344f", "2019-06-05",
    ),
    "moonHeight": SourceFile(
        "nasa-svs-cgi-moon-kit", SVS + "ldem_16_uint.tif",
        33_201_026, "45a2b32d56e81ed30db07fead8abc842b249b6511219d9ca2c53f81bc2dc5d62", "2019-06-05",
    ),
    "jupiter": SourceFile(
        "hst-opal-jupiter-2025a", OPAL + "jupiter/hlsp_opal_hst_wfc3-uvis_jupiter-2025a_f395n-f502n-f631n_v1_globalmap.tif",
        19_444_834, "52b6cc32639f699ff5614b169c4c2727fff98e7eb432aff7c718177191716e6c", "2026-03-31",
    ),
    "jupiterReadme": SourceFile(
        "hst-opal-jupiter-2025a", OPAL + "jupiter/hlsp_opal_hst_wfc3-uvis_jupiter-2025_all_v1_readme.txt",
        1_733, "344f5c1bcae360edfc7b4f1183b9ed47f887cbbe7fa0518fdf577c915784fdad", "2026-03-31",
    ),
    "saturn": SourceFile(
        "hst-opal-saturn-2025a", OPAL + "saturn/hlsp_opal_hst_wfc3-uvis_saturn-2025a_f395n-f502n-f631n_v1_globalmap.tif",
        4_885_052, "c34a13a8253a39bcc1f8376b24c077b89f05ce0b5202706f535ded20314440d7", "2025-10-10",
    ),
    "saturnReadme": SourceFile(
        "hst-opal-saturn-2025a", OPAL + "saturn/hlsp_opal_hst_wfc3-uvis_saturn-2025_all_v1_readme.txt",
        1_625, "31059e9f106905f1ca34c924e005c3094e7c33e94d19a1f5178fcb7f186ca3ca", "2025-10-10",
    ),
    "ringColour": SourceFile(
        "cassini-pia11142",
        "https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia11/pia11142/PIA11142.tif",
        52_348_165, "09ed86b99a7255c8527efbbcf6188730e6dc6a6a6dcccb367ef214bc9b8a5b6a", "2024-11-24",
    ),
}

# The ring optical-depth table comes from the JPL builder's cache; this is the sha256 that
# public/assets/jpl/physical.json records for it (sources.rings).
RINGS_TABLE = JPL_CACHE / "RSS_2005_123_X43_E_TAU_10KM.TAB"
RINGS_TABLE_URL = (
    "https://pds-rings.seti.org/holdings/volumes/CORSS_8xxx/CORSS_8001/data/Rev007/Rev007E/"
    "Rev007E_RSS_2005_123_X43_E/RSS_2005_123_X43_E_TAU_10KM.TAB"
)
RINGS_TABLE_SHA256 = "0a1a39498833bb4fa9583a4db178c99c757948acb91ea6dda834919c9dd4c9a4"


@dataclass(frozen=True)
class SourceEntry:
    """A data/sources.json entry (SourceEntry in src/core/types.ts) for one planet source."""

    id: str
    title: str
    author: str
    url: str
    version: str
    license: str
    license_url: str | None
    credit: str
    notes: str


NASA_MEDIA = "https://www.nasa.gov/nasa-brand-center/images-and-media/"
EO_POLICY = "https://web.archive.org/web/20250101064811/https://earthobservatory.nasa.gov/image-use-policy"
EO_TERMS = (
    "Public domain (U.S. Government work). NASA Earth Observatory's image use policy: its materials may be "
    "re-published or re-used, commercially too, except where a copyright is indicated; it asks to be credited, "
    "and the only mandatory credit is NASA. Use must not imply NASA endorsement; no NASA insignia or logotype is used."
)
OPAL_ACKNOWLEDGEMENT = (
    "This work used data acquired from the NASA/ESA HST Space Telescope, associated with OPAL program (PI: Simon, "
    "GO13937), and archived by the Space Telescope Science Institute, which is operated by the Association of "
    "Universities for Research in Astronomy, Inc., under NASA contract NAS 5-26555. All maps are available at "
    "http://dx.doi.org/10.17909/T9G593."
)
# The OPAL HLSP page licenses its maps under CC BY 4.0 (not the STScI Content Use Policy that covers
# STScI's own web material), so each use needs the credit, a link to the licence and the changes made.
OPAL_TERMS = (
    "CC BY 4.0. The OPAL HLSP page (https://archive.stsci.edu/hlsp/opal, HLSP author and PI Amy Simon): \"These HLSP "
    "data products are licensed for use under CC BY 4.0\". Attribution: the credit line, the link to the map and "
    "doi:10.17909/T9G593; the changes this project made are listed in the notes. The page also asks publications to "
    "cite its papers (Simon et al. 2015, Wong et al. 2020) and the DOI, and to include the OPAL acknowledgement quoted "
    "in the notes."
)
OPAL_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/"
# The form of NASA/ESA OPAL image releases; the HLSP page names Amy Simon as the maps' author. Unconfirmed
# by the owner (M. H. Wong, co-author of the OPAL papers, is not named).
OPAL_CREDIT = "NASA, ESA, A. Simon (NASA GSFC) and the OPAL team"
# Visible Earth record 57747's credit line, verbatim up to its "Additional data" clause (topography,
# Antarctica and city lights), which is about the other Blue Marble 2002 layers, not the clouds.
CLOUDS_CREDIT = (
    "NASA Goddard Space Flight Center Image by Reto Stöckli (land surface, shallow water, clouds). Enhancements by "
    "Robert Simmon (ocean color, compositing, 3D globes, animation). Data and technical support: MODIS Land Group; "
    "MODIS Science Data Support Team; MODIS Atmosphere Group; MODIS Ocean Group"
)
CLOUDS_RECORD = "https://web.archive.org/web/20250109030918/https://visibleearth.nasa.gov/images/57747/blue-marble-clouds"

SOURCES: list[SourceEntry] = [
    SourceEntry(
        id="nasa-bmng-2004",
        title="Blue Marble: Next Generation, base map without relief shading, July 2004 (world.200407.3x21600x10800.jpg)",
        author="Reto Stöckli, NASA Earth Observatory (NASA Goddard Space Flight Center)",
        url=FILES["bmng"].url,
        version="July 2004 monthly composite, 21600 x 10800 (about 2 km per pixel)",
        license=EO_TERMS,
        license_url=EO_POLICY,
        credit="Blue Marble: Next Generation, Reto Stöckli, NASA Earth Observatory (NASA Goddard Space Flight Center)",
        notes=(
            "The Earth's daytime colour in exploration (public/assets/planets/earth/day-*.ktx2). The base map has no "
            "topographic or bathymetric shading baked in, so relief comes only from the ETOPO 2022 normal map. "
            "Collection page: https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/. "
            "The exploration Earth is a composite of several epochs (land and sea ice July 2004, clouds 2001, night lights "
            "2016) and is captioned as such."
        ),
    ),
    SourceEntry(
        id="nasa-black-marble-2016",
        title="Earth at Night: Black Marble 2016, greyscale, 3 km (BlackMarble_2016_3km_gray.jpg)",
        author="Joshua Stevens, NASA Earth Observatory; Suomi NPP VIIRS data from Miguel Román, NASA GSFC",
        url=FILES["blackMarble"].url,
        version="2016 composite, 13500 x 6750 (about 3 km per pixel)",
        license=EO_TERMS,
        license_url=EO_POLICY,
        credit="NASA Earth Observatory images by Joshua Stevens, using Suomi NPP VIIRS data from Miguel Román, NASA GSFC",
        notes=(
            "City lights on the night side of the present-day exploration Earth only (public/assets/planets/earth/"
            "night-*.ktx2); never shown on the film's earlier epochs. The faint grey floor over land is subtracted "
            "before encoding (scripts/planets/build.py). Credit as printed on the archived Visible Earth record 144898."
        ),
    ),
    SourceEntry(
        id="nasa-blue-marble-clouds-2002",
        title="Blue Marble: clouds (cloud_combined_8192.tif), 2002",
        author="Reto Stöckli, NASA Goddard Space Flight Center (Blue Marble 2002, MODIS data)",
        url=FILES["clouds"].url,
        version="Blue Marble 2002 cloud composite, 8192 x 4096",
        license=EO_TERMS,
        license_url=EO_POLICY,
        credit=CLOUDS_CREDIT,
        notes=(
            "The cloud layer of the exploration Earth (public/assets/planets/earth/clouds-*.ktx2): two days of visible "
            "imagery plus thermal infrared over the poles, from 2001 (so Antarctica reads as cloud-bright). "
            f"Credit as printed on the archived Visible Earth record 57747 ({CLOUDS_RECORD}), up to its \"Additional "
            f"data\" clause, which names the topography, Antarctica and city-light layers. Fallback copy: {FILES['clouds'].fallback}."
        ),
    ),
    SourceEntry(
        id="noaa-etopo-2022",
        title="ETOPO 2022 Global Relief Model, 60 arc-second surface elevation (ETOPO_2022_v1_60s_N90W180_surface.tif)",
        author="NOAA National Centers for Environmental Information",
        url=FILES["etopo"].url,
        version="ETOPO 2022 v1, 60 arc-second, ice-surface elevation, WGS 84 with EGM2008 heights",
        license=(
            "CC0-1.0: produced by NOAA and not subject to copyright protection in the United States; NOAA waives any "
            "potential copyright and related rights worldwide through the Creative Commons Zero 1.0 Universal Public "
            "Domain Dedication (dataset ISO metadata). Not to be used for navigation."
        ),
        license_url="https://creativecommons.org/publicdomain/zero/1.0/",
        credit="NOAA National Centers for Environmental Information. 2022: ETOPO 2022 15 Arc-Second Global Relief Model. https://doi.org/10.25921/fd45-gt74",
        notes=(
            "Land relief of the exploration Earth: tangent-space normal maps derived from the elevations (public/assets/"
            "planets/earth/normal-*.ktx2), with relief exaggerated for visibility (factor in planets.json) and water "
            "surfaces flat. The 60 arc-second file is a product of the ETOPO 2022 model cited above."
        ),
    ),
    SourceEntry(
        id="natural-earth-5.1.2",
        title="Natural Earth 1:10m physical vectors: land and lakes (ne_10m_land, ne_10m_lakes), version 5.1.2",
        author="Natural Earth (Tom Patterson, Nathaniel Vaughn Kelso and contributors)",
        url="https://github.com/nvkelso/natural-earth-vector/tree/v5.1.2/geojson",
        version="5.1.2 (git tag v5.1.2)",
        license="Public domain: no permission is needed to use Natural Earth and crediting the authors is unnecessary (Natural Earth terms of use).",
        license_url="https://www.naturalearthdata.com/about/terms-of-use/",
        credit="Made with Natural Earth",
        notes=(
            "The Earth's water mask (oceans, seas and lakes; public/assets/planets/earth/water-*.ktx2), rasterised with "
            "4 x 4 supersampling, and the flat water surfaces of the normal maps. Elevation below 0 m is not used as "
            "water, so dry depressions such as Death Valley and the Qattara Depression stay land."
        ),
    ),
    SourceEntry(
        id="nasa-svs-cgi-moon-kit",
        title="CGI Moon Kit (SVS 4720): LROC colour map lroc_color_poles (2019) and LOLA displacement map ldem_16_uint",
        author="Ernie Wright (USRA), NASA's Scientific Visualization Studio; scientist Noah Petro (NASA/GSFC)",
        url="https://svs.gsfc.nasa.gov/4720",
        version="2019 colour map (lroc_color_poles_8k.tif, 8192 x 4096) and ldem_16_uint.tif (5760 x 2880, 16 pixels per degree)",
        license=(
            "Public domain unless otherwise noted (NASA SVS: free to download, use and redistribute); NASA's media "
            "usage guidelines apply (credit NASA, imply no endorsement)."
        ),
        license_url="https://svs.gsfc.nasa.gov/help/",
        credit=(
            "NASA's Scientific Visualization Studio (Ernie Wright, USRA; scientist Noah Petro, NASA/GSFC), "
            "from LRO LROC WAC (Arizona State University) and LOLA data"
        ),
        notes=(
            "The Moon's colour (public/assets/planets/moon/colour-*.ktx2) and its LOLA relief as normal maps "
            "(moon/normal-*.ktx2). SVS describes the colour map as made for rendering rather than science: a natural-"
            "colour rendition of the Hapke-normalised LROC WAC mosaic (643, 566 and 415 nm), with latitudes beyond "
            "70 degrees filled from LOLA albedo. Heights are half-metres above a 1,727,400 m radius (reference sphere "
            "1,737,400 m)."
        ),
    ),
    SourceEntry(
        id="hst-opal-jupiter-2025a",
        title="Outer Planet Atmospheres Legacy (OPAL): Jupiter 2025a global colour map (F395N, F502N, F631N), HST WFC3/UVIS",
        author="Amy Simon (NASA GSFC) and the OPAL team; Hubble Space Telescope; archived by STScI (MAST)",
        url=FILES["jupiter"].url,
        version="HST Cycle 32, rotation 2025a (2025-12-11), HLSP v1, 3600 x 1800",
        license=OPAL_TERMS,
        license_url=OPAL_LICENSE_URL,
        credit=OPAL_CREDIT,
        notes=(
            "Jupiter's colour in exploration (public/assets/planets/jupiter/colour-*.ktx2). Planetographic latitude, "
            "System III longitude (the map's left edge is 0 degrees west, decreasing to the right). Changes made by this "
            "project (CC BY 4.0): resampled from 3600 x 1800 to 1024, 2048 and 4096 wide and mip-mapped; the polar caps "
            "the map leaves black filled with the mean colour of the last observed latitudes; encoded as KTX2 (ETC1S and "
            f"UASTC, lossy). OPAL acknowledgement: \"{OPAL_ACKNOWLEDGEMENT}\" HLSP page: https://archive.stsci.edu/hlsp/opal "
            "(doi:10.17909/T9G593). The short credit follows the form of NASA/ESA OPAL image releases."
        ),
    ),
    SourceEntry(
        id="hst-opal-saturn-2025a",
        title="Outer Planet Atmospheres Legacy (OPAL): Saturn 2025a global colour map (F395N, F502N, F631N), HST WFC3/UVIS",
        author="Amy Simon (NASA GSFC) and the OPAL team; Hubble Space Telescope; archived by STScI (MAST)",
        url=FILES["saturn"].url,
        version="HST Cycle 32, rotation 2025a (2025-08-29), HLSP v1, 1800 x 900",
        license=OPAL_TERMS,
        license_url=OPAL_LICENSE_URL,
        credit=OPAL_CREDIT,
        notes=(
            "Saturn's globe colour in exploration (public/assets/planets/saturn/colour-*.ktx2). Planetographic latitude, "
            "System III longitude (left edge 360 degrees west, decreasing to the right). Changes made by this project "
            "(CC BY 4.0): observed near the ring-plane crossing, so the thin equatorial band the rings hide and the polar "
            "caps are filled from the adjacent observed latitudes; moons and moon shadows that crossed the planet are "
            "replaced by their row's running median; resampled from 1800 x 900 to 1024 and 2048 wide and mip-mapped; "
            "encoded as KTX2 (ETC1S and UASTC, lossy). OPAL acknowledgement: "
            f"\"{OPAL_ACKNOWLEDGEMENT}\" HLSP page: https://archive.stsci.edu/hlsp/opal (doi:10.17909/T9G593)."
        ),
    ),
    SourceEntry(
        id="cassini-pia11142",
        title="A Full Sweep of Saturn's Rings (PIA11142), Cassini narrow-angle camera natural-colour mosaic, 2008-11-26",
        author="NASA/JPL/Space Science Institute",
        url="https://science.nasa.gov/photojournal/a-full-sweep-of-saturns-rings/",
        version="PIA11142.tif, 12126 x 1439, about 7 km per pixel radially",
        license="Public domain (NASA/JPL Photojournal; NASA's media usage guidelines apply: credit NASA, imply no endorsement).",
        license_url=NASA_MEDIA,
        credit="NASA/JPL/Space Science Institute",
        notes=(
            "The colour of Saturn's rings in exploration (the RGB channels of public/assets/planets/saturn/"
            "rings-8192-rgba8.ktx2): the lit face seen from 10 degrees below it at 28 degrees phase, averaged across the "
            "arcs near the mosaic's apex and placed on ring radius by matching its gaps to the Cassini RSS optical-depth "
            "profile. Where the rings are thin the mosaic's brightness is divided by the share of a thick ring's light "
            "they return in its geometry (single scattering), so the strip holds the ring material's own colour; gaps "
            "and empty space take the nearest ring material's colour (straight alpha)."
        ),
    ),
]

SOURCE_IDS = {s.id for s in SOURCES} | {"cassini-rss-rings"}


# --- Tiers and encodings ----------------------------------------------------------------

# Equirectangular width per detail tier (height is half). All four are published (served with the site).
TIERS: dict[str, int] = {"low": 1024, "medium": 2048, "high": 4096, "ultra": 8192}
PUBLISHED_TIERS = ("low", "medium", "high", "ultra")
TOP_WIDTH = TIERS["ultra"]

# Transfer budgets (bytes) per published tier set, and for everything committed together.
# The tier budgets are the synthesis' Stage 7 ceilings; the total keeps the repository and the site
# (GitHub Pages, 1 GB) well within their limits with Ultra included.
TIER_BUDGET_BYTES = {"low": 4_000_000, "medium": 12_000_000, "high": 60_000_000, "ultra": 160_000_000}
COMMITTED_BUDGET_BYTES = 135_000_000

# Colour: ETC1S (BasisLZ) at Low and Medium, UASTC + RDO + zstd at High and Ultra.
# --uastc-rdo-m keeps RDO single-threaded so a rebuild gives the same bytes.
ETC1S_ARGS = ["--encode", "basis-lz", "--clevel", "5", "--qlevel", "255"]
UASTC_ARGS = ["--encode", "uastc", "--uastc-quality", "3", "--uastc-rdo", "--uastc-rdo-l", "1.5", "--uastc-rdo-m", "--zstd", "20"]
# Normal maps: UASTC in normal mode (X in RGB, Y in alpha), a low RDO lambda as KTX-Software advises.
NORMAL_ARGS = [
    "--encode", "uastc", "--uastc-quality", "3", "--uastc-rdo", "--uastc-rdo-l", "0.75", "--uastc-rdo-m",
    "--normal-mode", "--zstd", "20",
]
# Single-channel data: raw R8 with lossless zstd (three uploads it as an r8unorm texture).
R8_ARGS = ["--format", "R8_UNORM", "--assign-tf", "linear", "--assign-primaries", "none", "--zstd", "19"]
STRIP_ARGS = ["--format", "R8G8B8A8_SRGB", "--assign-tf", "srgb", "--assign-primaries", "srgb", "--zstd", "19"]


@dataclass(frozen=True)
class MapSpec:
    """One texture of one body, built for every tier from one mip chain."""

    body: str
    map: str
    kind: str  # colour | grey | normal | strip
    source_id: str
    extra_sources: tuple[str, ...] = ()
    # Widest level the source supports (a power of two at most one step above its native width).
    max_width: int = TOP_WIDTH
    # Widest published level, when the committed size budget asks for less than the source gives.
    published_max_width: int | None = None
    description: str = ""
    encoding: str = ""
    channels: dict[str, str] = field(default_factory=dict)
    # For maps with an alpha channel: "straight" (rgb is not multiplied by a) or "premultiplied".
    alpha: str | None = None


MAPS: list[MapSpec] = [
    MapSpec(
        "earth", "day", "colour", "nasa-bmng-2004",
        description="Daytime surface colour (land, ice and ocean, July 2004), no relief shading baked in.",
        encoding="sRGB colour.",
    ),
    MapSpec(
        "earth", "night", "grey", "nasa-black-marble-2016",
        description="City lights at night (2016), the faint land floor removed. Present-day Earth only.",
        encoding="R8, sRGB-encoded brightness (decode with the sRGB curve before adding as emission).",
    ),
    MapSpec(
        "earth", "clouds", "grey", "nasa-blue-marble-clouds-2002",
        description="Cloud cover (2001 composite; the poles from thermal infrared, so Antarctica reads as cloud).",
        encoding="R8, cloud opacity 0..1 (linear).",
    ),
    MapSpec(
        "earth", "water", "grey", "natural-earth-5.1.2",
        description="Water mask for ocean specular and flat water: oceans, seas and lakes.",
        encoding="R8, water fraction 0..1 (1 = water), from 4 x 4 supersampled vectors.",
    ),
    MapSpec(
        "earth", "normal", "normal", "noaa-etopo-2022", extra_sources=("natural-earth-5.1.2",),
        description="Land relief as tangent-space normals from ETOPO 2022 surface heights (ice surface on ice sheets); water is flat.",
        encoding="UASTC normal mode: X in RGB, Y in A, Z = sqrt(1 - X^2 - Y^2).",
    ),
    MapSpec(
        "moon", "colour", "colour", "nasa-svs-cgi-moon-kit",
        description="Natural-colour albedo (LROC WAC, Hapke-normalised: no shading baked in).",
        encoding="sRGB colour.",
    ),
    # Crater-saturated relief barely compresses: the 4096 level is 9.1 MB, the largest published file.
    # It still fits the committed budget (about 44.5 of 45 MB in all), so High gets it as it does
    # every other map; Ultra reuses it.
    MapSpec(
        "moon", "normal", "normal", "nasa-svs-cgi-moon-kit", max_width=4096,
        description="LOLA relief as tangent-space normals (source 16 pixels per degree, so 4096 is the widest level).",
        encoding="UASTC normal mode: X in RGB, Y in A, Z = sqrt(1 - X^2 - Y^2).",
    ),
    MapSpec(
        "jupiter", "colour", "colour", "hst-opal-jupiter-2025a", max_width=4096,
        description="Hubble OPAL colour composite of 2025-12-11 (source 3600 x 1800, so 4096 is the widest level).",
        encoding="sRGB colour.",
    ),
    MapSpec(
        "saturn", "colour", "colour", "hst-opal-saturn-2025a", max_width=2048,
        description="Hubble OPAL colour composite of 2025-08-29 (source 1800 x 900, so 2048 is the widest level).",
        encoding="sRGB colour.",
    ),
    MapSpec(
        "saturn", "rings", "strip", "cassini-rss-rings", extra_sources=("cassini-pia11142",), max_width=8192,
        description=(
            "Saturn's main rings along their radius: opacity from the Cassini RSS normal optical depth (2005), colour "
            "of the lit face from the Cassini PIA11142 mosaic (2008). One 8192 x 1 strip for every tier."
        ),
        encoding="RGBA8 sRGB, lossless zstd, straight alpha.",
        channels={
            "a": "normal opacity 1 - exp(-tau), tau the RSS normal optical depth averaged as transmission over the texel, "
            "and 0 where tau is below the profile's noise floor (facts.saturnRings.opacityNoise); for a ray at angle "
            "mu = |cos| to the ring normal use 1 - (1 - a)^(1/mu)",
            "rgb": "straight alpha (not premultiplied): the colour of the ring material's lit face, the PIA11142 colour "
            "divided by the share of a thick ring's light the ring returned in that mosaic's geometry (facts.saturnRings."
            "colourModel), so thin rings are not darkened twice. Gaps and the empty space inside the C ring and beyond "
            "the A ring carry the nearest ring material's colour, so filtering never pulls black into the rings. Blend "
            "as mix(background, rgb * light, a_view) with a_view = 1 - (1 - a)^(1/mu)",
        },
        alpha="straight",
    ),
]

# Relief exaggeration baked into the normal maps (true slopes are invisible at these scales:
# the Himalaya rise about 5 km over 100 km). Recorded in planets.json.
RELIEF_EXAGGERATION = {"earth": 12.0, "moon": 2.5}
# Mean radii (km) for slopes: metres per radian of latitude and of longitude at the equator.
MEAN_RADIUS_KM = {"earth": 6371.0, "moon": 1737.4}

# --- Bodies: map conventions --------------------------------------------------------------

BODIES = {
    "earth": {
        "longitude": "east longitude (Greenwich at u = 0.5), as in the source maps (-180 to 180 from the left edge)",
        "latitude": "geodetic (WGS 84), i.e. the latitude of the surface normal",
        "uAtLon0": 0.5,
        "lonIncreases": "right",
        "caption": "A composite of several epochs: land and sea ice July 2004, clouds 2001, night lights 2016.",
    },
    "moon": {
        "longitude": "east longitude (mean Earth / polar axis frame, centre of the near side at u = 0.5)",
        "latitude": "planetocentric (the Moon is a sphere here)",
        "uAtLon0": 0.5,
        "lonIncreases": "right",
        "caption": "LROC colour and LOLA relief.",
    },
    "jupiter": {
        "longitude": (
            "System III east longitude E = 360 - W from u = 0: the OPAL map's left edge is 0 degrees west and west "
            "longitude decreases to the right"
        ),
        "latitude": "planetographic (sample with the latitude of the ellipsoid's outward normal); OPAL navigated with radii 71492 / 66854 km",
        "uAtLon0": 0.0,
        "lonIncreases": "right",
        "caption": "Hubble OPAL, 2025-12-11. The Great Red Spot drifts in longitude; its position here is that date's.",
    },
    "saturn": {
        "longitude": "System III east longitude E = 360 - W from u = 0 (the OPAL map's left edge is 360 degrees west, decreasing to the right)",
        "latitude": "planetographic (sample with the latitude of the ellipsoid's outward normal); OPAL navigated with radii 60268 / 54364 km",
        "uAtLon0": 0.0,
        "lonIncreases": "right",
        "caption": "Hubble OPAL, 2025-08-29, near the ring-plane crossing.",
    },
}

# Ring strip: radius at u = 0 and u = 1 (the RSS profile's span, km from Saturn's centre).
RINGS_INNER_KM = 72_770.0
RINGS_OUTER_KM = 144_987.5
# Empty space at the profile's outer end, past anything the profile resolves. Its scatter sets the
# noise floor below which a texel's optical depth cannot be told from zero: the RSS label asks for
# the lowest detectable depth to be judged from free-space fluctuations at the scale of interest.
RINGS_FREE_SPACE_KM = (141_000.0, RINGS_OUTER_KM)
RINGS_NOISE_SIGMAS = 3.0

# PIA11142's geometry, which sets how much darker thin ring material looks in it than thick: the
# Photojournal page says it was "taken from 10 degrees below the illuminated side of the rings" on
# 2008-11-26, over about four hours. The Sun's elevation that day is computed (build.py) from the JPL
# builder's elements and pole, not typed in.
RING_MOSAIC_JD_TDB = 2_454_797.0  # 2008-11-26 12:00
RING_MOSAIC_VIEW_ELEVATION_DEG = 10.0
# Texels whose share of a thick ring's light was below this in the mosaic (gaps, the empty space inside
# the C ring and beyond the A ring) take the nearest ring material's colour rather than their own:
# dividing a near-black pixel by a small share would only amplify noise.
RING_MIN_SHARE = 0.5
# The mosaic's ring edges land up to about two texels from the profile's (it blurs them, the
# registration places them to about a texel, and ring edges are not exact circles), so texels this
# close to one the mosaic shows black also take the nearest material's colour. Without this the A
# ring's opaque outer edge would carry the black of the space beyond it.
RING_EDGE_MARGIN_TEXELS = 2
