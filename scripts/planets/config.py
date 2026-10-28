"""Pinned inputs, tiers, codecs and checks for the planet texture pipeline.

Run through scripts/preprocess-planets.sh. Every value that ends up in
public/assets/planets/planets.json or in the planet entries of data/sources.json is
defined here once, so the textures can be rebuilt from the pinned downloads alone.
"""

from __future__ import annotations

import json

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
    # For a URL whose last segment is no file name (a map server's query).
    file_name: str | None = None

    @property
    def name(self) -> str:
        return self.file_name or self.url.rsplit("/", 1)[-1]

    @property
    def path(self) -> Path:
        return DOWNLOAD / self.source_id / self.name


SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/"
OPAL = "https://archive.stsci.edu/missions/hlsp/opal/cycle32/"
NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/"

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

# The Earth's clouds: one day of NASA VIIRS imagery from the three satellites that carry it, as NASA's
# Global Imagery Browse Services (GIBS) serves it. Each satellite's day is a mosaic of afternoon passes
# (about 13:30 local time) with sunglint down the middle of every orbit; the three fly the same orbit
# some minutes apart, so their glints fall on different stretches of sea and their median is free of
# them (build.py). The date is the September equinox, when the Sun lights both poles.
GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
CLOUDS_DATE = "2025-09-22"
CLOUDS_SOURCE = "nasa-gibs-viirs-2025-09-22"
CLOUDS_SATELLITES = ("NOAA20", "SNPP", "NOAA21")
# True colour at 16384 x 8192 (twice the widest level, reduced 2 x 2 in build.py), in tiles of 90 by 90
# degrees: GIBS times out on a whole globe at that size. The snow maps need less (4096 x 2048).
CLOUDS_TILE_DEG = 90
CLOUDS_TILE_PX = 4096
CLOUDS_TILES = tuple((lat0, lon0) for lat0 in (0, -90) for lon0 in (-180, -90, 0, 90))
CLOUDS_SNOW_SIZE = (4096, 2048)


def gibs_map(layer: str, bbox: tuple[float, float, float, float], size: tuple[int, int], fmt: str) -> str:
    """A GIBS WMS 1.3.0 GetMap request for the cloud date (EPSG:4326 boxes are lat, lon, lat, lon)."""
    lat0, lon0, lat1, lon1 = bbox
    return (
        f"{GIBS_WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS={layer}&STYLES=&CRS=EPSG:4326"
        f"&BBOX={lat0:g},{lon0:g},{lat1:g},{lon1:g}&WIDTH={size[0]}&HEIGHT={size[1]}&FORMAT={fmt}&TIME={CLOUDS_DATE}"
    )


def clouds_tile(satellite: str, lat0: int, lon0: int) -> str:
    return f"clouds{satellite}_{lat0}_{lon0}"


def clouds_snow(satellite: str) -> str:
    return f"cloudsSnow{satellite}"


# Byte counts and sha256 of the GIBS responses, taken on first download ("served" is that day).
CLOUDS_PINS: dict[str, tuple[int, str]] = {
    "VIIRS_NOAA20_CorrectedReflectance_TrueColor_2025-09-22_0_-180.jpg": (3_870_605, "83ec9e7eec7bbb5a0ee0cc648ee33693406b784dbaaa0720a2d70c89978b9b64"),
    "VIIRS_NOAA20_CorrectedReflectance_TrueColor_2025-09-22_0_-90.jpg": (3_781_092, "055006baa6dad51e27a4753c60868b9563d57440b68f9f98aeb1da95e1aff5ac"),
    "VIIRS_NOAA20_CorrectedReflectance_TrueColor_2025-09-22_0_0.jpg": (3_429_805, "e88f41ba56228b222d229c8e1259000c0c5fd0bf488e330755baffe1d01deb3e"),
    "VIIRS_NOAA20_CorrectedReflectance_TrueColor_2025-09-22_0_90.jpg": (3_529_513, "3cab7caaf8cbc68f00540a69a6222bef14a99f337951e079ceb8a038c3c8e771"),
    "VIIRS_NOAA20_CorrectedReflectance_TrueColor_2025-09-22_-90_-180.jpg": (3_413_467, "8af001c27e1acfa9f41440301106cf9f295effc3ccb44372dd34368b2660c1a9"),
    "VIIRS_NOAA20_CorrectedReflectance_TrueColor_2025-09-22_-90_-90.jpg": (3_127_683, "32e1070bd512bba0d30ed5b4946ff8f41c9b135686cb70bc8d57c3d9320333c0"),
    "VIIRS_NOAA20_CorrectedReflectance_TrueColor_2025-09-22_-90_0.jpg": (3_155_006, "a9cd65a38839398e4e2a87e5c9906a83b3dcedb2cef02cc792890803d5862db3"),
    "VIIRS_NOAA20_CorrectedReflectance_TrueColor_2025-09-22_-90_90.jpg": (3_054_059, "7ac4e901937cc3ff05fa77a496feead38df22b0c113b28848863ab6a499a34be"),
    "VIIRS_SNPP_CorrectedReflectance_TrueColor_2025-09-22_0_-180.jpg": (3_834_829, "3c606089cc7f0aeef508f612ce50e2540743f66ba1ab1b776cbb57d34ff4b5e0"),
    "VIIRS_SNPP_CorrectedReflectance_TrueColor_2025-09-22_0_-90.jpg": (3_702_350, "646f25aeb89d7f4868ab2efd91cede9b35b652db99940453cfb38d5974fdca22"),
    "VIIRS_SNPP_CorrectedReflectance_TrueColor_2025-09-22_0_0.jpg": (3_421_176, "9b81f7f3eb2fd261bbbc94399424d08344c997ea541575e8f23dce2241b7448b"),
    "VIIRS_SNPP_CorrectedReflectance_TrueColor_2025-09-22_0_90.jpg": (3_487_949, "a9765f43c9bd61c2bec3dc1d82ad2401ec591d1de9909e5c3f916b6af36f2816"),
    "VIIRS_SNPP_CorrectedReflectance_TrueColor_2025-09-22_-90_-180.jpg": (3_332_319, "74be36a670ae8f4cf415d33ad2c39e7db6c9fb2b0cbd6fb56f7cf0dde33b3676"),
    "VIIRS_SNPP_CorrectedReflectance_TrueColor_2025-09-22_-90_-90.jpg": (3_062_302, "24e5974ca3417f8213ee65e9daed5305df5f2b68eb7891a946f19527d888959c"),
    "VIIRS_SNPP_CorrectedReflectance_TrueColor_2025-09-22_-90_0.jpg": (3_082_000, "75d32ab3568b5c9648e30e1bce9990275df829227d8e62f0cae4e1cdb73c2cee"),
    "VIIRS_SNPP_CorrectedReflectance_TrueColor_2025-09-22_-90_90.jpg": (2_954_381, "22a3a7802582fd64eefd73742f6c0a7fac2e73318078757f6f49938fe207ee28"),
    "VIIRS_NOAA21_CorrectedReflectance_TrueColor_2025-09-22_0_-180.jpg": (3_855_323, "f990d5055eb3959a4b0639c8e6f77b777513a8fcad49e52357c31aca4cf41c4b"),
    "VIIRS_NOAA21_CorrectedReflectance_TrueColor_2025-09-22_0_-90.jpg": (3_778_315, "1449911591b9650173c9c7857c3df0873fffcc621b719445edc39aa7b6b39b3b"),
    "VIIRS_NOAA21_CorrectedReflectance_TrueColor_2025-09-22_0_0.jpg": (3_479_112, "427d4a07df0ebceb3655d95198a0e45c11b4b5bf1f1de609b78af4c8f269d39e"),
    "VIIRS_NOAA21_CorrectedReflectance_TrueColor_2025-09-22_0_90.jpg": (3_481_414, "e0d1e17acf74096228f01bc3ce38b2d71ba88041ea7d9b8da97d2262c759d962"),
    "VIIRS_NOAA21_CorrectedReflectance_TrueColor_2025-09-22_-90_-180.jpg": (3_378_625, "b6b9068a781871b214126a5773cad45812c50b6d62c66c71fa3093428738ae6d"),
    "VIIRS_NOAA21_CorrectedReflectance_TrueColor_2025-09-22_-90_-90.jpg": (3_164_078, "5d94124cf0f3f3d416ae31ec89f232c957a590ba11283114f0b4651d390b2d61"),
    "VIIRS_NOAA21_CorrectedReflectance_TrueColor_2025-09-22_-90_0.jpg": (3_098_400, "6b91e1b967aebe524a20de5d40f4764585d56c7f520722c0ae8bbc701bc09449"),
    "VIIRS_NOAA21_CorrectedReflectance_TrueColor_2025-09-22_-90_90.jpg": (2_981_669, "f8e088f3b2a6361ef8290cdced5886a17594023d5f8287d5beb94b1126e77d42"),
    "VIIRS_NOAA20_NDSI_Snow_Cover_2025-09-22.png": (407_641, "c28794448bc7004c359f801c2230171f8ec83ca9bfa065eed5a2611e7be44634"),
    "VIIRS_SNPP_NDSI_Snow_Cover_2025-09-22.png": (386_398, "1a4e615b91d0751eea75377650d9dcc05d538b9679ef4863ac1073cd8bde2926"),
}
CLOUDS_SERVED = "served 2026-10-28"


def _gibs_file(name: str, url: str) -> SourceFile:
    size, digest = CLOUDS_PINS[name]
    return SourceFile(CLOUDS_SOURCE, url, size, digest, CLOUDS_SERVED, file_name=name)


for _satellite in CLOUDS_SATELLITES:
    _layer = f"VIIRS_{_satellite}_CorrectedReflectance_TrueColor"
    for _lat0, _lon0 in CLOUDS_TILES:
        _box = (_lat0, _lon0, _lat0 + CLOUDS_TILE_DEG, _lon0 + CLOUDS_TILE_DEG)
        FILES[clouds_tile(_satellite, _lat0, _lon0)] = _gibs_file(
            f"{_layer}_{CLOUDS_DATE}_{_lat0}_{_lon0}.jpg", gibs_map(_layer, _box, (CLOUDS_TILE_PX, CLOUDS_TILE_PX), "image/jpeg"),
        )
# The VIIRS snow maps (NDSI snow cover, clear-sky snow only) of the two satellites that have one for the date.
for _satellite in ("NOAA20", "SNPP"):
    _layer = f"VIIRS_{_satellite}_NDSI_Snow_Cover"
    FILES[clouds_snow(_satellite)] = _gibs_file(
        f"{_layer}_{CLOUDS_DATE}.png", gibs_map(_layer, (-90, -180, 90, 180), CLOUDS_SNOW_SIZE, "image/png"),
    )

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
# GIBS's own acknowledgement (its API documentation, "Data Use Guidance and Acknowledgements").
GIBS_ACKNOWLEDGEMENT = (
    "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of "
    "NASA's Earth Science Data and Information System (ESDIS)."
)
ESDIS_TERMS = (
    "CC0 / public domain. NASA's Earth science data use guidance: ESDIS content (imagery, data, products) is generally "
    "not copyrighted, and data from NASA-led missions without a marked restriction are licensed as Creative Commons Zero "
    "(CC0); NOAA-20 and NOAA-21 are NOAA satellites (JPSS), whose data are U.S. Government works. NASA asks to be "
    "acknowledged as the source, and use must not imply NASA endorsement."
)
ESDIS_POLICY = "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance"

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
            "The base map has no sea ice: the ocean is open to the poles. The exploration Earth is a composite of several "
            "epochs (land July 2004, clouds and sea ice 22 September 2025, night lights 2016) and is captioned as such."
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
        id=CLOUDS_SOURCE,
        title="VIIRS Corrected Reflectance, true colour, 22 September 2025: Suomi NPP, NOAA-20 and NOAA-21 (NASA GIBS)",
        author=(
            "NASA Earth Science Data and Information System (ESDIS), Global Imagery Browse Services (GIBS); VIIRS on "
            "Suomi NPP (NASA and NOAA), NOAA-20 and NOAA-21 (NOAA JPSS)"
        ),
        url="https://nasa-gibs.github.io/gibs-api-docs/",
        version=(
            f"Daily mosaics of {CLOUDS_DATE} from the GIBS WMS (EPSG:4326, best available), true colour (bands I1, M4, M3) "
            "read at 16384 x 8192, NDSI snow cover at 4096 x 2048"
        ),
        license=ESDIS_TERMS,
        license_url=ESDIS_POLICY,
        credit="NASA GIBS (ESDIS): VIIRS on Suomi NPP, NOAA-20 and NOAA-21",
        notes=(
            "The cloud layer of the exploration Earth (public/assets/planets/earth/clouds-*.ktx2), with the sea ice of the "
            "same day, which the July 2004 day map lacks. Made by scripts/planets/build.py from GIBS's daily true-colour "
            "mosaics of the three satellites (layers VIIRS_NOAA20_, VIIRS_SNPP_ and VIIRS_NOAA21_CorrectedReflectance_"
            "TrueColor): whiteness is the darkest of a pixel's three bands as reflectance (cloud is white, bright ground "
            "coloured); the median of the three satellites, which cross the same sea minutes apart, drops the sunglint each "
            "has down the middle of its orbits; opacity is the share of the way from the ground's own whiteness (the day "
            "map's, or open sea's) to thick cloud's. None is drawn over the ice sheets the day map shows white, nor over the "
            "day's clear-sky snow on land (layers VIIRS_NOAA20_ and VIIRS_SNPP_NDSI_Snow_Cover), where visible light cannot "
            "tell cloud from snow. Poleward of the imagery (about 83 N and 75 S, where the equinox Sun was too low) open "
            "water is filled as opaque pack ice and cloud. Thin smoke and dust over dark ground count as faint cloud. "
            f"Acknowledgement GIBS asks for: \"{GIBS_ACKNOWLEDGEMENT}\""
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



# --- Tiers and encodings ----------------------------------------------------------------

# Equirectangular width per detail tier (height is half). All four are published (served with the site).
TIERS: dict[str, int] = {"low": 1024, "medium": 2048, "high": 4096, "ultra": 8192}
PUBLISHED_TIERS = ("low", "medium", "high", "ultra")
TOP_WIDTH = TIERS["ultra"]

# Transfer budgets (bytes) per published tier set, and for everything committed together.
# The tier budgets are the synthesis' Stage 7 ceilings; the total keeps the repository and the site
# (GitHub Pages, 1 GB) well within their limits with Ultra included.
TIER_BUDGET_BYTES = {"low": 8_000_000, "medium": 24_000_000, "high": 110_000_000, "ultra": 250_000_000}
COMMITTED_BUDGET_BYTES = 280_000_000

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
        "earth", "clouds", "grey", CLOUDS_SOURCE,
        description=(
            "Cloud cover of 22 September 2025 (VIIRS), with that day's sea ice, which the day map lacks; none over the ice "
            "sheets, where cloud cannot be told from ice in visible light."
        ),
        encoding=(
            "R8, cloud cover 0..1 (linear), seen from afar as opacity smoothstep(0.08, 0.9, cover) x 0.97, the curve "
            "src/explore/bodies/earth.ts reads it with."
        ),
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
        "caption": "A composite of several epochs: land July 2004, clouds and sea ice 22 September 2025, night lights 2016.",
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

# Five-planet extension: verified USGS downloads and original cloud-colour models.
FILES['mercuryColour'] = SourceFile(
    source_id='usgs-mdis-mercury',
    url='https://planetarymaps.usgs.gov/mosaic/Mercury_MESSENGER_ClrMosaic_global_665m_v3.tif',
    bytes=797507691,
    sha256='dfd0af2895bc91b028576359b2a0da6c86b5381619fd8e6d58d7d62876362032',
    last_modified='retrieved 2026-10-24',
    fallback=None,
)

FILES['mercuryHeight'] = SourceFile(
    source_id='usgs-dem-mercury',
    url='https://planetarymaps.usgs.gov/mosaic/Mercury_Messenger_USGS_DEM_Global_665m_v2.tif',
    bytes=530934581,
    sha256='defce776241dcaf44cb0f081ee508c17dbea28aa5a22880bf7a5e8c25f96cbea',
    last_modified='retrieved 2026-10-24',
    fallback=None,
)

FILES['marsColour'] = SourceFile(
    source_id='usgs-viking-mars',
    url='https://planetarymaps.usgs.gov/mosaic/Mars_Viking_ClrMosaic_global_925m.tif',
    bytes=797888177,
    sha256='5b3c6bea36cec0ec65b9ce5927db6b1c555c5fae60a227c774f9fcaecdf5bb33',
    last_modified='retrieved 2026-10-24',
    fallback=None,
)

FILES['marsHeight'] = SourceFile(
    source_id='usgs-mola-mars',
    url='https://planetarymaps.usgs.gov/mosaic/Mars_MGS_MOLA_DEM_mosaic_global_463m.tif',
    bytes=2125771142,
    sha256='38a4eb0b4452855b8dabfac40a367b458555ab4c01b31235807ad0a53c031f4c',
    last_modified='retrieved 2026-10-24',
    fallback=None,
)

SOURCES.extend([
    SourceEntry(
        id='usgs-viking-mars',
        title='Mars Viking Global Color Mosaic 925m',
        author='Viking Team, USGS Astrogeology',
        url='https://astrogeology.usgs.gov/search/map/mars_viking_global_color_mosaic_925m',
        version='accessed 2026-10-24',
        license='Public domain (U.S. Government data)',
        license_url='https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
        credit='NASA/USGS, Viking',
        notes='Viking visible colour mosaic; reduced in linear light; longitude and latitude retained.',
    ),
    SourceEntry(
        id='usgs-mola-mars',
        title='Mars MGS MOLA DEM 463m',
        author='MOLA Team, NASA GSFC, USGS Astrogeology',
        url='https://astrogeology.usgs.gov/search/map/mars_mgs_mola_dem_463m',
        version='accessed 2026-10-24',
        license='Public domain (U.S. Government data)',
        license_url='https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
        credit='NASA/GSFC/USGS, MOLA',
        notes=(
            'MOLA elevations reduced to 4096 pixels and converted to tangent-space relief normals; relief'
            ' exaggerated as recorded in the manifest.'
        ),
    ),
    SourceEntry(
        id='usgs-mdis-mercury',
        title='Mercury MESSENGER MDIS Global Color Mosaic 665m v3',
        author='MESSENGER Team, Arizona State University, USGS Astrogeology',
        url='https://astrogeology.usgs.gov/search/map/mercury_messenger_mdis_global_color_mosaic_665m',
        version='accessed 2026-10-24',
        license='Public domain (U.S. Government data)',
        license_url='https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
        credit='NASA/JHUAPL/CIW/USGS, MESSENGER MDIS',
        notes=(
            'Only the visible 430 nm band is used, its published linear I/F contrast stretch undone and '
            'displayed as neutral monochrome. Missing image patches are interpolated from adjacent '
            'observed pixels, not invented terrain. The 1000/750/430 nm RGB composite is not presented as'
            ' natural colour.'
        ),
    ),
    SourceEntry(
        id='usgs-dem-mercury',
        title='Mercury MESSENGER Global DEM 665m v2',
        author='USGS Astrogeology, MESSENGER Team',
        url='https://astrogeology.usgs.gov/search/map/mercury_messenger_global_dem_665m',
        version='accessed 2026-10-24',
        license='Public domain (U.S. Government data)',
        license_url='https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
        credit='NASA/JHUAPL/CIW/USGS, MESSENGER DEM',
        notes=(
            'Stereo DEM reduced to 4096 pixels and converted to tangent-space relief normals; relief '
            'exaggerated as recorded in the manifest.'
        ),
    ),
    SourceEntry(
        id='irwin-ice-giant-colours',
        title=(
            'Uniform cloud-colour model informed by Modelling the seasonal cycle of Uranus’s colour and '
            'magnitude, and comparison with Neptune'
        ),
        author='Kun Fayakun contributors (display model); P. G. J. Irwin et al.',
        url='https://doi.org/10.1093/mnras/stad3761',
        version='accessed 2026-10-24',
        license='CC0 (original uniform display model only; no source imagery reproduced)',
        license_url='https://creativecommons.org/publicdomain/zero/1.0/',
        credit='Colour model informed by Irwin et al. (2024)',
        notes=(
            'Uniform, illustrative display swatches of pale greenish-blue, Neptune slightly bluer. These '
            'are qualitative approximations, not measured RGB values, albedos, or mapped atmospheric '
            'features. No published figure is reproduced. The cited publication retains its own terms; '
            'CC0 applies only to the original uniform display map.'
        ),
    ),
    SourceEntry(
        id='nasa-venus-visible',
        title='Uniform cloud-colour model informed by Venus in visible light: a yellowish-white cloud deck',
        author='Kun Fayakun contributors (display model); NASA Science',
        url='https://science.nasa.gov/earth/10-things-tour-of-storms-across-the-solar-system/',
        version='accessed 2026-10-24',
        license='CC0 (original uniform display model only; no source imagery reproduced)',
        license_url='https://creativecommons.org/publicdomain/zero/1.0/',
        credit='Cloud colour model informed by NASA',
        notes=(
            'Uniform pale yellowish-white cloud-top display model. No radar surface or ultraviolet cloud '
            'structures are shown; RGB values are illustrative display choices, not measurements. The '
            'cited publication retains its own terms; CC0 applies only to the original uniform display '
            'map.'
        ),
    ),
])

MAPS.extend([
    MapSpec(
        body='mercury',
        map='colour',
        kind='colour',
        source_id='usgs-mdis-mercury',
        description='Mission imaging; Mercury is monochrome, Mars is Viking colour.',
        encoding='sRGB colour.',
    ),
    MapSpec(
        body='mercury',
        map='normal',
        kind='normal',
        source_id='usgs-dem-mercury',
        max_width=4096,
        description='Mission DEM relief, exaggerated for visibility.',
        encoding='UASTC normal mode: X in RGB, Y in A.',
    ),
    MapSpec(
        body='mars',
        map='colour',
        kind='colour',
        source_id='usgs-viking-mars',
        description='Mission imaging; Mercury is monochrome, Mars is Viking colour.',
        encoding='sRGB colour.',
    ),
    MapSpec(
        body='mars',
        map='normal',
        kind='normal',
        source_id='usgs-mola-mars',
        max_width=4096,
        description='Mission DEM relief, exaggerated for visibility.',
        encoding='UASTC normal mode: X in RGB, Y in A.',
    ),
    MapSpec(
        body='venus',
        map='colour',
        kind='colour',
        source_id='nasa-venus-visible',
        max_width=1024,
        description='Uniform illustrative cloud-top colour model; not a mission texture map.',
        encoding='sRGB colour.',
    ),
    MapSpec(
        body='uranus',
        map='colour',
        kind='colour',
        source_id='irwin-ice-giant-colours',
        max_width=1024,
        description='Uniform illustrative cloud-top colour model; not a mission texture map.',
        encoding='sRGB colour.',
    ),
    MapSpec(
        body='neptune',
        map='colour',
        kind='colour',
        source_id='irwin-ice-giant-colours',
        max_width=1024,
        description='Uniform illustrative cloud-top colour model; not a mission texture map.',
        encoding='sRGB colour.',
    ),
])

BODIES.update({'mercury': {'longitude': 'east longitude, -180 to 180 from the left edge',
             'latitude': 'planetocentric',
             'uAtLon0': 0.5,
             'lonIncreases': 'right',
             'caption': 'MDIS visible-band monochrome, published I/F stretch undone. Unobserved '
                        'imaging patches interpolated; not natural-colour photography.'},
 'venus': {'longitude': 'uniform display model, no mapped longitude features',
           'latitude': 'planetographic',
           'uAtLon0': 0.5,
           'lonIncreases': 'right',
           'caption': 'Illustrative uniform cloud-colour model informed by cited observations; no '
                      'mapped cloud structure or rings.'},
 'mars': {'longitude': 'east longitude, -180 to 180 from the left edge',
          'latitude': 'planetocentric',
          'uAtLon0': 0.5,
          'lonIncreases': 'right',
          'caption': 'Viking global colour mosaic with MOLA relief.'},
 'uranus': {'longitude': 'uniform display model, no mapped longitude features',
            'latitude': 'planetographic',
            'uAtLon0': 0.5,
            'lonIncreases': 'right',
            'caption': 'Illustrative uniform cloud-colour model informed by cited observations; no '
                       'mapped cloud structure or rings.'},
 'neptune': {'longitude': 'uniform display model, no mapped longitude features',
             'latitude': 'planetographic',
             'uAtLon0': 0.5,
             'lonIncreases': 'right',
             'caption': 'Illustrative uniform cloud-colour model informed by cited observations; '
                        'no mapped cloud structure or rings.'}})

RELIEF_EXAGGERATION.update({'mercury': 2.5, 'mars': 2.5})
# Slopes use the same cited radii the runtime reads; no second set of physical constants.
MEAN_RADIUS_KM.update({
    body['name'].lower(): body['meanRadiusKm']
    for body in json.loads((JPL_PUBLIC / 'planets.json').read_text())['bodies']
    if body['name'] in ('Mercury', 'Mars')
})
SOURCE_IDS = {source.id for source in SOURCES} | {'cassini-rss-rings'}
