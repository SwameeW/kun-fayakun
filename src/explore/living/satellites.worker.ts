/// <reference lib="webworker" />
// satellite.js's own modules, not its package entry: the entry also loads its WebAssembly bulk
// propagator (threads, top-level await), which a worker here never uses and which would not bundle.
import { twoline2satrec } from '../../../node_modules/satellite.js/dist/io.js';
import { gstime, propagate } from '../../../node_modules/satellite.js/dist/propagation.js';
import { SatRecError, type SatRec } from '../../../node_modules/satellite.js/dist/propagation/SatRec.js';
import { eciToEcf } from '../../../node_modules/satellite.js/dist/transforms.js';
import { classifySatellite, type SatelliteKind } from './satellite-kinds';

/**
 * The satellites' propagator, off the main thread: CelesTrak's orbital elements (two-line element
 * sets) through SGP4 (satellite.js), for every object at one instant, as Earth-fixed positions (km)
 * and velocities (km/s). The main thread asks about once a second; between answers the GPU carries
 * each satellite along its velocity, which over a second departs from the true path by metres.
 *
 * TEME to Earth-fixed: rotated by Greenwich sidereal time (satellite.js gstime); the velocity also
 * loses the Earth's own turn (omega x r), omega being the Earth's rotation rate the main thread passes
 * from its rotation model (public/assets/jpl/physical.json), so no number is typed here.
 */

export type SatelliteRequest =
  | { type: 'init'; tle: string; omega: number }
  | { type: 'tick'; unixMs: number }
  | { type: 'path'; index: number; unixMs: number; samples: number };

export type SatelliteReply =
  | { type: 'ready'; count: number; names: string[]; ids: Int32Array; kinds: Uint8Array; periodsMin: Float32Array }
  | { type: 'state'; unixMs: number; data: Float32Array }
  | { type: 'path'; index: number; data: Float32Array }
  | { type: 'error'; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let recs: SatRec[] = [];
let omega = 0;

/** Earth-fixed position and velocity of one object at a date into `out` at `o` (NaN when SGP4 fails: decayed, or the elements are bad). */
function state(rec: SatRec, date: Date, gmst: number, out: Float32Array, o: number): void {
  const pv = propagate(rec, date);
  const p = pv?.position;
  const v = pv?.velocity;
  if (!p || !v || typeof p === 'boolean' || typeof v === 'boolean') {
    out.fill(Number.NaN, o, o + 6);
    return;
  }
  const r = eciToEcf(p, gmst);
  const w = eciToEcf(v, gmst);
  out[o] = r.x;
  out[o + 1] = r.y;
  out[o + 2] = r.z;
  // v_ecef = R v_teme - omega x r_ecef, omega along +z.
  out[o + 3] = w.x + omega * r.y;
  out[o + 4] = w.y - omega * r.x;
  out[o + 5] = w.z;
}

scope.onmessage = (event: MessageEvent<SatelliteRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      omega = msg.omega;
      const lines = msg.tle.split(/\r?\n/).map((l) => l.trimEnd());
      const names: string[] = [];
      const ids: number[] = [];
      const kinds: SatelliteKind[] = [];
      const periods: number[] = [];
      recs = [];
      for (let i = 0; i + 2 < lines.length + 1; i += 1) {
        const l1 = lines[i + 1];
        const l2 = lines[i + 2];
        if (!l1 || !l2 || !l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
        const name = (lines[i] ?? '').trim();
        const rec = twoline2satrec(l1, l2);
        if (rec.error !== SatRecError.None) {
          i += 2;
          continue;
        }
        recs.push(rec);
        names.push(name);
        ids.push(Number.parseInt(l1.slice(2, 7), 10));
        // Mean motion: radians per minute (satellite.js), so the period is 2 pi / no minutes.
        const period = (2 * Math.PI) / rec.no;
        periods.push(period);
        kinds.push(classifySatellite(name, period, (2 * Math.PI) / omega / 60));
        i += 2;
      }
      const reply: SatelliteReply = { type: 'ready', count: recs.length, names, ids: Int32Array.from(ids), kinds: Uint8Array.from(kinds), periodsMin: Float32Array.from(periods) };
      scope.postMessage(reply);
      return;
    }
    if (msg.type === 'tick') {
      const date = new Date(msg.unixMs);
      const gmst = gstime(date);
      const data = new Float32Array(recs.length * 6);
      recs.forEach((rec, i) => {
        state(rec, date, gmst, data, i * 6);
      });
      const reply: SatelliteReply = { type: 'state', unixMs: msg.unixMs, data };
      scope.postMessage(reply, [data.buffer]);
      return;
    }
    {
      const rec = recs[msg.index];
      if (!rec) return;
      // One orbit, centred on now, as Earth-fixed positions (the ground track's shape in space).
      const period = (2 * Math.PI) / rec.no;
      const data = new Float32Array(msg.samples * 3);
      const one = new Float32Array(6);
      for (let i = 0; i < msg.samples; i += 1) {
        const t = msg.unixMs + ((i / (msg.samples - 1) - 0.5) * period * 60_000);
        const date = new Date(t);
        state(rec, date, gstime(date), one, 0);
        data.set(one.subarray(0, 3), i * 3);
      }
      const reply: SatelliteReply = { type: 'path', index: msg.index, data };
      scope.postMessage(reply, [data.buffer]);
    }
  } catch (err) {
    const reply: SatelliteReply = { type: 'error', message: err instanceof Error ? err.message : String(err) };
    scope.postMessage(reply);
  }
};
