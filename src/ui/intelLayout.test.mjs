import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandApplicationHtml } from '../../build/application-html.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = expandApplicationHtml(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
const panelChrome = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'panelChrome.js'), 'utf8');

/** The markup from one panel's opening tag to the opening tag of the next panel. */
const between = (from, to) => {
  const a = html.indexOf(`id="${from}"`);
  const b = html.indexOf(`id="${to}"`, a);
  assert.ok(a >= 0 && b > a, `${from} .. ${to}`);
  return html.slice(a, b);
};

const IL_HOSTS = [
  'intel-areas',
  'intel-settings',
  'intel-toggles-moving',
  'intel-toggles-events',
  'intel-toggles-hubs',
  'intel-toggles-energy',
  'intel-toggles-transport',
  'intel-toggles-digital',
  'intel-toggles-water',
  'intel-toggles-defence',
  'intel-toggles-observers',
  'intel-cross-toggles',
  'intel-ground-toggles',
];
const SECTIONS = [
  'areas', 'settings', 'single', 'moving', 'events', 'hubs', 'energy', 'transport',
  'digital', 'water', 'defence', 'observers', 'cross', 'satellites', 'ground',
];

test('every IL host is inside the left INTELLIGENCE LAYERS panel', () => {
  const left = between('intel-layers-panel', 'cctv-panel');
  const right = between('intel-panel', 'global-context-panel');
  for (const id of IL_HOSTS) {
    assert.ok(left.includes(`id="${id}"`), `${id} in the left panel`);
    assert.ok(!right.includes(`id="${id}"`), `${id} not in the right panel`);
  }
  assert.ok(left.includes('id="intel-layers-body"'));
  assert.ok(left.includes('id="intel-layers-count"'));
  assert.ok(left.includes('data-collapse-target="intel-layers-panel"'));
});

test('the cluster cards stay in the right INTELLIGENCE panel', () => {
  const left = between('intel-layers-panel', 'cctv-panel');
  const right = between('intel-panel', 'global-context-panel');
  assert.ok(right.includes('id="intel-clusters"'));
  assert.ok(!left.includes('id="intel-clusters"'));
  assert.ok(!right.includes('data-intel-section'));
});

test('the sections are exactly the existing fifteen, all in the left panel', () => {
  const left = between('intel-layers-panel', 'cctv-panel');
  const ids = [...html.matchAll(/data-intel-section="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...ids].sort(), [...SECTIONS].sort());
  const inLeft = [...left.matchAll(/data-intel-section="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(inLeft, ids);
});

test('the left panel is a left-rail panel: shared state and Cockpit collapse, not the right-rail glyphs', () => {
  assert.equal((panelChrome.match(/intel-layers-panel/g) || []).length, 2);
  const rightRail = panelChrome.slice(panelChrome.indexOf('const isRightRail'));
  assert.ok(!rightRail.slice(0, rightRail.indexOf('.includes')).includes('intel-layers-panel'));
  assert.match(html, /<div id="left-panel-stack">[\s\S]*id="intel-layers-panel"/);
});
