// Word-Verarbeitung: Erkennen, Anonymisieren (Formatierung bleibt), Metadaten entfernen, Wiederherstellen.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { detect, Mapping, buildReplacements } from '../src/engine.js';
import { extractText, anonymize, restore } from '../src/formats/docx.js';

const data = readFileSync(new URL('./fixtures/beispiel.docx', import.meta.url));
const text = await extractText(data);
assert.ok(text.includes('Herr Max Müller, geb.'), 'Text über mehrere Formatierungsläufe');
assert.ok(text.includes('Tel.: 0351 83922-0'), 'Kopfzeile');

const hits = detect(text);
const mapping = new Mapping();
const out = await anonymize(data, buildReplacements(hits, mapping), mapping, true);
const anonText = await extractText(out);
for (const secret of ['Müller', 'Schmidt-Weber', '123456', 'DE89', 'example.de', '83922']) {
  assert.ok(!anonText.includes(secret), `"${secret}" wurde entfernt`);
}
assert.ok(anonText.includes('[NAME-1]'));
const core = await (await JSZip.loadAsync(out)).file('docProps/core.xml').async('string');
assert.ok(!core.includes('Müller'), 'Metadaten entfernt');
const docXml = await (await JSZip.loadAsync(out)).file('word/document.xml').async('string');
assert.match(docXml, /<w:b\/>.*?\[NAME-1\]/s, 'Platzhalter erbt Fettdruck des ersten Zeichens');

const back = await restore(out, Mapping.fromDict(JSON.parse(JSON.stringify(mapping.toDict()))));
assert.equal(await extractText(back), text);
console.log(`OK: Word – ${hits.length} Treffer ersetzt, Metadaten leer, Wiederherstellung verlustfrei.`);
