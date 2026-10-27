import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY, readSectionState, sectionOpen, writeSectionState } from './intelSections.js';

const memory = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); }, data };
};

test('a section follows its content until the user chooses', () => {
  assert.equal(sectionOpen(undefined, 0), false);
  assert.equal(sectionOpen(undefined, 2), true);
  assert.equal(sectionOpen(false, 2), false);
  assert.equal(sectionOpen(true, 0), true);
});

test('choices round-trip through storage; bad or missing storage reads as none', () => {
  const store = memory();
  assert.ok(writeSectionState({ cross: true, areas: false }, store));
  assert.deepEqual(readSectionState(store), { cross: true, areas: false });
  assert.deepEqual(readSectionState(memory({ [STORAGE_KEY]: '{not json' })), {});
  assert.deepEqual(readSectionState(memory({ [STORAGE_KEY]: '[1]' })), {});
  assert.deepEqual(readSectionState(memory({ [STORAGE_KEY]: '{"a":1,"b":true}' })), { b: true });
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readSectionState(throwing), {});
  assert.equal(writeSectionState({ a: true }, throwing), false);
  assert.deepEqual(readSectionState(null), {});
});
