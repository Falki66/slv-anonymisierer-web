// Word (.docx): Text erkennen und Platzhalter einsetzen – ohne Formatierung zu verändern.
// Die Ersetzung erfolgt auf Ebene der Textelemente (w:t). Der Platzhalter erbt damit die
// Formatierung (Schrift, Größe, Fett …) des ersten ersetzten Zeichens; alles andere bleibt unangetastet.
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { findSpans, findPlaceholders, recordUse, restorer } from '../engine.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
// Hauptteil, Kopf-/Fußzeilen, Fußnoten, Endnoten, Kommentare
const TEXT_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/;

async function loadParts(data) {
  const zip = await JSZip.loadAsync(data);
  const names = Object.keys(zip.files).filter((n) => TEXT_PART.test(n))
    .sort((a, b) => (a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b)));
  const parts = [];
  for (const name of names) {
    const xml = await zip.file(name).async('string');
    parts.push({ name, doc: new DOMParser().parseFromString(xml, 'application/xml') });
  }
  if (!parts.length) throw new Error('Die Datei enthält kein Word-Dokument.');
  return { zip, parts };
}

// Absätze mit ihren eigenen w:t-Elementen (verschachtelte Absätze, z. B. in Textfeldern, zählen separat).
function* paragraphs(parts) {
  for (const { doc } of parts) {
    for (const p of doc.getElementsByTagNameNS(W_NS, 'p')) {
      const ts = [...p.getElementsByTagNameNS(W_NS, 't')].filter((t) => closestParagraph(t) === p);
      yield { ts, text: ts.map((t) => t.textContent).join('') };
    }
  }
}

function closestParagraph(el) {
  let n = el.parentNode;
  while (n && !(n.localName === 'p' && n.namespaceURI === W_NS)) n = n.parentNode;
  return n;
}

export async function extractText(data) {
  const { parts } = await loadParts(data);
  return [...paragraphs(parts)].map((p) => p.text).join('\n');
}

// Ersetzt Zeichenbereiche [s,e) durch Text; verteilt auf die betroffenen w:t-Elemente.
function applySpans(ts, spans) {
  const chars = ts.flatMap((t) => [...t.textContent]);
  const lens = ts.map((t) => [...t.textContent].length);
  const total = chars.length;
  const out = [...chars];
  for (const [s, e, rep] of spans) {
    if (s >= total) continue;
    out[s] = rep;
    for (let i = s + 1; i < Math.min(e, total); i++) out[i] = '';
  }
  let pos = 0;
  ts.forEach((t, k) => {
    const neu = out.slice(pos, pos + lens[k]).join('');
    pos += lens[k];
    if (neu !== t.textContent) {
      t.textContent = neu;
      t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
    }
  });
}

// Zeichenpositionen aus JavaScript (UTF-16) in Positionen der Zeichenliste (Codepoints) umrechnen.
function toCodepointSpans(text, spans) {
  const map = [];
  let cp = 0;
  for (let i = 0; i < text.length; i++) {
    map[i] = cp;
    const c = text.codePointAt(i);
    if (c > 0xffff) { i++; map[i] = cp; }
    cp++;
  }
  map[text.length] = cp;
  return spans.map(([s, e, r]) => [map[s], map[e], r]);
}

async function save(zip, parts) {
  const ser = new XMLSerializer();
  for (const { name, doc } of parts) zip.file(name, ser.serializeToString(doc));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function anonymize(data, rep, mapping, stripMetadata = true) {
  const { zip, parts } = await loadParts(data);
  for (const { ts, text } of paragraphs(parts)) {
    if (!text) continue;
    const spans = findSpans(text, rep);
    if (!spans.length) continue;
    for (const [s, e, ph] of spans) recordUse(mapping, ph, text.slice(s, e));
    applySpans(ts, toCodepointSpans(text, spans));
  }
  if (stripMetadata) await stripMeta(zip);
  return save(zip, parts);
}

export async function restore(data, mapping) {
  const get = restorer(mapping);
  const { zip, parts } = await loadParts(data);
  for (const { ts, text } of paragraphs(parts)) {
    if (!text) continue;
    const found = findPlaceholders(text);
    if (!found.length) continue;
    applySpans(ts, toCodepointSpans(text, found.map(([s, e, ph]) => [s, e, get(ph)])));
  }
  return save(zip, parts);
}

// Autor, Titel, Betreff usw. leeren (docProps/core.xml).
async function stripMeta(zip) {
  const f = zip.file('docProps/core.xml');
  if (!f) return;
  const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
  for (const tag of ['creator', 'lastModifiedBy', 'title', 'subject', 'keywords', 'description', 'category', 'contentStatus']) {
    for (const el of doc.getElementsByTagNameNS('*', tag)) el.textContent = '';
  }
  zip.file('docProps/core.xml', new XMLSerializer().serializeToString(doc));
}
