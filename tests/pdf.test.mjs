// PDF mit Textebene: echte Redaktion (Text wirklich entfernt), Platzhalter sichtbar, Metadaten entfernt.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import { detect, Mapping, buildReplacements } from '../src/engine.js';
import { analyzePdf, anonymizePdf } from '../src/formats/pdf.js';

const data = readFileSync(new URL('./fixtures/beispiel.pdf', import.meta.url));
const noOcr = () => { throw new Error('OCR sollte nicht nötig sein'); };

for (const mode of ['platzhalter', 'schwaerzen']) {
  const pages = await analyzePdf(data, noOcr);
  assert.equal(pages[0].scanned, false);
  const text = pages.map((p) => p.text).join('\n\f\n');
  const hits = detect(text);
  const mapping = new Mapping({ mode });
  const out = anonymizePdf(data, pages, buildReplacements(hits, mapping), mapping, true);
  if (process.argv[2]) writeFileSync(`${process.argv[2]}/out-${mode}.pdf`, out);

  const doc = mupdf.Document.openDocument(out, 'application/pdf');
  const after = doc.loadPage(0).toStructuredText('preserve-whitespace').asText();
  for (const secret of ['Müller', 'Schmidt-Weber', '123456', 'DE89', 'example.de', 'Lehmann', '83922']) {
    assert.ok(!after.includes(secret), `${mode}: "${secret}" ist aus der Textebene entfernt`);
  }
  assert.ok(after.includes('Widerspruchsbescheid'), `${mode}: übriger Text bleibt erhalten`);
  if (mode === 'platzhalter') assert.ok(after.includes('[NAME-1]'), 'Platzhalter ist als Text vorhanden');
  assert.ok(!doc.getMetaData('info:Author'), 'Metadaten entfernt');
}
console.log('OK: PDF – Text echt entfernt, Platzhalter/Schwärzung gesetzt, Metadaten leer.');
