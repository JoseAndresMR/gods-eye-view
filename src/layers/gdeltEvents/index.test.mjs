import assert from 'node:assert/strict';
import test from 'node:test';
import { createGdeltEventsSource } from './source.js';
import { eventPixelSize } from './index.js';

test('marker size follows fatalities, then mentions, with a floor', () => {
  assert.equal(eventPixelSize({ fatalities: 0, mentions: null }), 6);
  assert.ok(eventPixelSize({ fatalities: 75 }) > eventPixelSize({ fatalities: 2 }));
  assert.ok(eventPixelSize({ fatalities: 1e9 }) <= 16);
  assert.ok(eventPixelSize({ mentions: 64 }) > eventPixelSize({ mentions: 2 }));
  assert.ok(eventPixelSize({ mentions: 1e9 }) <= 10);
});

test('the source asks the local proxy and honours the free-feed switch', async () => {
  const urls = [];
  const source = createGdeltEventsSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    },
  });
  await source.getSnapshot({ includeFree: false });
  await source.getSnapshot();
  assert.deepEqual(urls, ['/api/gdelt-events?free=0', '/api/gdelt-events?free=1']);
});

test('the source rejects HTTP errors and malformed bodies', async () => {
  const bad = (status, body) =>
    createGdeltEventsSource({
      fetchImpl: async () => new Response(JSON.stringify(body), { status }),
    }).getSnapshot();
  await assert.rejects(bad(502, {}), /HTTP 502/);
  await assert.rejects(bad(200, { nope: true }), /Malformed/);
});
