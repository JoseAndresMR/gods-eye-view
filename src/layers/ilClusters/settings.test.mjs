import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, SETTINGS_FEEDS, loadSettings, loneClusters, loneDefaultFor, loneEffective,
  saveSettings, setLoneDefault, setLoneOverride,
} from './settings.js';
import { IL_LAYER_IDS } from './model.js';

test('a missing section means lone members are on', () => {
  assert.deepEqual(loneClusters({}), { default: true, overrides: {} });
  assert.equal(loneEffective({}, 'vessels'), true);
  assert.equal(loneEffective(DEFAULT_SETTINGS, 'vessels'), true);
});

test('an override beats the default; removing it follows the default again', () => {
  let doc = setLoneOverride({}, 'vessels', false);
  assert.equal(loneEffective(doc, 'vessels'), false);
  assert.equal(loneEffective(doc, 'fires'), true);
  doc = setLoneDefault(doc, false);
  assert.equal(loneEffective(doc, 'fires'), false);
  assert.equal(loneEffective(doc, 'vessels'), false);
  doc = setLoneOverride(doc, 'fires', true);
  assert.equal(loneEffective(doc, 'fires'), true);
  doc = setLoneOverride(doc, 'vessels', null);
  assert.deepEqual(doc.lone_clusters.overrides, { fires: true });
});

test('unknown keys survive every edit', () => {
  const doc = { future: { a: 1 }, lone_clusters: { default: true, overrides: { x: false }, extra: 7 } };
  for (const next of [setLoneDefault(doc, false), setLoneOverride(doc, 'fires', true), setLoneOverride(doc, 'x', null)]) {
    assert.deepEqual(next.future, { a: 1 });
    assert.equal(next.lone_clusters.extra, 7);
  }
  assert.deepEqual(doc.lone_clusters.overrides, { x: false });
});

test('every feed switch belongs to an IL cluster layer', () => {
  for (const [, id] of SETTINGS_FEEDS) assert.ok(IL_LAYER_IDS.includes(id), id);
  assert.equal(new Set(SETTINGS_FEEDS.map(([k]) => k)).size, SETTINGS_FEEDS.length);
});

test('loads and saves the whole document through the GEV route', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([url, init.method || 'GET']);
    if (init.method === 'PUT' && init.body.includes('bad')) return new Response('{"error":"nope"}', { status: 400 });
    return new Response(init.body || JSON.stringify(DEFAULT_SETTINGS), { status: 200 });
  };
  assert.deepEqual(await loadSettings(fetchImpl), DEFAULT_SETTINGS);
  const doc = setLoneDefault({ keep: 1 }, false);
  assert.deepEqual(await saveSettings(doc, fetchImpl), doc);
  await assert.rejects(saveSettings({ bad: 1 }, fetchImpl), /nope/);
  assert.deepEqual(calls.map((c) => c[0]), Array(3).fill('/api/il/settings'));
});

test('the built-in per-feed defaults apply only while the global switch is on', () => {
  const doc = { lone_clusters: { default: true, overrides: {} }, defaults: { lone_clusters: { fires: false, aircraft: true } } };
  assert.equal(loneDefaultFor(doc, 'fires'), false);
  assert.equal(loneDefaultFor(doc, 'aircraft'), true);
  assert.equal(loneDefaultFor(doc, 'unknown-kind'), true);
  assert.equal(loneEffective(setLoneOverride(doc, 'fires', true), 'fires'), true);
  const off = setLoneDefault(doc, false);
  assert.equal(loneDefaultFor(off, 'aircraft'), false);
  assert.equal(loneEffective(off, 'aircraft'), false);
  assert.equal(loneEffective(setLoneOverride(off, 'aircraft', true), 'aircraft'), true);
});

test('saving does not send the read-only defaults', async () => {
  let sent;
  const fetchImpl = async (url, init) => { sent = JSON.parse(init.body); return new Response(init.body, { status: 200 }); };
  await saveSettings({ keep: 1, defaults: { lone_clusters: { fires: false } }, lone_clusters: { default: true, overrides: {} } }, fetchImpl);
  assert.deepEqual(Object.keys(sent).sort(), ['keep', 'lone_clusters']);
});
