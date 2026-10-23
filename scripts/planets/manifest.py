"""Writes public/assets/planets/planets.json and the planet entries of data/sources.json.

planets.json lists every published texture once per tier it serves (Low, Medium, High), with
everything a runtime needs to load and place it and everything the validator checks: path, size,
mip levels, codec, colour space, bytes, sha256, source id and credit, the longitude and latitude
conventions and the row order. Ultra files are described in .cache/planets/ultra/planets-ultra.json
with the same schema; planets.json only records the Ultra set's size, because Ultra is not
published (an owner decision on hosting is pending).

Usage: python scripts/planets/manifest.py [--sources]
  --sources also rewrites the planet entries of data/sources.json (the Cassini RSS entry belongs to
  the JPL builder, scripts/jpl/build.py, and is left alone).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import config
import fetch

PROJECTION = {
    "projection": "equirectangular (plate carree), 2:1, pixel-is-area: texel (i, k) covers longitudes [i, i + 1] * 360 / W and latitudes from the south pole up",
    "u": "u = (uAtLon0 + lon / 360) mod 1 for lonIncreases 'right' (east longitude lon in degrees); u = 0 and u = 1 are the same meridian",
    "v": "v = 0.5 + lat / 180: v = 0 is the south pole, v = 1 the north pole (lat in the body's latitude convention)",
    "rowOrder": (
        "bottom-up: the first stored row of every mip level is the southernmost. The files carry KTXorientation 'ru' to say so. "
        "three's KTX2Loader never flips KTX2 (flipY stays false), so uv.y = 0 samples the first stored row: use the textures as loaded"
    ),
    "sampler": (
        "wrapS = RepeatWrapping, wrapT = ClampToEdgeWrapping, minFilter = LinearMipmapLinearFilter, magFilter = LinearFilter. "
        "Raw R8 and RGBA8 files load as DataTexture with nearest filtering and no wrap: set these explicitly. Sample with "
        "seam-safe gradients (as src/chapters/ch02/cmb-sphere.ts does) so the u = 0/1 seam picks the right mip level"
    ),
    "mipChain": "every level to 1 x 1, made by scripts/planets: Lanczos-2 in linear light, wrapping in longitude and clamped at the poles (box filter for the water mask and the ring strip)",
}

NORMAL_CHANNELS = {
    "x": "east slope component, in r (and g, b): UASTC normal mode stores X in RGB and Y in alpha",
    "y": "north slope component, in a",
    "z": "z = sqrt(1 - x^2 - y^2), outward",
    "decode": "n.xy = texel.ga * 2 - 1 (or .ra); tangent frame at the surface point: x toward local east (increasing u), y toward local north (increasing v), z outward",
}


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Missing {path}; run the earlier steps of scripts/preprocess-planets.sh first")
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data


def credit_of(source_id: str) -> str:
    if source_id == "cassini-rss-rings":
        sources = read_json(config.SOURCES_JSON)["sources"]
        entry = next((s for s in sources if s["id"] == source_id), None)
        if entry is None:
            raise SystemExit("data/sources.json has no cassini-rss-rings entry: run npm run preprocess:jpl")
        return str(entry["credit"])
    return next(s.credit for s in config.SOURCES if s.id == source_id)


def channels(spec: config.MapSpec) -> dict[str, str]:
    if spec.kind == "normal":
        return NORMAL_CHANNELS
    if spec.kind == "colour":
        return {"rgb": spec.encoding}
    if spec.kind == "grey":
        return {"r": spec.encoding}
    return spec.channels


PUBLIC_PREFIX = f"public/{config.SITE_PREFIX}/"


def manifest_path(rel: str, published: bool) -> str:
    """Where a manifest points for a file encode.json lists by its repository path.

    planets.json gives site paths (assets/planets/...), which assets.url resolves at runtime, and
    may only list published files. planets-ultra.json gives repository paths, so the High files
    Ultra reuses keep their public/ path and only the files built into .cache/planets/ultra point
    there. Either way the file must exist.
    """
    if not (config.ROOT / rel).is_file():
        raise SystemExit(f"{rel} is listed in {config.REPORTS.name}/encode.json but missing: run encode.py again")
    if not published:
        return rel
    if not rel.startswith(PUBLIC_PREFIX):
        raise SystemExit(f"{rel} is not under {PUBLIC_PREFIX}, so planets.json cannot list it")
    return f"{config.SITE_PREFIX}/{rel.removeprefix(PUBLIC_PREFIX)}"


def file_entry(spec: config.MapSpec, tier: str, path: str, info: dict[str, Any]) -> dict[str, Any]:
    body = config.BODIES[spec.body]
    entry: dict[str, Any] = {
        "body": spec.body,
        "map": spec.map,
        "tier": tier,
        "path": path,
        "width": info["width"],
        "height": info["height"],
        "levels": info["levels"],
        "codec": info["codec"],
        "colorSpace": "srgb" if spec.kind in ("colour", "strip") else "linear",
        "bytes": info["bytes"],
        "sha256": info["sha256"],
        "sourceId": spec.source_id,
        "credit": credit_of(spec.source_id),
        "uAtLon0": body["uAtLon0"],
        "lonIncreases": body["lonIncreases"],
        "latitude": body["latitude"],
        "rowsBottomUp": True,
    }
    if spec.extra_sources:
        entry["alsoFrom"] = [{"sourceId": s, "credit": credit_of(s)} for s in spec.extra_sources]
    if spec.kind == "normal":
        entry["reliefExaggeration"] = config.RELIEF_EXAGGERATION[spec.body]
    if spec.kind == "strip":
        entry["radiusKm"] = [config.RINGS_INNER_KM, config.RINGS_OUTER_KM]
        entry.update({"uAtLon0": None, "lonIncreases": None, "latitude": None})
    entry["quality"] = info["quality"]
    return entry


def facts() -> dict[str, Any]:
    out: dict[str, Any] = {}
    jupiter = read_json(config.REPORTS / "build-jupiter.json")["maps"]["colour"]
    out["jupiter"] = {"greatRedSpot": jupiter["greatRedSpot"], "filledRows": jupiter["filledRows"]}
    saturn = read_json(config.REPORTS / "build-saturn.json")["maps"]["colour"]
    out["saturn"] = {"filledRows": saturn["filledRows"]}
    rings = read_json(config.REPORTS / "build-rings.json")["maps"]["rings"]
    out["saturnRings"] = {
        "radiusKm": rings["radiusKm"],
        "texelKm": round((config.RINGS_OUTER_KM - config.RINGS_INNER_KM) / 8192, 4),
        "u": "u = (r - radiusKm[0]) / (radiusKm[1] - radiusKm[0]); texel i covers that span's i-th 1/8192",
        "saturatedFraction": rings["saturatedFraction"],
        "colourRegistration": rings["colourRegistration"],
        "colourModel": rings["colourModel"],
        "opacityNoise": rings["opacityNoise"],
        "observation": {
            "opacity": "Cassini RSS X-band occultation, Rev 7 egress, 2005-05-03, ring opening -23.57 degrees",
            "colour": "Cassini ISS PIA11142, 2008-11-26, lit face from 10 degrees below, 28 degrees phase",
        },
    }
    earth = read_json(config.REPORTS / "build-earth.json")["maps"]
    out["earth"] = {"nightLandFloorCode": earth["night"]["landFloorCode"], "reliefExaggeration": config.RELIEF_EXAGGERATION["earth"]}
    return out


def build_manifest(tiers: tuple[str, ...], published: bool) -> dict[str, Any]:
    report = read_json(config.REPORTS / "encode.json")
    files = report["files"]
    entries = []
    for spec in config.MAPS:
        key = f"{spec.body}/{spec.map}"
        for tier in tiers:
            rel = report["tiers"][key][tier]
            entries.append(file_entry(spec, tier, manifest_path(rel, published), files[rel]))
    bodies: dict[str, Any] = {}
    for name, conv in config.BODIES.items():
        maps = {
            spec.map: {
                "kind": spec.kind,
                "description": spec.description,
                "channels": channels(spec),
                **({"alpha": spec.alpha} if spec.alpha else {}),
                "sourceId": spec.source_id,
            }
            for spec in config.MAPS
            if spec.body == name
        }
        bodies[name] = {**conv, "maps": maps}
    budgets = report["budgets"]
    tier_info: dict[str, Any] = {}
    for tier, width in config.TIERS.items():
        tier_info[tier] = {
            "width": width,
            "bytes": budgets["tierBytes"][tier],
            "budgetBytes": config.TIER_BUDGET_BYTES[tier],
            "published": tier in config.PUBLISHED_TIERS,
        }
    tier_info["ultra"]["note"] = (
        "Built into .cache/planets/ultra by scripts/preprocess-planets.sh and described by planets-ultra.json there; "
        "not published until the owner decides where to host it. Maps whose source is narrower than 8192 reuse their High file."
    )
    return {
        "$comment": "Generated by scripts/preprocess-planets.sh (scripts/planets). Do not edit by hand.",
        "schema": 1,
        "uv": PROJECTION,
        "tiers": tier_info,
        "committedBytes": budgets["committedBytes"],
        "bodies": bodies,
        "files": entries,
        "facts": facts(),
        "tool": report["tool"],
    }


def write(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(config.ROOT)}")


def update_sources() -> None:
    sources = read_json(config.SOURCES_JSON)
    entries = []
    for s in config.SOURCES:
        entries.append({
            "id": s.id,
            "kind": "dataset",
            "title": s.title,
            "author": s.author,
            "url": s.url,
            "version": f"{s.version}, retrieved {fetch.retrieved(s.id)}",
            "license": s.license,
            "licenseUrl": s.license_url,
            "credit": s.credit,
            "notes": s.notes,
            "review": {"reviewer": None, "role": None, "date": None},
        })
    ids = {e["id"] for e in entries}
    rest = [s for s in sources["sources"] if s["id"] not in ids]
    sources["sources"] = rest + entries
    config.SOURCES_JSON.write_text(json.dumps(sources, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"updated {config.SOURCES_JSON.relative_to(config.ROOT)}: {', '.join(sorted(ids))}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sources", action="store_true", help="also update data/sources.json")
    args = parser.parse_args()
    if args.sources:
        update_sources()
    write(config.MANIFEST, build_manifest(config.PUBLISHED_TIERS, published=True))
    ultra = build_manifest(("ultra",), published=False)
    ultra["$comment"] = (
        "Ultra (8192) set, built locally and not published. Paths are relative to the repository root: files built for "
        "Ultra are in .cache/planets/ultra, and maps whose source is narrower than 8192 reuse their published High file "
        "in public/assets/planets."
    )
    write(config.ULTRA_MANIFEST, ultra)


if __name__ == "__main__":
    main()
