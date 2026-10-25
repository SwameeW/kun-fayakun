"""USGS GeoTIFF maps for Mercury and Mars; uniform, labelled cloud-colour models.

Read each GeoTIFF's projection rather than assuming its edges lie exactly at +/-180 and +/-90.
The Mercury DEM is centred on 180 E, unlike its imaging: rotate its reduced grid to the common
-180..180 convention before deriving relief. All colour reductions are in linear light.
"""
from __future__ import annotations
import json
import numpy as np
import tifffile
from PIL import Image
import config
import resample as rs


def projected_grid(key: str, width: int, colour: bool, monochrome: bool = False) -> np.ndarray:
    with tifffile.TiffFile(config.FILES[key].path) as f:
        g = f.geotiff_metadata
        if not g or float(g.get('ProjCenterLatGeoKey', 0)) != 0:
            raise ValueError(f'{key}: expected an equatorial cylindrical GeoTIFF')
        a = f.asarray()
        if a.ndim == 3 and a.shape[0] == 3:
            a = np.moveaxis(a, 0, -1)
        sx, sy, _ = g['ModelPixelScale']
        _, _, _, x0, y0, _ = g['ModelTiepoint']
        radius = float(g['GeogSemiMajorAxisGeoKey'])
        centre = float(g.get('ProjCenterLongGeoKey', 0))
        if centre not in (0, 180):
            raise ValueError(f'{key}: unsupported central longitude {centre}')
        box = ((-np.pi * radius - x0) / sx, (y0 - np.pi * radius / 2) / sy,
               (np.pi * radius - x0) / sx, (y0 + np.pi * radius / 2) / sy)
        # USGS rounds some mosaic extents by up to half a source pixel; clamp only that fringe.
        if min(box[:2]) < -1 or box[2] > a.shape[1] + 1 or box[3] > a.shape[0] + 1:
            raise ValueError(f'{key}: global coverage missing: {box}, {a.shape}')
        box = (max(0,box[0]),max(0,box[1]),min(a.shape[1],box[2]),min(a.shape[0],box[3]))
        channels = [2, 2, 2] if monochrome else list(range(3)) if colour else [None]
        out = []
        for ch in dict.fromkeys(channels):
            plane = a if ch is None else a[..., ch]
            if monochrome:
                constants = {c['id']:c['value'] for c in json.loads((config.ROOT / 'data/constants.json').read_text())['constants']}
                lo, hi = (constants[f'mercury.mdis430.stretch.{end}'] for end in ('lower','upper'))
                # This product is a linear stretch of I/F, not sRGB photography. Undo its
                # published 430 nm stretch; copy this visible-band intensity into neutral RGB.
                values = lo + (plane.astype(np.float32) / 255) * (hi - lo)
                gaps = plane == 0
                for row in range(values.shape[0]):
                    bad = gaps[row]
                    good = np.flatnonzero(~bad)
                    if bad.any() and good.size:
                        x = np.flatnonzero(bad)
                        values[row,bad] = np.interp(x, np.r_[good[-1]-values.shape[1],good,good[0]+values.shape[1]], np.r_[values[row,good[-1]],values[row,good],values[row,good[0]]])
                missing_rows = np.flatnonzero(gaps.all(axis=1))
                valid_rows = np.flatnonzero(~gaps.all(axis=1))
                for row in missing_rows:
                    values[row] = values[valid_rows[np.argmin(np.abs(valid_rows-row))]]
            else:
                values = rs.srgb_to_linear(plane) if colour else plane.astype(np.float32)
            if not colour:
                if (values == -32768).any():
                    raise ValueError(f'{key}: unresolved DEM nodata')
            reduced = np.asarray(Image.fromarray(values).resize((width, width // 2), Image.Resampling.LANCZOS, box=box)).copy()
            if monochrome:
                reduced = np.clip(reduced, lo, hi)
            out.append(reduced)
            del values
        if colour:
            out = [out[0]] * 3 if monochrome else out
            result = np.stack(out, axis=-1)
        else:
            result = out[0]
        return np.roll(result, width // 2, axis=1) if centre == 180 else result


def build_rock(body: str) -> dict:
    # Imported here: build imports this module only when calling one of these builders.
    import build
    import landmarks
    colour = projected_grid(body + 'Colour', 8192, True, monochrome=body == 'mercury')
    marks = landmarks.rock_colour(rs.linear_to_srgb(colour), body, f'{body} imaging source')
    if body == 'mercury':
        constants = {c['id']:c['value'] for c in json.loads((config.ROOT / 'data/constants.json').read_text())['constants']}
        lo, hi = (constants[f'mercury.mdis430.stretch.{end}'] for end in ('lower','upper'))
        # Lanczos lobes must not invent negative I/F or black rings around bright ejecta.
        levels = [rs.linear_to_srgb(np.clip(level, lo, hi)) for level in rs.chain(colour)]
    else:
        levels = build.colour_levels(colour)
    build.write_levels(body, 'colour', levels)
    del colour
    height = projected_grid(body + 'Height', 4096, False)
    heights = landmarks.rock_heights(height, body, f'{body} DEM source')
    levels = build.normal_levels(height, body)
    normal_marks = landmarks.rock_normals(levels[0][..., :2], body, f'{body} normal source')
    build.write_levels(body, 'normal', levels)
    return {'body':body,'maps':{'colour':{'landmarks':marks},'normal':{'landmarks':normal_marks,'heights':heights}}}


def build_cloud(body: str) -> dict:
    import build
    constants = json.loads((config.ROOT / 'data/constants.json').read_text())['constants']
    values = {c['id']:c['value'] for c in constants}
    rgb = [values[f'{body}.displayColour.{ch}'] for ch in 'rgb']
    colour = np.empty((512,1024,3),dtype=np.uint8)
    colour[:] = rgb
    build.write_levels(body, 'colour', build.colour_levels(rs.srgb_to_linear(colour)))
    return {'body':body,'maps':{'colour':{'displayRgb':rgb,'illustrative':True}}}
