import test from 'node:test';
import assert from 'node:assert/strict';
import { intelligenceLayerPath } from './intelligenceLayer.js';

test('index, per-distance and box reads are allowed for each kind', () => {
  assert.equal(intelligenceLayerPath('GET', '/aircraft/index'), '/api/aircraft/index');
  assert.equal(intelligenceLayerPath('GET', '/aircraft?km=20'), '/api/aircraft?km=20');
  assert.equal(intelligenceLayerPath('GET', '/vessels?km=0.25'), '/api/vessels?km=0.25');
  assert.equal(intelligenceLayerPath('GET', '/military?km=20'), '/api/military?km=20');
  assert.equal(intelligenceLayerPath('GET', '/satellites/index'), '/api/satellites/index');
  assert.equal(intelligenceLayerPath('GET', '/gnss?km=100'), '/api/gnss?km=100');
  assert.equal(
    intelligenceLayerPath('GET', '/fires?km=2&bbox=110,-40.123456,155,-10'),
    '/api/fires?km=2&bbox=110,-40.1235,155,-10',
  );
  // West greater than east crosses the antimeridian.
  assert.equal(intelligenceLayerPath('GET', '/vessels?km=1&bbox=170,-5,-170,5'), '/api/vessels?km=1&bbox=170,-5,-170,5');
});

test('areas can be read and saved, nothing else written', () => {
  assert.equal(intelligenceLayerPath('GET', '/areas'), '/api/areas');
  assert.equal(intelligenceLayerPath('PUT', '/areas'), '/api/areas');
  assert.equal(intelligenceLayerPath('DELETE', '/areas'), null);
  assert.equal(intelligenceLayerPath('PUT', '/aircraft/index'), null);
  assert.equal(intelligenceLayerPath('POST', '/aircraft?km=20'), null);
});

test('anything else is refused', () => {
  for (const url of [
    '/aircraft',
    '/aircraft?km=0',
    '/aircraft?km=0.0',
    '/aircraft?km=-5',
    '/aircraft?km=05',
    '/aircraft?km=20km',
    '/aircraft?km=../tracking',
    '/aircraft?km=1/../../etc/passwd',
    '/aircraft?km=12345',
    '/aircraft?km=20&bbox=1,2,3',
    '/aircraft?km=20&bbox=0,10,5,5',
    '/aircraft?km=20&bbox=0,0,200,5',
    '/aircraft?km=20&bbox=a,b,c,d',
    '/vessels?km=.5',
    '/tracking',
    '/ships/index',
    '/aircraft/index/x',
    '/aircraft/other',
    '/areas/x',
    '/',
  ]) {
    assert.equal(intelligenceLayerPath('GET', url), null, url);
  }
});

test('observability reads only allowlisted fixed-site targets', () => {
  assert.equal(
    intelligenceLayerPath('GET', '/observability?targets=dams:10,military-areas:2&bbox=-10,35,5,45'),
    '/api/observability?targets=dams:10,military-areas:2&bbox=-10,35,5,45',
  );
  assert.equal(intelligenceLayerPath('GET', '/observability'), '/api/observability?targets=');
  assert.equal(intelligenceLayerPath('GET', '/observability?targets=cameras:1'), null);
  assert.equal(intelligenceLayerPath('GET', '/observability?targets=dams:x'), null);
  assert.equal(intelligenceLayerPath('GET', '/observability?targets=dams:10:1'), null);
  assert.equal(intelligenceLayerPath('GET', '/observability?targets=dams:10&bbox=nope'), null);
  assert.equal(intelligenceLayerPath('PUT', '/observability?targets=dams:10'), null);
  assert.equal(intelligenceLayerPath('GET', '/observability/x'), null);
});
