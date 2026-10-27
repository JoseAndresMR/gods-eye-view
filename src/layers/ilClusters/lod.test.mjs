import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOD_FULL_PX,
  LOD_HIDE_PX,
  LOD_SHOW_PX,
  hullExtentM,
  hullPoints,
  lodAlpha,
  lodShown,
  markerDim,
  pixelsAcross,
  usableHull,
} from './lod.js';

test('hull points drop repeats and junk', () => {
  assert.deepEqual(hullPoints([[1, 2], [1, 2], [3, 4], null, [NaN, 1], [5, 6]]), [[1, 2], [3, 4], [5, 6]]);
  assert.deepEqual(hullPoints(null), []);
});

test('hull extent in metres, also across the antimeridian', () => {
  const oneDegLat = hullExtentM([[10, 0], [10, 1]]);
  assert.ok(Math.abs(oneDegLat - 111320) < 1);
  const across = hullExtentM([[179.5, 0], [-179.5, 0]]);
  assert.ok(Math.abs(across - 111320) < 1, String(across));
});

test('only real polygons: three members and three distinct points', () => {
  assert.equal(usableHull([[0, 0], [1, 0], [0, 1]], 2), null);
  assert.equal(usableHull([[0, 0], [1, 0], [1, 0]], 5), null);
  assert.ok(usableHull([[0, 0], [1, 0], [0, 1]], 3).extentM > 0);
});

test('screen size scales with distance and viewport', () => {
  const near = pixelsAcross(10000, 50000, Math.PI / 3, 900);
  const far = pixelsAcross(10000, 500000, Math.PI / 3, 900);
  assert.ok(Math.abs(near / far - 10) < 1e-9);
  assert.equal(pixelsAcross(10000, 0, 1, 900), 0);
});

test('hysteresis: shows above SHOW, hides only below HIDE', () => {
  const mid = (LOD_SHOW_PX + LOD_HIDE_PX) / 2;
  assert.equal(lodShown(mid, false), false);
  assert.equal(lodShown(mid, true), true);
  assert.equal(lodShown(LOD_HIDE_PX - 1, true), false);
  assert.equal(lodShown(LOD_SHOW_PX, false), true);
});

test('fades in by size; the node shrinks and dims, never vanishes', () => {
  assert.equal(lodAlpha(LOD_HIDE_PX), 0);
  assert.equal(lodAlpha(LOD_FULL_PX * 2), 1);
  assert.ok(lodAlpha(LOD_SHOW_PX) > 0 && lodAlpha(LOD_SHOW_PX) < 1);
  assert.deepEqual(markerDim(0), { scale: 1, alpha: 1 });
  const full = markerDim(1);
  assert.ok(full.scale > 0.5 && full.alpha > 0.5 && full.scale < 1);
});
