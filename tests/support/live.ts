/**
 * The Living Earth's live services, answered inside the browser so no test reaches them (they are
 * third parties with their own limits, and their answers change by the minute): imagery tiles (EOX,
 * NASA GIBS) get a one-pixel image, CelesTrak a few real element sets moved to the day the test runs
 * (so they are never out of date), and USGS a day of three earthquakes ending now. Every page gets
 * these routes (tests/support/fixtures); liveRequests(page) counts what each host was asked.
 */
import type { Page } from '@playwright/test';

export const LIVE_HOSTS = ['tiles.maps.eox.at', 'gibs.earthdata.nasa.gov', 'celestrak.org', 'earthquake.usgs.gov'] as const;
export type LiveHost = (typeof LIVE_HOSTS)[number];

/** A one-pixel PNG (relative to the repository, where the runner starts): a valid tile as far as decoding goes. */
const PIXEL_PATH = 'tests/support/pixel.png';

/** Element sets from CelesTrak's active group (2026-10-25): the two crewed stations, a Starlink, a GPS satellite and a geostationary one. */
const TLES = [
  ['ISS (ZARYA)', '1 25544U 98067A   26298.49942685  .00007074  00000+0  13616-3 0  9991', '2 25544  51.6337  15.2393 0006903 308.0649  51.9716 15.49050058591953'],
  ['CSS (TIANHE)', '1 48274U 21035A   26298.54469417  .00007182  00000+0  86437-4 0  9992', '2 48274  41.4691 250.0955 0002979 213.9028 146.1621 15.61156971313527'],
  ['STARLINK-1008', '1 44714U 19074B   26298.03239917  .00041338  00000+0  36985-3 0  9994', '2 44714  53.1443 157.5593 0002345 154.1040 206.0094 15.67965240384489'],
  ['NAVSTAR 81 (USA 319)', '1 48859U 21054A   26298.30201624 -.00000044  00000+0  00000+0 0  9998', '2 48859  55.1032 327.2206 0029488 233.0550 245.3355  2.00561299 39365'],
  ['GOES 18', '1 51850U 22021A   26298.67421940  .00000110  00000+0  00000+0 0  9996', '2 51850   0.0011 177.2542 0000627  92.3708 230.1914  1.00272471  7905'],
] as const;

/** A TLE line's check digit: its digits summed, a minus sign counting one, modulo ten. */
const checksum = (line: string): number => (line.slice(0, 68).match(/[\d-]/gu) ?? []).reduce((sum, c) => sum + (c === '-' ? 1 : Number(c)), 0) % 10;

/** Line 1 with its epoch (columns 19 to 32, YYDDD.DDDDDDDD) moved to `unixMs`, and its check digit made again. */
export function withEpoch(line1: string, unixMs: number): string {
  const d = new Date(unixMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const day = 1 + (unixMs - start) / 86_400_000;
  const epoch = `${String(d.getUTCFullYear() % 100).padStart(2, '0')}${day.toFixed(8).padStart(12, '0')}`;
  const line = `${line1.slice(0, 18)}${epoch}${line1.slice(32, 68)}`;
  return `${line}${checksum(line)}`;
}

export function catalogue(unixMs: number): string {
  return `${TLES.map(([name, l1, l2]) => `${name.padEnd(24)}\n${withEpoch(l1, unixMs)}\n${l2}`).join('\n')}\n`;
}

export function quakeFeed(unixMs: number): unknown {
  const quake = (id: string, mag: number, lon: number, lat: number, depth: number, minutesAgo: number, place: string): unknown => ({
    type: 'Feature',
    id,
    properties: { mag, place, time: unixMs - minutesAgo * 60_000, url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}` },
    geometry: { type: 'Point', coordinates: [lon, lat, depth] },
  });
  return {
    type: 'FeatureCollection',
    metadata: { generated: unixMs, title: 'USGS Magnitude 2.5+ Earthquakes, Past Day (test)' },
    features: [
      quake('test1', 4.6, 142.1, 27.5, 30, 20, 'Bonin Islands, test region'),
      quake('test2', 6.1, -72.6, -33.2, 25, 180, 'offshore, test region'),
      quake('test3', 2.9, -116.8, 33.5, 8, 600, '12 km N of a test town'),
    ],
  };
}

const counts = new WeakMap<Page, Record<LiveHost, number>>();

/** Requests each live host was sent from this page so far. */
export function liveRequests(page: Page): Readonly<Record<LiveHost, number>> {
  return counts.get(page) ?? (Object.fromEntries(LIVE_HOSTS.map((h) => [h, 0])) as Record<LiveHost, number>);
}

export async function mockLiveHosts(page: Page): Promise<void> {
  const requests = Object.fromEntries(LIVE_HOSTS.map((h) => [h, 0])) as Record<LiveHost, number>;
  counts.set(page, requests);
  const cors = { 'access-control-allow-origin': '*' };
  await page.route((url) => (LIVE_HOSTS as readonly string[]).includes(url.hostname), async (route) => {
    const host = new URL(route.request().url()).hostname as LiveHost;
    requests[host] += 1;
    if (host === 'celestrak.org') {
      await route.fulfill({ status: 200, headers: cors, contentType: 'text/plain', body: catalogue(Date.now()) });
    } else if (host === 'earthquake.usgs.gov') {
      await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(quakeFeed(Date.now())) });
    } else {
      await route.fulfill({ status: 200, headers: cors, contentType: 'image/png', path: PIXEL_PATH });
    }
  });
}
