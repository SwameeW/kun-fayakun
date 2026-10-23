"""Review images: each published texture decoded back from its KTX2 file and drawn on a lit globe.

This is a reference renderer in numpy for people checking the pipeline, not the app's renderer:
orthographic globes lit by a distant Sun, normal maps applied in the tangent frame planets.json
documents (x east, y north), the Earth with clouds, city lights on its night side and sunglint
on water, Saturn with its ring strip and the globe's shadow on it. Everything is read from the
encoded files (via `ktx extract`), so the images show what ships; rows are turned back
north-up and longitudes follow config.BODIES, as a runtime has to.

Output: .cache/planets/preview/<tier>/<body>-<view>.png
Usage: python scripts/planets/preview.py [low|medium|high|ultra ...]
"""

from __future__ import annotations

import argparse
import json

import numpy as np
from numpy.typing import NDArray
from PIL import Image

import config
import encode
import resample as rs

F = NDArray[np.float64]
SIZE = 900
SATURN_RADIUS_KM = 60_268.0


def load(rel: str) -> NDArray[np.uint8]:
    """A KTX2 file's level 0, decoded to 8 bits and turned north-up."""
    path = config.ROOT / rel
    codec = "uastc" if "-uastc" in path.name else "etc1s" if "-etc1s" in path.name else "raw"
    return np.ascontiguousarray(np.flipud(encode.decode(path, codec)))


def bilinear(tex: F, u: F, v: F) -> F:
    """Samples a north-up equirectangular texture at (u, v), v = 0 south; wraps u, clamps v."""
    h, w = tex.shape[:2]
    x = u * w - 0.5
    y = (1.0 - v) * h - 0.5
    x0 = np.floor(x).astype(int)
    y0 = np.clip(np.floor(y).astype(int), 0, h - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fx, fy = (x - x0)[..., None], np.clip(y - np.floor(y), 0, 1)[..., None]
    x0 %= w
    x1 = (x0 + 1) % w
    t = tex if tex.ndim == 3 else tex[..., None]
    top = t[y0, x0] * (1 - fx) + t[y0, x1] * fx
    bottom = t[y1, x0] * (1 - fx) + t[y1, x1] * fx
    return top * (1 - fy) + bottom * fy


def to_srgb(linear: F) -> NDArray[np.uint8]:
    # A gentle shoulder instead of a hard clip, so sunlit ice and cloud keep their texture.
    return rs.linear_to_srgb((linear / (1.0 + 0.12 * linear)).astype(np.float32))


def direction(lon: float, lat: float) -> F:
    lo, la = np.radians(lon), np.radians(lat)
    return np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])


class View:
    """Orthographic camera looking at the body from (lon, lat), north up, `extent` radii across half the image."""

    def __init__(self, view_lon: float, view_lat: float, extent: float) -> None:
        s = ((np.arange(SIZE) + 0.5) / SIZE * 2.0 - 1.0) * extent
        self.sx, self.sy = np.meshgrid(s, -s)
        self.fwd = direction(view_lon, view_lat)
        self.east = np.array([-np.sin(np.radians(view_lon)), np.cos(np.radians(view_lon)), 0.0])
        self.north = np.cross(self.fwd, self.east)
        r2 = self.sx**2 + self.sy**2
        self.disc = r2 <= 1.0
        self.depth = np.sqrt(np.clip(1.0 - r2, 0.0, 1.0))
        self.p = self.sx[..., None] * self.east + self.sy[..., None] * self.north + self.depth[..., None] * self.fwd

    def uv(self, body: str) -> tuple[F, F]:
        lon = np.degrees(np.arctan2(self.p[..., 1], self.p[..., 0]))
        lat = np.degrees(np.arcsin(np.clip(self.p[..., 2], -1, 1)))
        conv = config.BODIES[body]
        sign = 1.0 if conv["lonIncreases"] == "right" else -1.0
        return (float(conv["uAtLon0"]) + sign * lon / 360.0) % 1.0, 0.5 + lat / 180.0


def tangent_normals(p: F, xy: F) -> F:
    """World normals from tangent-space X (east) and Y (north) stored as 8-bit codes."""
    nx, ny = xy[..., 0] / 255.0 * 2 - 1, xy[..., 1] / 255.0 * 2 - 1
    nz = np.sqrt(np.clip(1 - nx**2 - ny**2, 0, 1))
    east = np.cross(np.array([0.0, 0.0, 1.0]), p)
    east /= np.maximum(np.linalg.norm(east, axis=-1, keepdims=True), 1e-9)
    north = np.cross(p, east)
    n = nx[..., None] * east + ny[..., None] * north + nz[..., None] * p
    return n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-9)


def render(body: str, files: dict[str, str], look: tuple[float, float], sun_dir: tuple[float, float]) -> NDArray[np.uint8]:
    extent = 2.45 if body == "saturn" else 1.04
    cam = View(*look, extent)
    sun = direction(*sun_dir)
    u, v = cam.uv(body)
    p = cam.p
    cos_sun = (p * sun).sum(-1)
    geo = np.clip(cos_sun, 0, 1)
    if "normal" in files:
        xy = bilinear(load(files["normal"]).astype(np.float64), u, v)[..., :2]
        n = tangent_normals(p, xy)
        # The terminator stays the sphere's; relief only modulates light where the Sun is up.
        light = np.clip((n * sun).sum(-1), 0, 1) * np.clip(cos_sun * 8.0, 0, 1)
    else:
        light = geo
    albedo = bilinear(rs.srgb_to_linear(load(files["day" if body == "earth" else "colour"])).astype(np.float64), u, v)
    out = albedo * light[..., None]
    if body == "earth":
        water = bilinear(load(files["water"]).astype(np.float64) / 255.0, u, v)[..., 0]
        clouds = bilinear(load(files["clouds"]).astype(np.float64) / 255.0, u, v)[..., 0]
        lights = bilinear(rs.srgb_to_linear(load(files["night"])).astype(np.float64), u, v)[..., 0]
        half = sun + cam.fwd
        half /= np.linalg.norm(half)
        glint = water * np.clip((p * half).sum(-1), 0, 1) ** 220 * 3.0 * geo
        out = out + glint[..., None] * np.array([1.0, 0.95, 0.85])
        night_side = 1.0 - np.clip(cos_sun * 10.0 + 0.5, 0, 1)
        out += (lights * night_side * (1.0 - 0.85 * clouds))[..., None] * np.array([1.0, 0.72, 0.42]) * 1.2
        out = out * (1 - clouds[..., None]) + (geo * 0.92)[..., None] * clouds[..., None]
        rim = (1.0 - np.clip((p * cam.fwd).sum(-1), 0, 1)) ** 4
        out += (rim * np.clip(cos_sun + 0.25, 0, 1))[..., None] * np.array([0.12, 0.25, 0.6])
    out[~cam.disc] = 0.0
    if body == "saturn" and "rings" in files:
        out = add_rings(out, files["rings"], cam, sun)
    return to_srgb(out)


def add_rings(globe: F, rings_rel: str, cam: View, sun: F) -> F:
    """The ring strip in the equatorial plane, in front of or hidden by the globe, with the globe's shadow."""
    strip = load(rings_rel)[0].astype(np.float64)  # (W, 4): sRGB colour and opacity
    colour = rs.srgb_to_linear(strip[:, :3].astype(np.uint8)).astype(np.float64)
    alpha = strip[:, 3] / 255.0
    origin = cam.sx[..., None] * cam.east + cam.sy[..., None] * cam.north + 10.0 * cam.fwd
    t = origin[..., 2] / cam.fwd[2]
    hit = origin - t[..., None] * cam.fwd
    s = (np.hypot(hit[..., 0], hit[..., 1]) * SATURN_RADIUS_KM - config.RINGS_INNER_KM) / (config.RINGS_OUTER_KM - config.RINGS_INNER_KM)
    inside = (s >= 0) & (s < 1)
    idx = np.clip((s * strip.shape[0]).astype(int), 0, strip.shape[0] - 1)
    mu = max(abs(cam.fwd[2]), 0.02)
    a = np.where(inside, 1.0 - (1.0 - alpha[idx]) ** (1.0 / mu), 0.0)
    b = (hit * sun).sum(-1)
    c = (hit * hit).sum(-1) - 1.0
    shadow = (b < 0) & (b * b > c)
    lit_side = np.sign(sun[2]) == np.sign(cam.fwd[2])
    rgb = colour[idx] * np.where(shadow, 0.03, 1.0 if lit_side else 0.35)[..., None]
    in_front = ~cam.disc | ((hit * cam.fwd).sum(-1) > cam.depth)
    mix = np.where(in_front, a, 0.0)[..., None]
    return globe * (1 - mix) + rgb * mix


VIEWS = {
    "earth": [("africa", (15.0, 12.0), (55.0, 15.0)), ("asia-dusk", (95.0, 25.0), (20.0, 15.0)), ("americas-night", (-75.0, 15.0), (-170.0, 10.0))],
    "moon": [("nearside", (0.0, 0.0), (-55.0, 1.5)), ("tycho", (-11.0, -35.0), (-75.0, -5.0)), ("farside", (180.0, 0.0), (125.0, 0.0))],
    "jupiter": [("red-spot", (40.0, -8.0), (70.0, 0.0)), ("far", (220.0, 8.0), (250.0, 0.0))],
    "saturn": [("rings", (0.0, 24.0), (45.0, 12.0))],
}


def files_for(tier: str) -> dict[str, dict[str, str]]:
    report = json.loads((config.REPORTS / "encode.json").read_text())
    out: dict[str, dict[str, str]] = {}
    for key, tiers in report["tiers"].items():
        body, name = key.split("/")
        out.setdefault(body, {})[name] = tiers[tier]
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("tiers", nargs="*")
    tiers = parser.parse_args().tiers or ["high"]
    for tier in tiers:
        files = files_for(tier)
        folder = config.PREVIEW / tier
        folder.mkdir(parents=True, exist_ok=True)
        for body, views in VIEWS.items():
            if body not in files:
                continue
            for name, look, sun in views:
                path = folder / f"{body}-{name}.png"
                Image.fromarray(render(body, files[body], look, sun)).save(path)
                print(f"wrote {path.relative_to(config.ROOT)}")


if __name__ == "__main__":
    main()
