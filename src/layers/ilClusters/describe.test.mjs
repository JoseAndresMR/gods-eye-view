import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCluster } from './describe.js';

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
