import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DEAD_RECKON_S, clusterColorCss, predictPosition } from './model.js';

const base = { lat: 50, lon: 5, alt_m: 10000, velocity: 200, true_track: 90, vertical_rate: 0, time_position: 1000 };

test('a fresh report stays where it was reported', () => {
  assert.deepEqual(predictPosition(base, 1000), { lat: 50, lon: 5, altM: 10000 });
});

test('dead reckoning moves along the track at ground speed', () => {
  const p = predictPosition(base, 1010); // 2 km due east
  assert.ok(Math.abs(p.lat - 50) < 1e-9);
  const metresPerDegLon = (Math.PI / 180) * 6371008.8 * Math.cos((50 * Math.PI) / 180);
  assert.ok(Math.abs((p.lon - 5) * metresPerDegLon - 2000) < 1);
});

test('extrapolation is capped for stale reports', () => {
  const capped = predictPosition(base, 1000 + MAX_DEAD_RECKON_S);
  const later = predictPosition(base, 1000 + MAX_DEAD_RECKON_S + 500);
  assert.deepEqual(later, capped);
});

test('climb follows vertical rate and never goes below ground', () => {
  assert.equal(predictPosition({ ...base, vertical_rate: 5 }, 1010).altM, 10050);
  assert.equal(predictPosition({ ...base, alt_m: 100, vertical_rate: -50 }, 1010).altM, 0);
});

test('height prefers GNSS altitude over barometric', () => {
  assert.equal(predictPosition({ ...base, geo_altitude: 10180 }, 1000).altM, 10180);
  assert.equal(predictPosition({ ...base, geo_altitude: null }, 1000).altM, 10000);
});

test('missing motion or position is handled', () => {
  assert.deepEqual(predictPosition({ ...base, velocity: null }, 1050), { lat: 50, lon: 5, altM: 10000 });
  assert.equal(predictPosition({ lat: null, lon: 5 }, 0), null);
});

test('longitude wraps at the antimeridian', () => {
  const p = predictPosition({ ...base, lat: 0, lon: 179.999 }, 1010);
  assert.ok(p.lon < -179.9);
});

test('cluster colours are stable and match the IL palette', () => {
  assert.equal(clusterColorCss('C1'), clusterColorCss('C13'));
  assert.notEqual(clusterColorCss('C1'), clusterColorCss('C2'));
  assert.equal(clusterColorCss(null), '#9a9a94');
});
