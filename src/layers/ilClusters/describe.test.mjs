import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeCameras,
  describeCluster,
  describeOverflights,
  describePlateReaders,
  describeStreetImagery,
  describeFireSatellites,
  describeImaged,
  describeImaging,
  describeNavigation,
  describeReceivers,
  describeWeather,
} from './describe.js';

test('a vessel cluster reads as size, spread, motion, make-up and age', () => {
  const { title, lines } = describeCluster(
    {
      id: 'C7',
      size: 4,
      age_s: 1800,
      summary: {
        size: 4,
        radius_km: 0.42,
        motion: { reporting: 4, mean_speed_mps: 5, group_speed_mps: 4.9, group_track_deg: 271, alignment: 0.95 },
        composition: { type: [{ value: 'Tanker', count: 3 }], destination: [{ value: 'ROTTERDAM', count: 1 }] },
      },
    },
    'vessels',
  );
  assert.equal(title, 'C7 · 4 vessels');
  assert.deepEqual(lines, [
    'Within 0.4 km of its centre',
    'Moving together · heading 271° · 18 km/h',
    'Mostly Tanker (3)',
    'Together for 30 min',
  ]);
});

test('docked satellites, fires and GNSS zones get their own facts', () => {
  const sat = describeCluster(
    { id: 'C1', age_s: 30, summary: { size: 3, radius_km: 0, alt_m: { min: 387000, max: 388000 }, names: ['A', 'B', 'C', 'D'] } },
    'satellites',
  );
  assert.deepEqual(sat.lines, ['Members share one position', 'Altitude 387–388 km', 'A, B, C…', 'Just formed']);
  const fire = describeCluster(
    { id: 'C2', summary: { size: 2, fire: { frp_total_mw: 40.2, frp_max_mw: 30 } } },
    'fires',
  );
  assert.equal(fire.title, 'C2 · 2 fire detections');
  assert.ok(fire.lines.includes('40 MW radiative power · peak 30 MW'));
  const zone = describeCluster(
    { id: 'C3', summary: { size: 1, gnss: { aircraft: 20, degraded: 9 } } },
    'gnss',
  );
  assert.equal(zone.title, 'C3 · 1 low-accuracy cell');
  assert.ok(zone.lines.includes('9 of 20 aircraft reported low navigation accuracy'));
});

const SATS = { 1: { name: 'SENTINEL-1A' }, 2: { name: 'LANDSAT 9' }, 3: { name: 'GOES 19' }, 4: { name: 'NOAA 21 (JPSS-2)' }, 5: { name: 'LEMUR-2-X' } };

test('imaging lines: optical and radar overhead, then the next of each', () => {
  const lines = describeImaging({
    place: { now: [], counts: {}, next: { optical: { t: 1000 + 23 * 60, sat: '2', day: true } } },
    satellites: SATS,
    overhead: [
      { name: 'WORLDVIEW-3', kinds: ['optical'] }, { name: 'PLEIADES NEO 3', kinds: ['optical'] },
      { name: 'SKYSAT-C5', kinds: ['optical'] }, { name: 'SPOT 7', kinds: ['optical'] },
      { name: 'SENTINEL-1A', kinds: ['radar'] },
    ],
    horizonS: 10800,
    nowSec: 1000,
  });
  assert.deepEqual(lines, [
    'Optical satellites overhead: WORLDVIEW-3, PLEIADES NEO 3, SKYSAT-C5 +1',
    'Radar satellites overhead: SENTINEL-1A',
    'Next daylight optical pass in 23 min · LANDSAT 9',
  ]);
  assert.deepEqual(
    describeImaging({ place: { now: [], counts: {}, next: {} }, satellites: SATS, overhead: [], horizonS: 10800, nowSec: 1 }),
    ['No daylight optical pass in the next 3 h', 'No radar pass in the next 3 h'],
  );
});

test('fire, weather, receivers and navigation lines', () => {
  assert.deepEqual(
    describeFireSatellites({ place: { next: { fire: { t: 1000 + 600, sat: '4' } } }, satellites: SATS, overhead: [], horizonS: 10800, nowSec: 1000 }),
    ['Next fire-detection overpass in 10 min · NOAA 21 (JPSS-2)'],
  );
  assert.deepEqual(
    describeWeather({ place: { now: [['3', 48.4]], counts: { weather: 4 } }, satellites: SATS }),
    ['4 weather satellites in view · highest GOES 19 (48°)'],
  );
  assert.deepEqual(
    describeReceivers({ kind: 'vessels', place: { counts: { ais: 2, sar: 1 }, next: {} }, satellites: SATS, nowSec: 0 }),
    ['2 space AIS receivers in reach', '1 search-and-rescue satellite in reach'],
  );
  assert.deepEqual(
    describeReceivers({ kind: 'aircraft', place: { counts: {}, next: { adsb: { t: 400, sat: '5' } } }, satellites: SATS, nowSec: 100 }),
    ['No space ADS-B receiver in reach · next in 5 min · LEMUR-2-X'],
  );
  assert.deepEqual(
    describeNavigation({ place: { counts: { gps: 9, galileo: 7, glonass: 8 }, pdop: 1.02, pdop_gps: 1.84 } }),
    ['In view: 9 GPS · 7 Galileo · 8 GLONASS', 'Satellite geometry: PDOP 1 all · 1.8 GPS alone (lower is better)'],
  );
});

test('imaged lines: latest image, then the latest clear one', () => {
  const sats = { 42063: { name: 'SENTINEL-2B' }, 49260: { name: 'LANDSAT 9' } };
  const now = 1_800_000_000;
  assert.deepEqual(
    describeImaged({
      place: {
        now: [['42063', 5]],
        latest: { sat: '42063', platform: 'SENTINEL-2B', t: now - 5 * 3600, cloud: 80 },
        latest_clear: { sat: '49260', platform: 'LANDSAT 9', t: now - 4 * 86400, cloud: 3 },
      },
      satellites: sats,
      nowSec: now,
    }),
    ['Last image: SENTINEL-2B · 5 h ago · 80% cloud', 'Last clear image: LANDSAT 9 · 4 days ago · 3% cloud'],
  );
  assert.deepEqual(describeImaged({ place: { pending: true }, satellites: sats, nowSec: now }), ['Recent images: still being checked']);
  assert.deepEqual(describeImaged({ place: { now: [], latest: null }, satellites: sats, nowSec: now }), ['No image in the last days']);
});

test('ground and air observer lines', () => {
  const obs = {
    'cam:1': { name: 'US 281 at Hildebrand', kinds: ['camera'] },
    'cam:2': { name: 'I-35 at 51st', kinds: ['camera'] },
    'air:aircraft:20:A': { name: 'A', kinds: ['aircraft'] },
    'air:military:20:M': { name: 'M', kinds: ['military'] },
  };
  assert.deepEqual(describeCameras({ place: { now: [['cam:1', 18], ['cam:2', 40]] }, satellites: obs }),
    ['Watched by 2 public cameras: US 281 at Hildebrand, I-35 at 51st']);
  assert.deepEqual(describeCameras({ place: { now: [] }, satellites: obs }), []);
  assert.deepEqual(describePlateReaders({ place: { now: [['alpr:1', 32], ['alpr:2', 80]] } }),
    ['2 plate readers within 100 m · nearest 32 m']);
  assert.deepEqual(describeStreetImagery({ place: { now: [['mly:1', 30], ['mly:2', 900]] } }),
    ['Street imagery: 2 capture drives passed · latest 30 h ago']);
  assert.deepEqual(
    describeOverflights({ place: { now: [['air:aircraft:20:A', 900], ['air:military:20:M', 450]] }, satellites: obs }),
    ['Overflown now by 1 aircraft cluster · lowest 900 m', 'Overflown now by 1 military aircraft cluster · lowest 450 m'],
  );
});
