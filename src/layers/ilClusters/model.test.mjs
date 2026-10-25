import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aircraftMotion,
  boxCovers,
  requestBox,
  cellCorners,
  circleRing,
  clusterLabelEntry,
  elevationDeg,
  observationUrl,
  satelliteEcf,
  densifyRing,
  framingHeightM,
  militaryMotion,
  satellitePosition,
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

test('military motion reads the IL metric fields', () => {
  const m = militaryMotion({ lat: 1, lon: 2, alt_m: 3000, speed_mps: 100, track: 90, climb_mps: -2, position_epoch: 10 });
  assert.deepEqual(m, { lat: 1, lon: 2, altM: 3000, speedMps: 100, trackDeg: 90, climbMps: -2, reportedAt: 10 });
});

test('satellites are propagated from their TLE', () => {
  const node = {
    tle_line1: '1 25544U 98067A   26293.50000000  .00016717  00000+0  30186-3 0  9991',
    tle_line2: '2 25544  51.6400 120.0000 0005000  90.0000 270.0000 15.49000000400000',
  };
  const p = satellitePosition(node, Date.UTC(2026, 9, 20, 12) / 1000);
  assert.ok(p.altM > 300_000 && p.altM < 500_000, String(p.altM));
  assert.ok(Math.abs(p.lat) <= 51.7);
  assert.equal(satellitePosition({}, 0), null);
});

test('footprint rings close and follow long edges', () => {
  assert.deepEqual(densifyRing([]), []);
  assert.deepEqual(densifyRing([[0, 0]]), []);
  const ring = densifyRing([[0, 0], [1, 0], [1, 1]], 10);
  assert.deepEqual(ring[0], [0, 0]);
  assert.deepEqual(ring.at(-1), [0, 0]);
  assert.ok(ring.length > 30, String(ring.length)); // ~111 km edges in 10 km steps
  const across = densifyRing([[179.9, 0], [-179.9, 0]], 100);
  assert.ok(across.every(([lon]) => Math.abs(lon) > 179), JSON.stringify(across));
});

test('framing height grows with the cluster and stays bounded', () => {
  assert.equal(framingHeightM(0), 8000);
  assert.equal(framingHeightM(10), 40000);
  assert.equal(framingHeightM(1e6), 4_000_000);
  assert.equal(framingHeightM(0, 2500), 200000); // one ~50 km cell
});

test('GNSS cells become corner rings', () => {
  assert.deepEqual(cellCorners({ south: 54, west: 18, north: 54.5, east: 18.5 }), [
    [18, 54], [18.5, 54], [18.5, 54.5], [18, 54.5],
  ]);
  assert.deepEqual(cellCorners({ south: 54 }), []);
});

test('coverage circles close and keep their radius', () => {
  const ring = circleRing(0, 0, 463, 36);
  assert.equal(ring.length, 37);
  assert.ok(Math.abs(ring[0][1] - 463 / 111.195) < 0.01, String(ring[0]));
  assert.deepEqual(ring[0].map((v) => v.toFixed(6)), ring.at(-1).map((v) => v.toFixed(6)));
  assert.deepEqual(circleRing(0, 0, 0), []);
});

test('cluster requests can name a box', () => {
  assert.equal(clustersUrl('fires', 2), '/api/il/fires?km=2');
  assert.equal(
    clustersUrl('fires', 2, { west: 110.12345, south: -40, east: 155, north: -10 }),
    '/api/il/fires?km=2&bbox=110.123,-40,155,-10',
  );
});

test('request boxes pad the view and give up near global views', () => {
  assert.deepEqual(requestBox({ west: 0, south: 50, east: 10, north: 54 }), { west: -2.5, east: 12.5, south: 49, north: 55 });
  assert.equal(requestBox(null), null);
  assert.equal(requestBox({ west: -170, south: -60, east: 170, north: 60 }), null);
  const across = requestBox({ west: 175, south: -5, east: -175, north: 5 });
  assert.ok(across.west > 170 && across.east < -170, JSON.stringify(across));
});

test('a request box covers views inside it', () => {
  const box = { west: 0, south: 40, east: 20, north: 60 };
  assert.equal(boxCovers(box, { west: 5, south: 45, east: 15, north: 55 }), true);
  assert.equal(boxCovers(box, { west: 15, south: 45, east: 25, north: 55 }), false);
  assert.equal(boxCovers(null, box), true);
  assert.equal(boxCovers(box, null), false);
  const across = { west: 170, south: -10, east: -170, north: 10 };
  assert.equal(boxCovers(across, { west: 175, south: -5, east: -175, north: 5 }), true);
});

test('cluster labels show the count in the cluster colour, larger clusters first', () => {
  const position = { x: 1, y: 2, z: 3 };
  const entry = clusterLabelEntry({ clusterId: 'c7', count: 12, title: '12', position, color: '#ff0000' });
  assert.equal(entry.id, 'c7');
  assert.equal(entry.title, '12');
  assert.equal(entry.accent, '#ff0000');
  assert.equal(entry.variant, 'label');
  assert.equal(entry.position, position); // the layer moves it in place
  assert.ok(entry.priority > clusterLabelEntry({ clusterId: 'c8', count: 3, title: '3', position, color: '#fff' }).priority);
  assert.equal(entry.horizonCull, true);
});

test('observation url lists the lanes and the box', () => {
  assert.equal(
    observationUrl('imaging', [{ kind: 'dams', km: 10 }, { kind: 'datacenters', km: 0.5 }], { west: -10, south: 35.12345, east: 5, north: 45 }),
    '/api/il/observability/imaging?targets=dams:10,datacenters:0.5&bbox=-10,35.123,5,45',
  );
  assert.equal(observationUrl('receivers', [{ kind: 'vessels', km: 0.5 }]), '/api/il/observability/receivers?targets=vessels:0.5');
});

test('a satellite is near 90° elevation over its own ground point and below the horizon opposite', () => {
  const iss = {
    tle_line1: '1 25544U 98067A   26293.50000000  .00016717  00000+0  30186-3 0  9991',
    tle_line2: '2 25544  51.6400 120.0000 0005000  90.0000 270.0000 15.49000000400000',
  };
  const now = Date.UTC(2026, 9, 20, 12) / 1000;
  const sub = satellitePosition(iss, now);
  const ecf = satelliteEcf(iss, now);
  assert.ok(elevationDeg(ecf, sub.lat, sub.lon) > 85);
  assert.ok(elevationDeg(ecf, -sub.lat, sub.lon + 180) < 0);
  assert.equal(elevationDeg(null, 0, 0), null);
  assert.equal(satelliteEcf({}, now), null);
});
