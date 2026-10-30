// Fork (intelligence layer): IL strings get English and Spanish only, so
// every catalog except es may lack them (il-messages.json lists them, and
// catalog.test.mjs allows exactly those gaps). Here: the list stays honest,
// and a missing IL entry shows English at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractMessages, readCatalog } from '../../scripts/i18n.mjs';
import { setLocale, t, tn } from './index.js';
import IL_MESSAGES from './il-messages.json' with { type: 'json' };

const messages = extractMessages();
const english = (text) => text.slice(text.indexOf('|') + 1);

test('every listed IL message is used by the code and translated into es', () => {
  const es = readCatalog('es');
  assert.deepEqual(
    IL_MESSAGES.filter(
      (text) => !messages.has(text) || !Object.hasOwn(es, text),
    ),
    [],
  );
});

test('an IL message missing from a catalog shows English', () => {
  const de = readCatalog('de');
  const missing = IL_MESSAGES.filter((text) => !Object.hasOwn(de, text));
  assert.ok(missing.length > 0, 'de has every IL message: pick another locale');
  setLocale('de');
  try {
    for (const text of missing) {
      const info = messages.get(text);
      if (info.plural) {
        const raw = { count: '{count}' };
        assert.equal(tn(1, info.one, text, raw), info.one);
        assert.equal(tn(2, info.one, text, raw), text);
      } else {
        const bar = text.indexOf('|');
        const shown =
          bar < 0 ? t(text) : t(english(text), { context: text.slice(0, bar) });
        assert.equal(shown, english(text));
      }
    }
  } finally {
    setLocale('en');
  }
});
