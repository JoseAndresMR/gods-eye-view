import test from 'node:test';
import assert from 'node:assert/strict';
import { intelligenceLayerFile } from './intelligenceLayer.js';

test('the index and per-distance files are allowed', () => {
  assert.equal(intelligenceLayerFile('/aircraft/index'), 'aircraft-index.json');
  assert.equal(intelligenceLayerFile('/aircraft?km=20'), 'aircraft-20km.json');
  assert.equal(intelligenceLayerFile('/aircraft?km=2.5'), 'aircraft-2.5km.json');
});

test('anything else is refused', () => {
  for (const url of [
    '/aircraft',
    '/aircraft?km=0',
    '/aircraft?km=-5',
    '/aircraft?km=05',
    '/aircraft?km=20km',
    '/aircraft?km=../tracking',
    '/aircraft?km=1/../../etc/passwd',
    '/aircraft?km=12345',
    '/tracking',
    '/aircraft/index/x',
  ]) {
    assert.equal(intelligenceLayerFile(url), null, url);
  }
});
