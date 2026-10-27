import test from 'node:test';
import assert from 'node:assert/strict';
import { coreBucket, nodeSprite, rgbOf, shade, spriteBillboard, spriteSpec } from './sprites.js';

test('core sizes are bucketed to even pixels within bounds', () => {
  assert.equal(coreBucket(11.9), 12);
  assert.equal(coreBucket(12.9), 12);
  assert.equal(coreBucket(1), 4);
  assert.equal(coreBucket(400), 40);
  assert.equal(coreBucket(NaN), 8);
});

test('one sprite key per style, colour, state and size bucket', () => {
  const a = spriteSpec({ css: '#33D6FF', style: 'node', corePx: 11.9 });
  const b = spriteSpec({ css: '#33d6ff ', style: 'node', corePx: 12.4 });
  assert.equal(a.key, b.key);
  assert.equal(a.key, 'node|#33d6ff|0|12');
  assert.notEqual(spriteSpec({ css: '#33d6ff', corePx: 12, selected: true }).key, a.key);
  assert.notEqual(spriteSpec({ css: '#33d6ff', corePx: 12, style: 'member' }).key, a.key);
  assert.equal(spriteSpec({ css: '#33d6ff', corePx: 12, style: 'bogus' }).key, a.key);
});

test('sprites leave room for the glow, more when selected', () => {
  const plain = spriteSpec({ css: '#fff', corePx: 12 });
  const selected = spriteSpec({ css: '#fff', corePx: 12, selected: true });
  assert.ok(plain.size > plain.core * 2 && plain.size % 2 === 0);
  assert.ok(selected.core > plain.core && selected.size > plain.size);
});

test('colour helpers', () => {
  assert.deepEqual(rgbOf('#ff8000'), [255, 128, 0]);
  assert.deepEqual(rgbOf('#fff'), [255, 255, 255]);
  assert.deepEqual(rgbOf('red'), [0, 212, 255]);
  assert.deepEqual(shade([100, 0, 200], 0.5), [178, 128, 228]);
  assert.deepEqual(shade([100, 0, 200], -0.5), [50, 0, 100]);
});

test('without a canvas there is no image, but the size is still set', () => {
  assert.equal(nodeSprite({ css: '#fff', corePx: 12 }), null);
  assert.deepEqual(spriteBillboard({ css: '#fff', corePx: 12 }), { width: 28, height: 28 });
});
