import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aircraftMotion,
  clusterColorCss,
  clustersIndexUrl,
  clustersUrl,
  distanceLabel,
  pickDistance,
  predictPosition,
  vesselMotion,
} from './model.js';

const plane = { lat: 50, lon: 5, alt_m: 10000, velocity: 200, true_track: 90, vertical_rate: 0, time_position: 1000 };
const motion = aircraftMotion(plane);

test('distance choice keeps the current one while it is offered', () => {
  assert.equal(pickDistance([5, 10, 20], 10, 20), 10);
  assert.equal(pickDistance([5, 10, 20], 30, 20), 20);
  assert.equal(pickDistance([5, 10], null, 20), 5);
  assert.equal(pickDistance([], 10, 20), null);
});

test('URLs use the intelligence layer file names per kind', () => {
  assert.equal(distanceLabel(20), '20');
  assert.equal(distanceLabel(0.25), '0.25');
  assert.equal(clustersUrl('aircraft', 20), '/api/il/aircraft?km=20');
  assert.equal(clustersUrl('vessels', 0.5), '/api/il/vessels?km=0.5');
  assert.equal(clustersIndexUrl('vessels'), '/api/il/vessels/index');
});

test('a fresh report stays where it was reported', () => {
  assert.deepEqual(predictPosition(motion, 1000, 120), { lat: 50, lon: 5, altM: 10000 });
});

test('dead reckoning moves along the track at ground speed', () => {
  const p = predictPosition(motion, 1010, 120); // 2 km due east
  assert.ok(Math.abs(p.lat - 50) < 1e-9);
  const metresPerDegLon = (Math.PI / 180) * 6371008.8 * Math.cos((50 * Math.PI) / 180);
  assert.ok(Math.abs((p.lon - 5) * metresPerDegLon - 2000) < 1);
});

test('extrapolation is capped for stale reports', () => {
  assert.deepEqual(predictPosition(motion, 1000 + 500, 120), predictPosition(motion, 1000 + 120, 120));
});

test('aircraft climb follows vertical rate, never below ground, GNSS height first', () => {
  assert.equal(predictPosition(aircraftMotion({ ...plane, vertical_rate: 5 }), 1010, 120).altM, 10050);
  assert.equal(predictPosition(aircraftMotion({ ...plane, alt_m: 100, vertical_rate: -50 }), 1010, 120).altM, 0);
  assert.equal(aircraftMotion({ ...plane, geo_altitude: 10180 }).altM, 10180);
});

test('vessel motion converts knots and drops AIS not-available values', () => {
  const v = vesselMotion({ lat: 51.9, lon: 4.1, speed: 10, course: 180, last_position_epoch: 50 });
  assert.equal(v.altM, 0);
  assert.ok(Math.abs(v.speedMps - 5.14444) < 1e-6);
  assert.equal(v.trackDeg, 180);
  assert.equal(v.reportedAt, 50);
  const na = vesselMotion({ lat: 0, lon: 0, speed: 102.3, course: 360 });
  assert.equal(na.speedMps, null);
  assert.equal(na.trackDeg, null);
});

test('missing motion or position is handled', () => {
  assert.deepEqual(predictPosition(aircraftMotion({ ...plane, velocity: null }), 1050, 120), { lat: 50, lon: 5, altM: 10000 });
  assert.equal(predictPosition(vesselMotion({ lat: null, lon: 5 }), 0, 600), null);
});

test('longitude wraps at the antimeridian', () => {
  const p = predictPosition(aircraftMotion({ ...plane, lat: 0, lon: 179.999 }), 1010, 120);
  assert.ok(p.lon < -179.9);
});

test('cluster colours are stable and match the IL palette', () => {
  assert.equal(clusterColorCss('C1'), clusterColorCss('C13'));
  assert.notEqual(clusterColorCss('C1'), clusterColorCss('C2'));
  assert.equal(clusterColorCss(null), '#9a9a94');
});
