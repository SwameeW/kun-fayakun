import { altitudeOf, foldHour, plate, rete, type PlatePoint } from '../../explore/islamic/astrolabe';
import type { UniverseIslamic } from '../../core/types';

/**
 * The astrolabe drawn (ledger IA-11; the geometry in src/explore/islamic/astrolabe.ts): the mater's
 * rim with the hours of local apparent time (noon at the top), the plate for the latitude (the sky
 * above the horizon lightly lit; the tropics and equator, almucantars, azimuths, the horizon and the
 * dashed circle 18 degrees below it, the zenith marked, all in brass), then the rete (the ecliptic, the stars with their
 * names where they do not crowd, the Sun) and the rule from the centre through the Sun to the rim.
 * Drawn at a fixed size and scaled by the page, as the HR diagram is.
 */

export const ASTROLABE_PX = 640;
const C = ASTROLABE_PX / 2;
/** The rim's width and the space round it (px). */
const RIM = 30;
const PAD = 6;
const BRASS = '214,178,106';
const PALE = '237,231,218';
const SUN = 'rgba(255,214,120,1)';
const FONT = '27px system-ui, sans-serif';

export interface AstrolabeDrawn {
  /** Stars on the rete, and the Sun's altitude (degrees) and hour angle (degrees, -180 to 180). */
  stars: number;
  sunAltDeg: number;
  sunHourDeg: number;
}

export function drawAstrolabe(canvas: HTMLCanvasElement, a: NonNullable<UniverseIslamic['astrolabe']>, east: string, west: string): AstrolabeDrawn | null {
  const g = canvas.getContext('2d');
  if (!g) return null;
  const p = plate(a.latDeg, a.obliquityDeg);
  const r = rete(a.latDeg, a.lstDeg, a.obliquityDeg, a.sun, a.stars);
  const edgePx = C - RIM - PAD;
  const scale = edgePx / p.edge;
  const px = (q: PlatePoint): [number, number] => [C + q.x * scale, C - q.y * scale];
  const lines = (runs: readonly PlatePoint[][], style: string, width: number, dash: number[] = []): void => {
    g.strokeStyle = style;
    g.lineWidth = width;
    g.setLineDash(dash);
    for (const run of runs) {
      g.beginPath();
      run.forEach((q, k) => {
        const [x, y] = px(q);
        if (k === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
    }
    g.setLineDash([]);
  };
  const circle = (radius: number, style: string, width: number): void => {
    g.strokeStyle = style;
    g.lineWidth = width;
    g.beginPath();
    g.arc(C, C, radius, 0, 2 * Math.PI);
    g.stroke();
  };
  g.clearRect(0, 0, ASTROLABE_PX, ASTROLABE_PX);

  // The mater's rim: brass, with the hours (local apparent time: noon at the top, morning on the east).
  g.fillStyle = `rgba(${BRASS},0.16)`;
  g.beginPath();
  g.arc(C, C, edgePx + RIM, 0, 2 * Math.PI);
  g.arc(C, C, edgePx, 0, 2 * Math.PI, true);
  g.fill();
  circle(edgePx + RIM, `rgba(${BRASS},0.9)`, 2);
  g.font = FONT;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let hour = 0; hour < 24; hour += 1) {
    // The Sun's hour angle at this hour is (hour - 12) x 15 degrees; on the plate, clockwise from the top in the north.
    const angle = ((hour - 12) * 15 * Math.PI) / 180;
    const sx = p.hemisphere * Math.sin(angle);
    const sy = Math.cos(angle);
    const major = hour % 6 === 0;
    g.strokeStyle = `rgba(${BRASS},0.9)`;
    g.lineWidth = major ? 3 : 1.5;
    g.beginPath();
    g.moveTo(C + sx * edgePx, C - sy * edgePx);
    g.lineTo(C + sx * (edgePx + (major ? RIM : RIM * 0.4)), C - sy * (edgePx + (major ? RIM : RIM * 0.4)));
    g.stroke();
    if (major) {
      // The number inside the rim, beside its tick.
      const at = angle + (p.hemisphere * 9 * Math.PI) / 180;
      g.fillStyle = `rgba(${PALE},0.9)`;
      g.fillText(String(hour), C + p.hemisphere * Math.sin(at) * (edgePx + RIM / 2), C - Math.cos(at) * (edgePx + RIM / 2));
    }
  }

  // The plate, clipped to its edge.
  g.save();
  g.beginPath();
  g.arc(C, C, edgePx, 0, 2 * Math.PI);
  g.clip();
  g.fillStyle = 'rgba(10,12,20,0.55)';
  g.fillRect(0, 0, ASTROLABE_PX, ASTROLABE_PX);
  // The sky above the horizon: the horizon's circle, centred cot(latitude) up the meridian, radius 1 / sin(latitude).
  const phi = (Math.abs(a.latDeg) * Math.PI) / 180;
  if (phi > 0.02) {
    g.fillStyle = 'rgba(110,140,210,0.16)';
    g.beginPath();
    g.arc(C, C - (scale * Math.cos(phi)) / Math.sin(phi), scale / Math.sin(phi), 0, 2 * Math.PI);
    g.fill();
  }
  circle(scale * p.equator, `rgba(${BRASS},0.45)`, 1.5);
  circle(scale * p.tropic, `rgba(${BRASS},0.45)`, 1.5);
  lines(p.azimuths, `rgba(${BRASS},0.22)`, 1);
  lines(p.almucantars, `rgba(${BRASS},0.32)`, 1);
  lines(p.twilight, `rgba(${BRASS},0.6)`, 1.5, [8, 7]);
  lines(p.horizon, `rgba(${BRASS},0.95)`, 2.5);
  // The zenith, where the almucantars close and the azimuths meet: a small cross.
  const [zx, zy] = px(p.zenith);
  g.strokeStyle = `rgba(${BRASS},0.95)`;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(zx - 7, zy);
  g.lineTo(zx + 7, zy);
  g.moveTo(zx, zy - 7);
  g.lineTo(zx, zy + 7);
  g.stroke();
  // East and west where the horizon crosses the equator.
  g.fillStyle = `rgba(${BRASS},1)`;
  g.font = `bold ${FONT}`;
  for (const [q, text] of [
    [p.east, east],
    [p.west, west],
  ] as const) {
    const [x, y] = px(q);
    g.fillText(text, x + Math.sign(q.x) * 16, y - 14);
  }

  // The rete: the ecliptic, the stars, the Sun.
  lines(r.ecliptic, `rgba(${PALE},0.7)`, 2.5);
  g.font = FONT;
  g.textAlign = 'left';
  const taken: Array<[number, number, number, number]> = [];
  for (const s of [...r.stars].sort((x, y) => x.vmag - y.vmag)) {
    const [x, y] = px(s.at);
    const radius = Math.max(2.5, Math.min(7, 5.5 - 1.6 * s.vmag));
    g.fillStyle = `rgba(${PALE},1)`;
    g.beginPath();
    g.arc(x, y, radius, 0, 2 * Math.PI);
    g.fill();
    // Its name to the right, unless it would cross one already written or the rim.
    const w = g.measureText(s.name).width;
    const box: [number, number, number, number] = [x + radius + 4, y - 15, x + radius + 4 + w, y + 15];
    const clear = taken.every(([x0, y0, x1, y1]) => box[2] < x0 || box[0] > x1 || box[3] < y0 || box[1] > y1) && Math.hypot(box[2] - C, y - C) < edgePx;
    if (clear) {
      taken.push(box);
      g.fillStyle = `rgba(${PALE},0.78)`;
      g.fillText(s.name, box[0], y);
    }
  }
  g.restore();

  // The rule: from the centre through the Sun to the rim, where it reads the hour.
  const sunHourDeg = foldHour(a.lstDeg - a.sun.raDeg);
  const angle = (sunHourDeg * Math.PI) / 180;
  const tx = p.hemisphere * Math.sin(angle);
  const ty = Math.cos(angle);
  g.strokeStyle = `rgba(${BRASS},0.95)`;
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(C - tx * 18, C + ty * 18);
  g.lineTo(C + tx * (edgePx + RIM), C - ty * (edgePx + RIM));
  g.stroke();
  g.fillStyle = `rgba(${BRASS},1)`;
  g.beginPath();
  g.arc(C, C, 6, 0, 2 * Math.PI);
  g.fill();
  if (r.sun) {
    const [x, y] = px(r.sun);
    g.fillStyle = SUN;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, 10, 0, 2 * Math.PI);
    g.stroke();
    g.fill();
  }
  return { stars: r.stars.length, sunAltDeg: altitudeOf(a.sun.decDeg, sunHourDeg, a.latDeg), sunHourDeg };
}
