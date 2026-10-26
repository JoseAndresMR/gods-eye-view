import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { gdeltEventsProxy } from '../../server/providers/gdeltEvents.js';

const NOW = Date.parse('2026-10-26T12:07:00Z');

function zip(name, text) {
  const raw = Buffer.from(text);
  const data = deflateRawSync(raw);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(n.length, 28);
  cd.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + n.length, 12);
  eocd.writeUInt32LE(30 + n.length + data.length, 16);
  return Buffer.concat([local, n, data, cd, n, eocd]);
}

function exportLine(over = {}) {
  const c = new Array(61).fill('');
  Object.assign(
    c,
    {
      1: '20261026',
      26: '190',
      28: '19',
      31: '4',
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

const cloudBody = {
  success: true,
  data: [
    {
      id: 'conflict_1',
      category: 'Battles',
      title: 'Clash',
      event_date: '2026-10-26',
      geo: {
        latitude: 12.79,
        longitude: 45.05,
        location: 'Aden',
        geo_precision: 1,
      },
      primary_story_url: 'https://gdeltcloud.com/stories/1',
    },
  ],
};

async function harness({
  key = 'k',
  cloudStatus = 200,
  missingSlots = 'none',
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gdelt-'));
  const calls = { cloud: 0, slots: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://gdeltcloud.com/')) {
      calls.cloud++;
      assert.equal(init.headers.Authorization, `Bearer ${key}`);
      return new Response(JSON.stringify(cloudBody), { status: cloudStatus });
    }
    const id = /(\d{14})\.export/.exec(u)[1];
    calls.slots.push(id);
    if (missingSlots === 'all') return new Response('', { status: 404 });
    return new Response(zip(`${id}.export.CSV`, exportLine()), { status: 200 });
  };
  const plugin = gdeltEventsProxy({
    env: key ? { GDELT_API_KEY: key } : {},
    fetchImpl,
    now: () => NOW,
    cacheDir: dir,
  });
  let handler;
  plugin.configureServer({
    middlewares: {
      use(mount, cb) {
        assert.equal(mount, '/api/gdelt-events');
        handler = cb;
      },
    },
  });
  const get = async (url) => {
    let status;
    let body;
    await handler(
      { method: 'GET', url },
      {
        headersSent: false,
        writeHead(s) {
          status = s;
        },
        end(b) {
          body = JSON.parse(b);
        },
      },
    );
    return { status, body };
  };
  return {
    get,
    calls,
    dir,
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

test('serves cloud and free events, merged, and spends one cloud call', async () => {
  const h = await harness();
  try {
    const { status, body } = await h.get('/');
    assert.equal(status, 200);
    assert.equal(h.calls.cloud, 1);
    assert.equal(body.cloud.status, 'ready');
    assert.equal(body.cloud.budget.used, 1);
    assert.ok(body.free.slots > 0);
    // Cloud 'Battles' and the CAMEO 19 aggregate sit within 10 km: one marker.
    const merged = body.events.find((e) => e.merged.length);
    assert.deepEqual(merged.sources, ['gdelt-cloud', 'gdelt-project']);
    const again = await h.get('/');
    assert.equal(again.status, 200);
    assert.equal(h.calls.cloud, 1, 'second request served from cache');
    const saved = JSON.parse(
      await readFile(path.join(h.dir, 'gdelt-cloud.json'), 'utf8'),
    );
    assert.equal(saved.usage.calls, 1);
  } finally {
    await h.done();
  }
});

test('free=0 leaves the free feed out and never fetches it', async () => {
  const h = await harness();
  try {
    const { body } = await h.get('/?free=0');
    assert.equal(h.calls.slots.length, 0);
    assert.equal(body.free.enabled, false);
    assert.ok(
      body.events.every((e) => e.sources.every((s) => s === 'gdelt-cloud')),
    );
  } finally {
    await h.done();
  }
});

test('without a key the free feed still works and cloud is no_key', async () => {
  const h = await harness({ key: '' });
  try {
    const { status, body } = await h.get('/');
    assert.equal(status, 200);
    assert.equal(body.cloud.status, 'no_key');
    assert.equal(h.calls.cloud, 0);
    assert.ok(body.events.length > 0);
  } finally {
    await h.done();
  }
});

test('a rejected cloud call backs off and still counts against the budget', async () => {
  const h = await harness({ cloudStatus: 429 });
  try {
    const first = await h.get('/');
    assert.equal(first.status, 200);
    assert.equal(first.body.cloud.error, 'HTTP 429');
    assert.equal(first.body.cloud.budget.used, 1);
    await h.get('/');
    assert.equal(h.calls.cloud, 1, 'cooldown prevents a retry');
  } finally {
    await h.done();
  }
});

test('missing slots (404) leave the free feed empty without failing', async () => {
  const h = await harness({ key: '', missingSlots: 'all' });
  try {
    const { status, body } = await h.get('/');
    assert.equal(status, 200);
    assert.equal(body.count, 0);
  } finally {
    await h.done();
  }
});

test('status makes no upstream requests; other paths 404', async () => {
  const h = await harness();
  try {
    const { status, body } = await h.get('/status');
    assert.equal(status, 200);
    assert.equal(body.cloud.budget.cap, 45);
    assert.equal(h.calls.cloud, 0);
    assert.equal((await h.get('/nope')).status, 404);
  } finally {
    await h.done();
  }
});
