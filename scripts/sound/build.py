"""Rebuilds the film's recorded sounds (public/assets/sound/*.m4a) from their originals.

Usage: npm run preprocess:sound (scripts/sound/build.sh makes the Python environment, then runs this).

Every recording here is in the public domain or CC0, from a page that says so (data/sources.json, the
"sound-" entries; LICENSES section 18). Anything whose licence was in doubt was left out (the
Glacier Bay hydrophone clips, the NPS Yellowstone sound library, Freesound files behind an account,
anything CC BY or CC BY-NC). The originals are never committed: the first run downloads them into
.cache/sound-originals (or $KF_SOUND_ORIGINALS) and checks each against the sha256 below. The
Sounds of Yellowstone files are 8 hours long, so only a 16 MB byte range of each is fetched (about
1 h 44 min in); the two USGS videos are fetched whole and their sound taken out with afconvert.

Each sound is a window of its original: made mono where stereo adds nothing (the film widens a mono
loop by playing two copies of it apart), high-passed under the wind on the microphone, notched at a
mains hum, resampled to 32 kHz, crossfaded into a seamless loop (equal power) or faded as a one-shot,
set to a common loudness (-20 LUFS, peaks under -1 dBFS, so the film's levels stay in
src/core/film-score.ts) and encoded to AAC (.m4a, which every browser decodes) with macOS afconvert.
A loop is written with a quarter second of itself on each side (its end before it, its start after
it), so it loops without a seam from 0.25 s for its length whatever a decoder does with the AAC
encoder's priming samples. RECORDINGS in src/core/film-score.ts holds the same lengths, and
tests/film-sound.spec.ts checks every file against it.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public' / 'assets' / 'sound'
ORIGINALS = Path(os.environ.get('KF_SOUND_ORIGINALS', ROOT / '.cache' / 'sound-originals'))
RATE = 32_000
PAD_S = 0.25
TARGET_LUFS = -20.0
PEAK_CAP_DB = -1.0
USER_AGENT = 'KunFayakun-sound-build/1.0 (educational, non-commercial; python urllib)'


@dataclass(frozen=True)
class Original:
    """A downloaded original: where it comes from and the sha256 of exactly the bytes used."""
    url: str
    page: str
    sha256: str
    size: int
    # An inclusive HTTP byte range, for the 8-hour Sounds of Yellowstone files.
    byte_range: tuple[int, int] | None = None


YELLOWSTONE = 'https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/audio/'
EXCERPT = (200_000_000, 215_999_999)

ORIGINAL: dict[str, Original] = {
    'usgs-hvo-lavalake-2011.mp3': Original(
        url='https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/atoms/audio/2011Feb14_Hmm%20vent%20sounds.mp3',
        page='https://www.usgs.gov/media/audio/lava-lake-activity-inside-halemaumau-crater',
        sha256='23c3d75ff56f22d8a7bffd6960712453fd65aa391c656322e8112f075e23b382',
        size=431_216,
    ),
    'usgs-overlook-vent-crackling-2012.mp4': Original(
        url='https://usgs-ocapsv2-public-input-media.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/atoms/video/multimediaFile-409.mp4',
        page='https://www.usgs.gov/media/videos/videos-lava-lake-halemaumau-overlook-vent',
        sha256='8b8d04f43827f27d8b57a2dae3d40eccdb9eb5f62d4c88033f7b4b71d875bc1d',
        size=3_660_332,
    ),
    'usgs-mud-pool-artists-paintpots-ep9-excerpt.mp3': Original(
        url=YELLOWSTONE + 'Mud%20Pool.mp3',
        page='https://www.usgs.gov/media/audio/mudpot-artists-paintpots-sounds-yellowstone-asmr-sleep-concentration',
        sha256='de8437b88a8c1805d6ede600a66c35473330926e18836565b397404d677df823',
        size=16_000_000,
        byte_range=EXCERPT,
    ),
    'usgs-congress-pool-ep5-excerpt.mp3': Original(
        url=YELLOWSTONE + 'Congress%20Pool.mp3',
        page='https://www.usgs.gov/media/audio/congress-pool-sounds-yellowstone-asmr-sleep-concentration',
        sha256='83bbeb4901fbdb671a8e93a0421197fc23166e15e6e4d0c0a0f66bd902641965',
        size=16_000_000,
        byte_range=EXCERPT,
    ),
    'usgs-blue-mud-steam-vent-ep2-excerpt.mp3': Original(
        url=YELLOWSTONE + 'Blue%20Mud%20Steam%20Vent.mp3',
        page='https://www.usgs.gov/media/audio/blue-mud-steam-vent-sounds-yellowstone-asmr-sleep-concentration',
        sha256='17696b27a52def48bdf78d0ee58f78385e1228064652c93cf06553f1f2e944f7',
        size=16_000_000,
        byte_range=EXCERPT,
    ),
    'usgs-terrace-springs-co2-bubbles-excerpt.mp3': Original(
        url=YELLOWSTONE + 'Terrace%20Springs.mp3',
        page='https://www.usgs.gov/media/audio/terrace-springs-sounds-yellowstone-asmr-sleep-concentration',
        sha256='15de1472e0436e56e9ba84faf5c83345258f51d4e40f3a903258c96037f263dc',
        size=16_000_000,
        byte_range=EXCERPT,
    ),
    'commons-light-rain-distant-thunder-2016.wav': Original(
        url='https://upload.wikimedia.org/wikipedia/commons/b/b6/Light_Rain_Distant_Thunder_July_5th_2016.wav',
        page='https://commons.wikimedia.org/wiki/File:Light_Rain_Distant_Thunder_July_5th_2016.wav',
        sha256='aa85a4aa26b261b8d8d9da52df3cb1c7f09aa86f5253e835ff5e15513e2451cb',
        size=42_295_240,
    ),
    'commons-beach-sounds-south-carolina.ogg': Original(
        url='https://upload.wikimedia.org/wikipedia/commons/0/04/Beach_sounds_South_Carolina.ogg',
        page='https://commons.wikimedia.org/wiki/File:Beach_sounds_South_Carolina.ogg',
        sha256='d81d1a4eafd0fd20e7fe697ece52aacb500f4baa1042080c5b2fd4cf634759d7',
        size=1_053_334,
    ),
    'nps-thunder-nsnsd.mp3': Original(
        url='https://www.nps.gov/nps-audiovideo/legacy/mp3/nri/avElement/nri-Thunder.mp3',
        page='https://www.nps.gov/subjects/sound/sounds-thunder.htm',
        sha256='54d6a7fc85b5c7b0c65dd36ff3c5f398d698c37e733bfc98a234a6724c2d0a49',
        size=739_018,
    ),
    'usgs-bolide-infrasound-2025.mp4': Original(
        url='https://usgs-ocapsv2-public-input-media.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/video/WY_YNB_01_HDF_10x_2.mp4',
        page='https://www.usgs.gov/media/videos/may-3-2025-bolide-acoustic-signal-recorded-infrasound-station-yellowstone-national',
        sha256='fcd1c31e32a4bc47797cea459539b3f525907746ace2d0f6f9967d6663658b77',
        size=287_375,
    ),
}


@dataclass(frozen=True)
class Sound:
    """One file the film plays: which original, which seconds of it, and what is done to them."""
    name: str
    original: str
    window: tuple[float, float]
    # Seconds of seamless loop (the window less the crossfade), or None for a one-shot.
    loop: float | None
    mono: bool = True
    highpass: float | None = None
    lowpass: float | None = None
    notch: tuple[float, ...] = ()
    fade_in: float = 0.0
    fade_out: float = 0.0


SOUNDS: tuple[Sound, ...] = (
    # Kilauea's lava lake (USGS HVO): churning lava releasing gas, the pops of rocks falling in; the
    # big rockfall at 19.2 s is left out.
    Sound('lava', 'usgs-hvo-lavalake-2011.mp3', (0.5, 18.5), 16.0, highpass=70),
    # The overlook vent's walls cracking in the heat; the windy first 8 s left out. Played as grains.
    Sound('crackle', 'usgs-overlook-vent-crackling-2012.mp4', (8.1, 21.1), None, highpass=200, fade_in=0.02, fade_out=0.05),
    # A mudpot's plops (Artists' Paintpots), clear of the wind bumps on the microphone.
    Sound('mud', 'usgs-mud-pool-artists-paintpots-ep9-excerpt.mp3', (348.0, 380.0), 30.0, highpass=80),
    # Congress Pool's roiling, its steadiest stretch; slowed in the film into a star's convection.
    Sound('roil', 'usgs-congress-pool-ep5-excerpt.mp3', (376.0, 408.0), 30.0, highpass=40, lowpass=5000),
    # Blue Mud Steam Vent's steady hiss and soft puffs.
    Sound('steam', 'usgs-blue-mud-steam-vent-ep2-excerpt.mp3', (125.0, 157.0), 30.0, highpass=100),
    # Terrace Springs: carbon dioxide bubbling up through hot water; its 60 Hz line notched.
    Sound('bubbles', 'usgs-terrace-springs-co2-bubbles-excerpt.mp3', (70.0, 102.0), 30.0, notch=(60.0, 120.0)),
    # Light rain in woods (CC0), between the distant thunder and the bird; high-passed under the drops on the windscreen.
    Sound('rain', 'commons-light-rain-distant-thunder-2016.wav', (36.0, 68.0), 30.0, mono=False, highpass=160),
    # Waves on a sandy beach, cut at their troughs (a 4 s crossfade).
    Sound('surf', 'commons-beach-sounds-south-carolina.ogg', (15.0, 49.0), 30.0, mono=False, highpass=60),
    # One long rolling thunder (NPS), after its crack; slowed and darkened in the film into a felt swell.
    Sound('thunder', 'nps-thunder-nsnsd.mp3', (3.5, 33.5), None, fade_in=1.0, fade_out=6.0),
    # A meteor exploding over Yellowstone, its infrasound sped up ten times (USGS): one deep, distant thud.
    Sound('bolide', 'usgs-bolide-infrasound-2025.mp4', (3.0, 5.5), None, highpass=15, fade_in=0.05, fade_out=0.6),
)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def fetch(name: str) -> Path:
    """The original on disk, downloaded the first time and checked against its sha256 every time."""
    spec = ORIGINAL[name]
    path = ORIGINALS / name
    if not path.exists():
        ORIGINALS.mkdir(parents=True, exist_ok=True)
        headers = {'User-Agent': USER_AGENT}
        if spec.byte_range:
            headers['Range'] = f'bytes={spec.byte_range[0]}-{spec.byte_range[1]}'
        print(f'downloading {name} from {spec.url}', flush=True)
        request = urllib.request.Request(spec.url, headers=headers)
        partial = path.with_suffix(path.suffix + '.part')
        with urllib.request.urlopen(request, timeout=120) as response, partial.open('wb') as out:
            if spec.byte_range and response.status != 206:
                raise SystemExit(f'{name}: the server ignored the byte range (status {response.status})')
            shutil.copyfileobj(response, out)
        partial.rename(path)
    digest = sha256(path)
    if digest != spec.sha256 or path.stat().st_size != spec.size:
        raise SystemExit(f'{name}: sha256 {digest} ({path.stat().st_size} bytes), expected {spec.sha256} ({spec.size} bytes)')
    return path


def decode(path: Path, work: Path) -> tuple[np.ndarray, int]:
    """Samples (frames by channels, float64) and their rate; a video's sound is taken out with afconvert."""
    if path.suffix == '.mp4':
        wav = work / (path.stem + '.wav')
        subprocess.run(['afconvert', '-f', 'WAVE', '-d', 'LEI24', str(path), str(wav)], check=True)
        path = wav
    data, rate = sf.read(str(path), dtype='float64', always_2d=True)
    return data, rate


def resample(x: np.ndarray, rate: int) -> np.ndarray:
    if rate == RATE:
        return x
    ratio = Fraction(RATE, rate)
    return signal.resample_poly(x, ratio.numerator, ratio.denominator, axis=0)


def k_weighting() -> list[np.ndarray]:
    """ITU-R BS.1770's K-weighting at RATE: a high shelf (+4 dB above about 1.5 kHz) and a high-pass at 38 Hz."""
    out = []
    w0 = 2 * np.pi * 1500.0 / RATE
    a = 10 ** (4.0 / 40)
    alpha = np.sin(w0) / (2 / np.sqrt(2))
    cos = np.cos(w0)
    b = [a * ((a + 1) + (a - 1) * cos + 2 * np.sqrt(a) * alpha), -2 * a * ((a - 1) + (a + 1) * cos), a * ((a + 1) + (a - 1) * cos - 2 * np.sqrt(a) * alpha)]
    den = [(a + 1) - (a - 1) * cos + 2 * np.sqrt(a) * alpha, 2 * ((a - 1) - (a + 1) * cos), (a + 1) - (a - 1) * cos - 2 * np.sqrt(a) * alpha]
    out.append(signal.tf2sos(b, den))
    w0 = 2 * np.pi * 38.0 / RATE
    alpha = np.sin(w0) / (2 * 0.5)
    cos = np.cos(w0)
    out.append(signal.tf2sos([(1 + cos) / 2, -(1 + cos), (1 + cos) / 2], [1 + alpha, -2 * cos, 1 - alpha]))
    return out


def loudness(x: np.ndarray) -> float:
    """Integrated loudness (LUFS, BS.1770-4: 400 ms blocks, absolute gate -70, relative gate -10)."""
    y = x
    for sos in k_weighting():
        y = signal.sosfilt(sos, y, axis=0)
    block, hop = int(0.4 * RATE), int(0.1 * RATE)
    power = (y ** 2).sum(axis=1)
    if len(power) < block:
        block = len(power)
    csum = np.concatenate([[0.0], np.cumsum(power)])
    starts = np.arange(0, len(power) - block + 1, hop)
    blocks = (csum[starts + block] - csum[starts]) / block
    lufs = -0.691 + 10 * np.log10(np.maximum(blocks, 1e-30))
    gated = blocks[lufs > -70]
    if len(gated) == 0:
        return float('-inf')
    relative = -0.691 + 10 * np.log10(gated.mean()) - 10
    gated = gated[-0.691 + 10 * np.log10(gated) > relative]
    return float(-0.691 + 10 * np.log10(gated.mean()))


def shape(sound: Sound, x: np.ndarray, rate: int) -> np.ndarray:
    a, b = sound.window
    x = x[int(round(a * rate)):int(round(b * rate))]
    if sound.mono:
        x = x.mean(axis=1, keepdims=True)
    x = resample(x, rate)
    if sound.highpass:
        x = signal.sosfiltfilt(signal.butter(2, sound.highpass, 'highpass', fs=RATE, output='sos'), x, axis=0)
    if sound.lowpass:
        x = signal.sosfiltfilt(signal.butter(4, sound.lowpass, 'lowpass', fs=RATE, output='sos'), x, axis=0)
    for hz in sound.notch:
        bn, an = signal.iirnotch(hz, 25.0, fs=RATE)
        x = signal.filtfilt(bn, an, x, axis=0)
    if sound.loop is None:
        n = len(x)
        envelope = np.ones(n)
        fi, fo = int(sound.fade_in * RATE), int(sound.fade_out * RATE)
        if fi:
            envelope[:fi] = np.sin(0.5 * np.pi * np.arange(fi) / fi) ** 2
        if fo:
            envelope[n - fo:] = np.cos(0.5 * np.pi * np.arange(fo) / fo) ** 2
        return x * envelope[:, None]
    # A seamless loop: the window's last `fade` seconds are faded (equal power) into its first, so the
    # loop of `loop` seconds runs on from its own end into its start.
    length = int(round(sound.loop * RATE))
    fade = len(x) - length
    if fade <= 0:
        raise SystemExit(f'{sound.name}: the window is no longer than the loop')
    u = np.arange(fade) / fade
    looped = x[:length].copy()
    looped[:fade] = x[:fade] * np.sin(0.5 * np.pi * u)[:, None] + x[length:length + fade] * np.cos(0.5 * np.pi * u)[:, None]
    pad = int(round(PAD_S * RATE))
    return np.concatenate([looped[length - pad:], looped, looped[:pad]])


def level(sound: Sound, x: np.ndarray) -> tuple[np.ndarray, float]:
    """Set to TARGET_LUFS, or lower if a peak would pass PEAK_CAP_DB; returns the gain in dB."""
    measured = loudness(x)
    gain = TARGET_LUFS - measured
    peak = 20 * np.log10(np.max(np.abs(x)) + 1e-12)
    gain = min(gain, PEAK_CAP_DB - peak)
    return x * 10 ** (gain / 20), gain


def encode(sound: Sound, x: np.ndarray, work: Path) -> Path:
    wav = work / f'{sound.name}.wav'
    sf.write(str(wav), x.astype(np.float32), RATE, subtype='FLOAT')
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f'{sound.name}.m4a'
    bitrate = 80_000 if x.shape[1] == 1 else 112_000
    subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac', '-b', str(bitrate), '-q', '127', str(wav), str(out)], check=True)
    return out


def main() -> None:
    only = set(sys.argv[1:])
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        print(f'{"sound":8s} {"ch":>2s} {"seconds":>8s} {"loop":>6s} {"LUFS":>6s} {"peak":>6s} {"gain":>6s} {"bytes":>9s}')
        for sound in SOUNDS:
            if only and sound.name not in only:
                continue
            x, rate = decode(fetch(sound.original), work)
            y = shape(sound, x, rate)
            y, gain = level(sound, y)
            out = encode(sound, y, work)
            peak = 20 * np.log10(np.max(np.abs(y)) + 1e-12)
            loop = f'{sound.loop:.1f}' if sound.loop else '-'
            print(f'{sound.name:8s} {y.shape[1]:2d} {len(y) / RATE:8.2f} {loop:>6s} {loudness(y):6.1f} {peak:6.1f} {gain:+6.1f} {out.stat().st_size:9d}')


if __name__ == '__main__':
    main()
