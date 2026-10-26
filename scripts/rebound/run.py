"""
The orbital laboratory's external reference (ledger SB-36): the solar-system seed
(tests/fixtures/rebound/solar-initial.json, written by scripts/rebound/initial.ts) integrated
one Julian year with REBOUND's IAS15 (Rein and Spiegel 2015), point masses, G = 1 with masses
as GM (km^3 s^-2), km, s. Only the numbers it produces are used (REBOUND is GPL-3.0; none of its
code is in this project). Writes tests/fixtures/rebound/solar-1yr.json with REBOUND's version,
the integrator, the input's SHA-256, the relative energy error, and every body's final state.

Run: python3 -I scripts/rebound/run.py  (with rebound installed, e.g. in a virtualenv)
"""
import hashlib
import json
import pathlib
import sys

import rebound

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / "tests/fixtures/rebound/solar-initial.json"
TARGET = ROOT / "tests/fixtures/rebound/solar-1yr.json"
YEAR_S = 365.25 * 86400.0

raw = SOURCE.read_bytes()
data = json.loads(raw)
sim = rebound.Simulation()
sim.G = 1.0
sim.integrator = "ias15"
for b in data["bodies"]:
    sim.add(m=b["gm"], x=b["pos"][0], y=b["pos"][1], z=b["pos"][2], vx=b["vel"][0], vy=b["vel"][1], vz=b["vel"][2])
e0 = sim.energy()
sim.integrate(YEAR_S, exact_finish_time=1)
e1 = sim.energy()
out = {
    "rebound": rebound.__version__,
    "integrator": "ias15",
    "epsilon": sim.integrator.epsilon,
    "units": "G = 1, masses as GM (km^3 s^-2), km, s",
    "input": "tests/fixtures/rebound/solar-initial.json",
    "inputSha256": hashlib.sha256(raw).hexdigest(),
    "tS": sim.t,
    "relativeEnergyError": abs((e1 - e0) / e0),
    "bodies": [
        {"id": b["id"], "pos": [p.x, p.y, p.z], "vel": [p.vx, p.vy, p.vz]}
        for b, p in zip(data["bodies"], sim.particles)
    ],
}
TARGET.write_text(json.dumps(out, indent=2) + "\n")
print(f"wrote {TARGET.relative_to(ROOT)}: REBOUND {rebound.__version__}, t = {sim.t} s, energy error {out['relativeEnergyError']:.2e}", file=sys.stderr)
