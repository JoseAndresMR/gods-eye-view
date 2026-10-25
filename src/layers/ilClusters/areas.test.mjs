import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AREAS,
  addArea,
  loadAreas,
  nextAreaId,
  removeArea,
  saveAreas,
  updateArea,
  validateAreaBox,
} from './areas.js';

test('area boxes may be any size but must enclose something', () => {
  assert.deepEqual(validateAreaBox({ west: -170, south: -80, east: 170, north: 80 }).box, {
    west: -170, south: -80, east: 170, north: 80,
  });
  assert.equal(validateAreaBox({ west: 1, south: 1, east: 1.001, north: 2 }).reason, 'degenerate');
  assert.equal(validateAreaBox({ west: NaN, south: 1, east: 2, north: 2 }).reason, 'invalid');
  assert.deepEqual(validateAreaBox({ west: 1.123456, south: 2, east: 3, north: 4 }).box.west, 1.1235);
});

test('areas are added, renamed, toggled and removed without touching the others', () => {
  let doc = { ...DEFAULT_AREAS };
  doc = addArea(doc, { west: 9, south: 53, east: 30, north: 66 }, 'Baltic');
  doc = addArea(doc, { west: 3, south: 51, east: 5, north: 52 }, 'Rotterdam');
  assert.deepEqual(doc.areas.map((a) => [a.id, a.name, a.enabled]), [['a1', 'Baltic', true], ['a2', 'Rotterdam', true]]);
  doc = updateArea(doc, 'a1', { enabled: false, name: 'Baltic Sea' });
  assert.deepEqual(doc.areas[0], { id: 'a1', name: 'Baltic Sea', enabled: false, west: 9, south: 53, east: 30, north: 66 });
  doc = removeArea(doc, 'a1');
  assert.equal(nextAreaId(doc.areas), 'a3');
  assert.equal(doc.global, true);
});

test('loads and saves through the GEV route, surfacing refusals', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([url, init.method || 'GET', init.body]);
    if (init.method === 'PUT' && JSON.parse(init.body).areas.length > 1)
      return new Response(JSON.stringify({ error: 'nope' }), { status: 400 });
    return new Response(init.body || JSON.stringify(DEFAULT_AREAS), { status: 200 });
  };
  assert.deepEqual(await loadAreas(fetchImpl), DEFAULT_AREAS);
  const one = addArea(DEFAULT_AREAS, { west: 0, south: 0, east: 1, north: 1 }, 'X');
  assert.deepEqual(await saveAreas(one, fetchImpl), one);
  await assert.rejects(saveAreas(addArea(one, { west: 2, south: 0, east: 3, north: 1 }, 'Y'), fetchImpl), /nope/);
  assert.deepEqual(calls.map(([url, method]) => [url, method]), [
    ['/api/il/areas', 'GET'], ['/api/il/areas', 'PUT'], ['/api/il/areas', 'PUT'],
  ]);
});
