import test from 'node:test';
import assert from 'node:assert/strict';
import { imageryRequest, intelligenceLayerPath, slimGranules } from './intelligenceLayer.js';

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

test('observability reads only allowlisted relations and cluster feeds', () => {
  assert.equal(
    intelligenceLayerPath('GET', '/observability/imaging?targets=dams:10,vessels:0.5&bbox=-10,35,5,45'),
    '/api/observability/imaging?targets=dams:10,vessels:0.5&bbox=-10,35,5,45',
  );
  assert.equal(intelligenceLayerPath('GET', '/observability/navigation'), '/api/observability/navigation?targets=');
  assert.equal(intelligenceLayerPath('GET', '/observability'), null);
  assert.equal(intelligenceLayerPath('GET', '/observability/spy?targets=dams:10'), null);
  assert.equal(intelligenceLayerPath('GET', '/observability/imaging?targets=areas:1'), null);
  assert.equal(intelligenceLayerPath('GET', '/observability/imaging?targets=dams:x'), null);
  assert.equal(intelligenceLayerPath('GET', '/observability/imaging?targets=dams:10:1'), null);
  assert.equal(intelligenceLayerPath('GET', '/observability/imaging?targets=dams:10&bbox=nope'), null);
  assert.equal(intelligenceLayerPath('PUT', '/observability/imaging?targets=dams:10'), null);
  assert.equal(intelligenceLayerPath('GET', '/observability/imaging/x'), null);
});

test('imagery reads only HLS scenes over a small box and a bounded window', () => {
  const ok = imageryRequest('/imagery?product=S30&bbox=-98,30,-97,31&start=2026-10-15T00:00:00Z&end=2026-10-25T00:00:00Z');
  assert.match(ok.url, /^https:\/\/cmr\.earthdata\.nasa\.gov\/search\/granules\.umm_json\?collection_concept_id=C2021957295-LPCLOUD&bounding_box=-98,30,-97,31&temporal=2026-10-15T00:00:00.000Z,2026-10-25T00:00:00.000Z/);
  assert.equal(ok.cursor, null);
  assert.equal(imageryRequest('/imagery?product=S30&bbox=-98,30,-97,31&start=2026-10-15T00:00:00Z&end=2026-10-25T00:00:00Z&cursor=abc').cursor, 'abc');
  for (const bad of [
    '/imagery?product=MODIS&bbox=-98,30,-97,31&start=2026-10-15&end=2026-10-25',
    '/imagery?product=S30&bbox=-110,30,-97,31&start=2026-10-15&end=2026-10-25',
    '/imagery?product=S30&bbox=-98,30,-97,31&start=2026-08-01&end=2026-10-25',
    '/imagery?product=S30&bbox=-98,30,-97,31&start=2026-10-25&end=2026-10-15',
    '/imagery?product=S30&bbox=-98,30,-97,31&start=2026-10-15&end=2026-10-25&cursor=a b',
    '/imagery?product=S30&start=2026-10-15&end=2026-10-25',
    '/imagerything?product=S30&bbox=-98,30,-97,31&start=2026-10-15&end=2026-10-25',
  ]) assert.equal(imageryRequest(bad), null, bad);
});

test('CMR pages are reduced to time, cloud, platform and footprint', () => {
  const page = slimGranules({
    hits: 3,
    items: [
      {
        meta: { 'concept-id': 'G1' },
        umm: {
          GranuleUR: 'HLS.S30.T14RPU.2026297T170901.v2.0',
          TemporalExtent: { RangeDateTime: { BeginningDateTime: '2026-10-24T17:09:01Z', EndingDateTime: '2026-10-24T17:09:05Z' } },
          AdditionalAttributes: [{ Name: 'CLOUD_COVERAGE', Values: ['12'] }],
          Platforms: [{ ShortName: 'Sentinel-2B' }],
          SpatialExtent: { HorizontalSpatialDomain: { Geometry: { GPolygons: [{ Boundary: { Points: [
            { Longitude: -98, Latitude: 30 }, { Longitude: -97, Latitude: 30 }, { Longitude: -97, Latitude: 31 }, { Longitude: -98, Latitude: 30 },
          ] } }] } } },
        },
      },
      { umm: {} },
    ],
  });
  assert.equal(page.hits, 3);
  assert.deepEqual(page.items, [{
    id: 'G1', name: 'HLS.S30.T14RPU.2026297T170901.v2.0', start: '2026-10-24T17:09:01Z', end: '2026-10-24T17:09:05Z',
    cloud: 12, platforms: ['Sentinel-2B'], footprint: [[[-98, 30], [-97, 30], [-97, 31], [-98, 30]]],
  }]);
});
