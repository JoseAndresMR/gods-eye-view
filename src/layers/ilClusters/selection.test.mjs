import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSelection,
  clusterPickId,
  getSelection,
  isClusterSelected,
  isSatelliteSelected,
  satellitePickId,
  select,
  selectionAfterClick,
  selectionFromPickId,
  subscribeSelection,
} from './selection.js';

test('pick ids round-trip to selections, other ids are not IL nodes', () => {
  assert.deepEqual(selectionFromPickId(clusterPickId('il-dam-clusters', 'C1a2b3c4')),
    { type: 'cluster', layerId: 'il-dam-clusters', clusterId: 'C1a2b3c4' });
  assert.deepEqual(selectionFromPickId(clusterPickId('il-dam-clusters', 'C1a2b3c4-2')).clusterId, 'C1a2b3c4-2');
  assert.deepEqual(selectionFromPickId(satellitePickId('43013')), { type: 'satellite', satId: '43013' });
  assert.equal(selectionFromPickId('25544'), null);
  assert.equal(selectionFromPickId(null), null);
  assert.equal(selectionFromPickId('il-node|onlylayer'), null);
});

test('one selection at a time, listeners told only of changes', () => {
  const seen = [];
  const unsubscribe = subscribeSelection((s) => seen.push(s));
  select({ type: 'cluster', layerId: 'L', clusterId: 'C1' });
  select({ type: 'cluster', layerId: 'L', clusterId: 'C1' }); // same: no news
  assert.ok(isClusterSelected('L', 'C1') && !isClusterSelected('L', 'C2'));
  select({ type: 'satellite', satId: '7' });
  assert.ok(isSatelliteSelected(7) && !isClusterSelected('L', 'C1'));
  clearSelection();
  assert.equal(getSelection(), null);
  unsubscribe();
  select({ type: 'satellite', satId: '8' });
  clearSelection();
  assert.deepEqual(seen, [
    { type: 'cluster', layerId: 'L', clusterId: 'C1' },
    { type: 'satellite', satId: '7' },
    null,
  ]);
});

test('a click selects an IL node and clears on anything else', () => {
  assert.deepEqual(selectionAfterClick(clusterPickId('L', 'C9')), { type: 'cluster', layerId: 'L', clusterId: 'C9' });
  assert.deepEqual(selectionAfterClick(satellitePickId('7')), { type: 'satellite', satId: '7' });
  // Empty globe, a photoreal tile (no id), another GEV layer's object.
  assert.equal(selectionAfterClick(null), null);
  assert.equal(selectionAfterClick('a1b2c3'), null);
});
