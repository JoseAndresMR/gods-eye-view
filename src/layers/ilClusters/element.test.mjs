import test from 'node:test';
import assert from 'node:assert/strict';
import { ELEMENT_OWNERS, elementFields, elementTitle, matchFireRecord, openInGev, ownerElementId } from './element.js';

test('each feed opens its element in the GEV layer that owns it, by that layer\'s id', () => {
  assert.equal(ELEMENT_OWNERS.aircraft.layerId, 'flights');
  assert.equal(ELEMENT_OWNERS.vessels.method, 'selectById');
  assert.equal(ownerElementId('military', { id: 'x', hex: 'ae0944' }), 'ae0944');
  assert.equal(ownerElementId('events', { id: 'ef9d', ref: 'gdelt-cloud:conflict_1' }), 'gdelt-cloud:conflict_1');
  assert.equal(ownerElementId('satellites', { id: '10114', norad_id: '10114' }), '10114');
  assert.equal(ownerElementId('vessels', { id: 203999443 }), '203999443');
  assert.equal(ELEMENT_OWNERS.fires, undefined);
});

test('titles prefer the feed name, then the id', () => {
  assert.equal(elementTitle('military', { hex: 'ae0944', flight: 'WAYLN67 ' }), 'WAYLN67');
  assert.equal(elementTitle('dams', { id: '-1', name: 'Dam A' }), 'Dam A');
  assert.equal(elementTitle('events', { id: 'ef9d', place: 'Al-Alam camp' }), 'Al-Alam camp');
  assert.equal(elementTitle('fires', { id: '9abec1b4a8e0' }), '9abec1b4a8e0');
});

test('fields leave out graph bookkeeping and format times and positions', () => {
  const fields = Object.fromEntries(elementFields({
    id: '3c5ee9', lat: 48.3637, lon: 11.7795, alt_m: 502.92, cluster_id: 'C1', degree: 2, component: 1,
    velocity: 62.66, time_position: 1793128201, sources: ['a', 'b'], nested: { x: 1 }, empty: '',
  }));
  assert.equal(fields.cluster_id, undefined);
  assert.equal(fields.degree, undefined);
  assert.equal(fields.nested, undefined);
  assert.equal(fields.empty, undefined);
  assert.equal(fields.velocity, '62.66');
  assert.match(fields.time_position, /^2026-10-27T/);
  assert.equal(fields.sources, 'a, b');
  assert.equal(fields.position, '48.36370, 11.77950');
  assert.equal(fields.alt_m, '503');
});

test('opening in GEV: off, missing API, not listed, opened', () => {
  const node = { id: '3c5ee9' };
  assert.equal(openInGev(null, 'fires', node).reason, 'none');
  const calls = [];
  const dm = (enabled, module) => ({ isEnabled: () => enabled, layers: new Map([['flights', { module }]]) });
  assert.equal(openInGev(dm(false, {}), 'aircraft', node).reason, 'off');
  assert.equal(openInGev(dm(true, {}), 'aircraft', node).reason, 'missing');
  assert.equal(openInGev(dm(true, { trackById: () => false }), 'aircraft', node).reason, 'not-found');
  const opened = openInGev(dm(true, { trackById: (...a) => calls.push(a) > 0 }), 'aircraft', node);
  assert.deepEqual(opened, { layerId: 'flights', opened: true, reason: null });
  assert.equal(calls[0][0], '3c5ee9');
  const thrower = openInGev(dm(true, { trackById: () => { throw new Error('x'); } }), 'aircraft', node);
  assert.equal(thrower.opened, false);
});

test('a fire member matches the nearest FIRMS record within ~50 m', () => {
  const records = [{ lat: 1, lon: 1, frp: 5 }, { lat: 1.0002, lon: 1.0001, frp: 9 }, { lat: 2, lon: 2 }];
  assert.equal(matchFireRecord(records, { lat: 1.00021, lon: 1.0001 }).frp, 9);
  assert.equal(matchFireRecord(records, { lat: 1.5, lon: 1.5 }), null);
  assert.equal(matchFireRecord(null, { lat: 1, lon: 1 }), null);
});
