// Hintergrund-Prozess (Web Worker): übernimmt die Aufgaben des früheren lokalen Servers.
// Dokumente liegen nur im Arbeitsspeicher dieses Browser-Tabs und werden nach 30 Minuten
// Inaktivität, mit „Sitzung verwerfen“ oder beim Schließen des Tabs gelöscht.
import * as E from './engine.js';
import * as docx from './formats/docx.js';
import { analyzePdf, analyzeImage, anonymizePdf, anonymizeImage, IMAGE_TYPES } from './formats/pdf.js';
import { ocrImage } from './formats/ocr.js';
import { loadNer, detectEntities, MODEL_ID } from './ner/bert.js';
import { dumpKey, loadKey, isEncrypted } from './keyfile.js';

const SESSION_TTL = 30 * 60 * 1000;
const PREVIEW_MAX = 80_000; // Zeichen in der Vorschau

let session = null;
let purgeTimer = null;

function touch() {
  clearTimeout(purgeTimer);
  purgeTimer = setTimeout(() => { session = null; }, SESSION_TTL);
}

function current() {
  if (!session) throw new Error('Sitzung abgelaufen – bitte Datei erneut auswählen.');
  touch();
  return session;
}

const progress = (text, value) => self.postMessage({ type: 'progress', text, value });

// --------------------------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------------------------
const ext = (name) => (/\.[^.]+$/.exec(name)?.[0] || '').toLowerCase();
const stem = (name) => name.replace(/\.[^.]+$/, '');

function kindOf(name) {
  const e = ext(name);
  if (e === '.docx') return 'docx';
  if (['.txt', '.md', '.csv', '.log'].includes(e)) return 'txt';
  if (e === '.pdf') return 'pdf';
  if (IMAGE_TYPES[e.slice(1)]) return 'image';
  return '';
}

function decodeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

const fullText = (s) => (s.kind === 'txt' || s.kind === 'docx' ? s.text : s.pages.map((p) => p.text).join('\n\f\n'));

function enabledSet(cats) {
  return new Set(cats?.length ? cats.filter((c) => E.CATEGORIES[c]) : E.defaultCategories());
}

function parseExtras(raw) {
  return (raw || []).map((x) => ({ term: (x.term || '').trim(), category: E.CATEGORIES[x.category] ? x.category : 'MANUELL' }))
    .filter((x) => x.term);
}

function detectIn(s, categories, extras) {
  return E.detect(fullText(s), { enabled: enabledSet(categories), customTerms: parseExtras(extras), entities: s.entities });
}

function review(s, hits) {
  const text = fullText(s);
  return { findings: E.groupFindings(hits), preview: E.previewSegments(text, hits, PREVIEW_MAX), truncated: text.length > PREVIEW_MAX };
}

let lastOcrPage = '';
const ocr = (png) => ocrImage(png, (p) => progress(`Texterkennung${lastOcrPage} …`, p));

let nerReady = false;
function nerProgress(e) {
  if (e.status === 'progress' && e.file?.endsWith('.onnx')) {
    progress('KI-Namenserkennung wird geladen (nur beim ersten Mal, ca. 180 MB) …', e.progress / 100);
  }
}

// --------------------------------------------------------------------------
// Befehle
// --------------------------------------------------------------------------
const commands = {
  status() {
    const categories = Object.fromEntries(Object.entries(E.CATEGORIES).map(([k, v]) => [k, { label: v.label, default: v.default }]));
    return { categories, nerModel: MODEL_ID, nerReady, isolated: self.crossOriginIsolated };
  },

  async preload() {
    await loadNer(nerProgress);
    nerReady = true;
    return true;
  },

  async analyze({ name, bytes, categories, extras }) {
    const kind = kindOf(name);
    if (!kind) throw new Error('Dateityp nicht unterstützt. Möglich: .docx, .pdf, .txt, .png, .jpg, .tif, .bmp.');
    session = null;
    const data = new Uint8Array(bytes);
    const s = { name, kind, data };
    let ocrUsed = false;
    try {
      if (kind === 'txt') s.text = decodeText(data);
      else if (kind === 'docx') s.text = await docx.extractText(data);
      else if (kind === 'pdf') {
        s.pages = await analyzePdf(data, ocr, (i, n) => { lastOcrPage = n > 1 ? ` (Seite ${i + 1} von ${n})` : ''; progress(`PDF wird gelesen${lastOcrPage} …`); });
        ocrUsed = s.pages.some((p) => p.scanned);
      } else {
        lastOcrPage = '';
        s.pages = await analyzeImage(data, IMAGE_TYPES[ext(name).slice(1)], ocr);
        ocrUsed = true;
      }
    } catch (e) {
      throw new Error(`Datei konnte nicht gelesen werden: ${e.message || e}`);
    }

    const text = fullText(s);
    try {
      if (!nerReady) progress('KI-Namenserkennung wird geladen …');
      await loadNer(nerProgress);
      nerReady = true;
      s.entities = await detectEntities(text, (p) => progress('Namen werden erkannt …', p));
    } catch (e) {
      s.entities = [];
      s.nerError = String(e.message || e);
    }
    session = s;
    touch();
    return { name, kind, ocr: ocrUsed, chars: text.length, ner: s.nerError ? null : MODEL_ID, nerError: s.nerError, ...review(s, detectIn(s, categories, extras)) };
  },

  redetect({ categories, extras }) {
    const s = current();
    return review(s, detectIn(s, categories, extras));
  },

  async process({ categories, extras, exclude, mode, numbered, password, stripMetadata }) {
    const s = current();
    const ex = new Set(exclude || []);
    const hits = detectIn(s, categories, extras).filter((h) => !ex.has(E.findingId(h)));
    const black = mode === 'schwaerzen';
    const mapping = new E.Mapping({ numbered: numbered !== false, mode: black ? 'schwaerzen' : 'platzhalter' });
    const rep = E.buildReplacements(hits, mapping);
    const base = stem(s.name);
    const e = ext(s.name);

    let out; let outName;
    progress('Dokument wird anonymisiert …');
    if (s.kind === 'txt') {
      out = new TextEncoder().encode(E.applyText(s.text, rep, mapping));
      outName = `${base}_anonymisiert${e}`;
    } else if (s.kind === 'docx') {
      out = await docx.anonymize(s.data, rep, mapping, stripMetadata !== false);
      outName = `${base}_anonymisiert.docx`;
    } else if (s.kind === 'pdf') {
      out = anonymizePdf(s.data, s.pages, rep, mapping, stripMetadata !== false);
      outName = `${base}_anonymisiert.pdf`;
    } else {
      const img = anonymizeImage(s.data, IMAGE_TYPES[e.slice(1)], s.pages[0], rep, mapping);
      out = img.bytes;
      outName = `${base}_anonymisiert${img.ext}`;
    }

    const reversible = !black && (s.kind === 'txt' || s.kind === 'docx');
    if (password) progress('Schlüsseldatei wird verschlüsselt …');
    const key = await dumpKey(mapping, password || '', { quelle: s.name, typ: s.kind, erstellt: Math.floor(Date.now() / 1000) });
    return {
      doc: { name: outName, bytes: out },
      key: { name: `${base}_schluessel.slvkey`, bytes: key },
      replaced: rep.size,
      reversible,
      keyEncrypted: Boolean(password),
      kind: s.kind,
      note: reversible || black ? null
        : 'Hinweis: Bei PDF- und Bilddateien ist die Rück-Ersetzung nicht automatisch möglich; '
          + 'die Schlüsseldatei dokumentiert die Zuordnung (Platzhalter ↔ Originalwert).',
    };
  },

  clear() {
    session = null;
    clearTimeout(purgeTimer);
    return true;
  },

  async restore({ name, bytes, key, password }) {
    const kind = kindOf(name);
    if (kind !== 'txt' && kind !== 'docx') throw new Error('Rück-Ersetzung ist für .docx und .txt möglich (PDF/Bild: Original verwenden).');
    const mapping = await loadKey(new Uint8Array(key), password || '');
    const base = stem(name).replace('_anonymisiert', '');
    if (kind === 'docx') return { name: `${base}_wiederhergestellt.docx`, bytes: await docx.restore(new Uint8Array(bytes), mapping) };
    const text = E.restoreText(decodeText(new Uint8Array(bytes)), mapping);
    return { name: `${base}_wiederhergestellt${ext(name)}`, bytes: new TextEncoder().encode(text) };
  },

  keyEncrypted({ key }) {
    return isEncrypted(new Uint8Array(key));
  },
};

self.onmessage = async ({ data: { id, cmd, args } }) => {
  try {
    const result = await commands[cmd](args || {});
    // bewusst kopieren statt übertragen: Ergebnis-Bytes können auf den WebAssembly-Speicher zeigen
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: e?.message || String(e) });
  }
};
// Nachrichten vor diesem Punkt gingen verloren (Module laden asynchron) – daher erst jetzt „bereit“ melden.
self.postMessage({ type: 'ready' });
