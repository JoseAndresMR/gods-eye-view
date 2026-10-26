import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateGdeltProject,
  mergeConflictEvents,
  normalizeGdeltCloudRows,
  parseGdeltProjectExport,
} from './conflictEvents.js';

const cloudRow = {
  id: 'conflict_abc',
  category: 'Explosions/Remote violence',
  subcategory_label: 'Shelling/artillery/missile attack',
  title: 'Missiles hit camp',
  summary: 'x',
  event_date: '2026-10-26',
  geo: {
    latitude: 14.56,
    longitude: 47.05,
    location: 'Al-Alam camp',
    country: 'Yemen',
    geo_precision: 1,
  },
  actors: [{ name: 'Ansar Allah' }],
  fatalities: 75,
  primary_story_url: 'https://gdeltcloud.com/stories/x',
  metrics: { article_count: 3 },
};

test('normalizes GDELT Cloud rows and rejects non-http links', () => {
  const [ok, bad] = normalizeGdeltCloudRows([
    cloudRow,
    {
      ...cloudRow,
      id: 'b',
      primary_story_url: 'javascript:alert(1)',
      url: 'ftp://x',
    },
  ]);
  assert.equal(ok.url, 'https://gdeltcloud.com/stories/x');
  assert.equal(bad.url, null);
});

function gdeltLine(over = {}) {
  const c = new Array(61).fill('');
  Object.assign(
    c,
    {
      1: '20261026',
      26: '190',
      28: '19',
      30: '-10',
      31: '4',
      34: '-5',
      51: '4',
      52: 'Aden, Yemen',
      53: 'YM',
      56: '12.78',
      57: '45.04',
      60: 'https://example.org/a',
    },
    over,
  );
  return c.join('\t');
}

test('parses the free GDELT export and aggregates per place and day', () => {
  const body = [
    gdeltLine(),
    gdeltLine({ 31: '10', 60: 'https://example.org/top' }),
    gdeltLine({ 28: '03' }), // not a conflict root
    gdeltLine({ 51: '1' }), // country centroid
    gdeltLine({ 56: '' }), // no coordinates
    'short\tline',
  ].join('\n');
  const raw = parseGdeltProjectExport(body);
  assert.equal(raw.length, 2);
  const [event] = aggregateGdeltProject(raw);
  assert.equal(event.source, 'gdelt-project');
  assert.equal(event.family, 'battles');
  assert.equal(event.mentions, 14);
  assert.equal(event.url, 'https://example.org/top');
});

test('merges same-family events from different sources only', () => {
  const [c] = normalizeGdeltCloudRows([cloudRow]);
  const project = {
    ...c,
    id: 'gdelt-project:x',
    source: 'gdelt-project',
    lat: c.lat + 0.01,
    dateMs: c.dateMs - 86_400_000,
  };
  const far = { ...project, id: 'gdelt-project:far', lat: 30, lon: 10 };
  const otherFamily = {
    ...project,
    id: 'gdelt-project:fam',
    family: 'protests',
  };
  const sameSource = { ...c, id: 'gdelt-cloud:dupe' };
  const items = mergeConflictEvents([project, c, far, otherFamily, sameSource]);
  const merged = items.find((i) => i.merged.length > 0);
  assert.equal(merged.id, 'merged:gdelt-cloud:conflict_abc');
  assert.deepEqual(merged.sources, ['gdelt-cloud', 'gdelt-project']);
  assert.equal(items.length, 4);
  assert.equal(
    items.length + items.reduce((n, i) => n + i.merged.length, 0),
    5,
  );
});
