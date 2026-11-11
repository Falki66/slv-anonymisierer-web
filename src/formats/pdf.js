// PDF- und Bilddateien (mit MuPDF, als WebAssembly im Browser).
//
// * PDF mit Textebene: Text direkt auslesen; Treffer werden dauerhaft entfernt (echte Redaktion,
//   kein bloßes Überdecken) und durch Platzhalter bzw. schwarze Balken ersetzt.
// * Eingescannte PDFs / Bilder: Texterkennung (OCR) -> Treffer werden im Bild überdeckt.
import * as mupdf from 'mupdf';
import { findSpans, recordUse } from '../engine.js';
import { spanRects } from './ocr-layout.js';

export const OCR_DPI = 250;
const MIN_TEXT_CHARS = 25; // weniger Text auf der Seite -> als Scan behandeln
export const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp',
};

const RGB = mupdf.ColorSpace.DeviceRGB;
let helv = null;
const font = () => (helv ||= new mupdf.Font('Helvetica'));

function openPdf(data) {
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  if (doc.needsPassword()) throw new Error('Die PDF-Datei ist passwortgeschützt. Bitte zuerst ohne Passwortschutz speichern.');
  return doc.asPDF();
}

function renderPage(page, dpi = OCR_DPI) {
  return page.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), RGB, false, true);
}

// --------------------------------------------------------------------------
// Analyse (Text je Seite; OCR nur wo nötig). ocr(pngBytes) -> {text, segs, index}
// --------------------------------------------------------------------------
export async function analyzePdf(data, ocr, onPage) {
  const doc = openPdf(data);
  const pages = [];
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    onPage?.(i, n);
    const page = doc.loadPage(i);
    const text = page.toStructuredText('preserve-whitespace').asText();
    if (text.trim().length >= MIN_TEXT_CHARS) {
      pages.push({ scanned: false, text });
      continue;
    }
    const pix = renderPage(page);
    const res = await ocr(pix.asPNG());
    pages.push({ scanned: true, ...res, imgSize: [pix.getWidth(), pix.getHeight()] });
  }
  return pages;
}

export async function analyzeImage(data, type, ocr) {
  const pix = imagePixmap(data, type);
  const res = await ocr(pix.asPNG());
  return [{ scanned: true, ...res, imgSize: [pix.getWidth(), pix.getHeight()] }];
}

// Bild in voller Pixel-Auflösung rendern (MuPDF rechnet Bilder sonst über ihre dpi-Angabe auf 72 dpi um).
function imagePixmap(data, type) {
  const page = mupdf.Document.openDocument(data, type).loadPage(0);
  const [x0, y0, x1, y1] = page.getBounds();
  const img = new mupdf.Image(data);
  // längste Seite vergleichen, damit auch per EXIF gedrehte Fotos stimmen
  const scale = Math.max(img.getWidth(), img.getHeight()) / Math.max(x1 - x0, y1 - y0) || 1;
  return page.toPixmap(mupdf.Matrix.scale(scale, scale), RGB, false);
}

// --------------------------------------------------------------------------
// Zeichnen in Bildern (Scans)
// --------------------------------------------------------------------------
function textWidth(str, size) {
  const f = font();
  let w = 0;
  for (const ch of str) w += f.advanceGlyph(f.encodeCharacter(ch.codePointAt(0)));
  return w * size;
}

function paint(dev, [x0, y0, x1, y1], label, black) {
  const path = new mupdf.Path();
  path.rect(x0, y0, x1, y1);
  dev.fillPath(path, false, mupdf.Matrix.identity, RGB, black ? [0, 0, 0] : [1, 1, 1], 1);
  if (black) return;
  // dünner Rahmen
  for (const [a, b, c, d] of [[x0, y0, x1, y0 + 1], [x0, y1 - 1, x1, y1], [x0, y0, x0 + 1, y1], [x1 - 1, y0, x1, y1]]) {
    const p = new mupdf.Path(); p.rect(a, b, c, d);
    dev.fillPath(p, false, mupdf.Matrix.identity, RGB, [0, 0, 0], 1);
  }
  if (!label) return;
  const h = Math.max(8, y1 - y0);
  let size = h * 0.62;
  while (size > 7 && textWidth(label, size) > (x1 - x0) - 4) size -= 1;
  const t = new mupdf.Text();
  t.showString(font(), [size, 0, 0, -size, x0 + 2, y0 + (h + size * 0.72) / 2], label);
  dev.fillText(t, mupdf.Matrix.identity, RGB, [0, 0, 0], 1);
}

// Treffer in einem gerenderten Seitenbild überdecken.
function redactPixmap(pix, info, rep, mapping) {
  const black = mapping.mode === 'schwaerzen';
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  for (const [s, e, ph] of findSpans(info.text, rep)) {
    recordUse(mapping, ph, info.text.slice(s, e));
    // Platzhalter nur in das erste Rechteck schreiben, weitere Rechtecke weiß/schwarz füllen
    spanRects(info.segs, info.index, s, e).forEach((r, k) => paint(dev, r, k === 0 ? ph : null, black));
  }
  dev.close();
  return pix;
}

// --------------------------------------------------------------------------
// PDF-Verarbeitung
// --------------------------------------------------------------------------
const quadRect = (q) => [Math.min(q[0], q[4]), Math.min(q[1], q[3]), Math.max(q[2], q[6]), Math.max(q[5], q[7])];
const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const inter = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

// Sucht den Wert auf der Seite; mehrzeilige Werte werden mit normalisierten Leerzeichen erneut gesucht.
function search(page, value) {
  let hits = page.search(value);
  if (!hits.length) {
    const n = value.split(/\s+/).filter(Boolean).join(' ');
    if (n !== value) hits = page.search(n);
  }
  return hits.flat().map(quadRect);
}

// Platzhalter nach der Redaktion als eigenen Seiteninhalt einzeichnen (weißes Feld + Text).
function overlayPlaceholders(doc, page, boxes) {
  if (!boxes.length) return;
  const inv = mupdf.Matrix.invert(page.getTransform());
  const fontRef = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' });
  const name = 'SLVHelv';
  let ops = 'q\n';
  for (const { rect, ph } of boxes) {
    const [x0, y0, x1, y1] = mupdf.Rect.transform(rect, inv);
    const [lx, ly, w, h] = [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
    let fs = Math.max(5, Math.min(11, h * 0.78));
    const need = textWidth(ph, fs);
    if (need > w) fs = Math.max(5, fs * w / need);
    const safe = ph.replace(/[\\()]/g, '\\$&');
    ops += `1 1 1 rg ${lx.toFixed(2)} ${ly.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`;
    ops += `BT 0 0 0 rg /${name} ${fs.toFixed(2)} Tf ${(lx + 0.5).toFixed(2)} ${(ly + (h - fs * 0.72) / 2).toFixed(2)} Td (${safe}) Tj ET\n`;
  }
  ops += 'Q\n';

  const pageObj = page.getObject();
  // Ressourcen der Seite (ggf. geerbt) um die Schrift ergänzen
  let res = pageObj.get('Resources');
  if (res.isNull()) {
    const inherited = pageObj.getInheritable('Resources');
    res = doc.newDictionary();
    if (!inherited.isNull()) inherited.forEach((v, k) => res.put(k, v));
    pageObj.put('Resources', res);
  }
  let fonts = res.get('Font');
  if (fonts.isNull()) { fonts = doc.newDictionary(); res.put('Font', fonts); }
  fonts.put(name, fontRef);

  // bisherigen Inhalt mit q/Q kapseln, damit dessen Grafikzustand unsere Zeichnung nicht verschiebt
  const before = doc.addStream('q\n', {});
  const after = doc.addStream('Q\n' + ops, {});
  const old = pageObj.get('Contents');
  const arr = doc.newArray();
  arr.push(before);
  if (old.isArray()) old.forEach((v) => arr.push(v));
  else if (!old.isNull()) arr.push(old);
  arr.push(after);
  pageObj.put('Contents', arr);
}

// Gescannte Seite durch das überdeckte Bild ersetzen.
function replaceWithImage(doc, index, page, jpeg) {
  const [x0, y0, x1, y1] = page.getBounds();
  const img = doc.addImage(new mupdf.Image(jpeg));
  const w = x1 - x0; const h = y1 - y0;
  const newPage = doc.addPage([0, 0, w, h], 0, { XObject: { I0: img } }, `q ${w} 0 0 ${h} 0 0 cm /I0 Do Q`);
  doc.deletePage(index);
  doc.insertPage(index, newPage);
}

export function anonymizePdf(data, pages, rep, mapping, stripMetadata = true) {
  const doc = openPdf(data);
  const black = mapping.mode === 'schwaerzen';
  // längere Werte zuerst, damit Teilwerte keine Platzhalter in Platzhalter erzeugen
  const values = [...rep.keys()].sort((a, b) => b.length - a.length);
  for (let i = 0; i < pages.length; i++) {
    const info = pages[i];
    let page = doc.loadPage(i);
    if (info.scanned) {
      const pix = redactPixmap(renderPage(page), info, rep, mapping);
      replaceWithImage(doc, i, page, pix.asJPEG(88));
      continue;
    }
    // Textseite: echte Redaktion
    for (const [s, e, ph] of findSpans(info.text, rep)) recordUse(mapping, ph, info.text.slice(s, e));
    const done = [];
    const boxes = [];
    for (const v of values) {
      const ph = rep.get(v);
      for (const rect of search(page, v)) {
        // Teilwerte, die schon in einem längeren Treffer liegen, überspringen
        if (done.some((d) => area(inter(rect, d)) > 0.5 * area(rect))) continue;
        done.push(rect);
        const annot = page.createAnnotation('Redact');
        annot.setRect(rect);
        annot.update();
        boxes.push({ rect, ph });
      }
    }
    if (!boxes.length) continue;
    page.applyRedactions(black, mupdf.PDFPage.REDACT_IMAGE_PIXELS);
    if (!black) {
      page = doc.loadPage(i);
      overlayPlaceholders(doc, page, boxes);
    }
  }
  if (stripMetadata) stripMeta(doc);
  return doc.saveToBuffer('garbage=4,compress=yes,clean=yes').asUint8Array();
}

function stripMeta(doc) {
  for (const k of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate']) {
    doc.setMetaData('info:' + k, '');
  }
  const info = doc.getTrailer().get('Info');
  if (!info.isNull()) doc.getTrailer().delete('Info');
  const root = doc.getTrailer().get('Root');
  if (!root.isNull()) root.delete('Metadata');
}

// --------------------------------------------------------------------------
// Bilddateien
// --------------------------------------------------------------------------
export function anonymizeImage(data, type, info, rep, mapping) {
  const pix = redactPixmap(imagePixmap(data, type), info, rep, mapping);
  if (type === 'image/jpeg') return { bytes: pix.asJPEG(92), ext: '.jpg' }; // EXIF wird nicht übernommen
  return { bytes: pix.asPNG(), ext: '.png' };
}
