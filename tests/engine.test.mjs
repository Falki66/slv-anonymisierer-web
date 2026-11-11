// Prüft die Muster-Erkennung gegen die Referenzergebnisse der Python-Originalversion.
// Aufruf: npm test
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { detect, Mapping, buildReplacements, applyText, restoreText } from '../src/engine.js';

const dir = new URL('./fixtures/', import.meta.url);
const text = readFileSync(new URL('korpus.txt', dir), 'utf8');
const expected = JSON.parse(readFileSync(new URL('korpus.expected.json', dir), 'utf8'));

const hits = detect(text);
assert.deepEqual(hits.map((h) => [h.start, h.end, h.category, h.value]), expected);

// Hin und zurück: Platzhalter einsetzen und wiederherstellen ergibt den Originaltext.
for (const numbered of [true, false]) {
  const mapping = new Mapping({ numbered });
  const anon = applyText(text, buildReplacements(hits, mapping), mapping);
  assert.ok(!anon.includes('Schmidt-Weber'));
  assert.equal(restoreText(anon, Mapping.fromDict(JSON.parse(JSON.stringify(mapping.toDict())))), text);
}
console.log(`OK: ${hits.length} Treffer wie im Original, Rück-Ersetzung verlustfrei.`);
