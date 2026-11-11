// Texterkennung (OCR) für Scans und Bilder mit Tesseract (WebAssembly, läuft im Browser).
// Die Sprachdaten (Deutsch) werden beim ersten Gebrauch geladen und vom Browser zwischengespeichert;
// die Bilder selbst verlassen das Gerät nicht.
import { createWorker } from 'tesseract.js';
import { orderSegments, joinSegments } from './ocr-layout.js';

let worker = null;

async function getWorker(onProgress) {
  worker ||= createWorker('deu', 1, {
    logger: (m) => { if (m.status === 'recognizing text') onProgress?.(m.progress); },
  }).catch((e) => { worker = null; throw e; });
  return worker;
}

// png: Uint8Array mit PNG-Bild -> {text, segs, index}
export async function ocrImage(png, onProgress) {
  const w = await getWorker(onProgress);
  const { data } = await w.recognize(new Blob([png], { type: 'image/png' }), {}, { blocks: true, text: false });
  const segs = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        for (const word of line.words) {
          const text = (word.text || '').trim();
          if (!text) continue;
          const { x0, y0, x1, y1 } = word.bbox;
          const seg = { text, x0, y0, x1, y1 };
          // exakte Zeichenpositionen, wenn Tesseract sie passend zum Wort liefert
          const sym = (word.symbols || []).filter((s) => s.text);
          if (sym.length === [...text].length) seg.chars = sym.map((s) => [s.bbox.x0, s.bbox.x1]);
          segs.push(seg);
        }
      }
    }
  }
  const ordered = orderSegments(segs);
  return { segs: ordered, ...joinSegments(ordered) };
}

export async function terminateOcr() {
  if (worker) { const w = await worker; worker = null; await w.terminate(); }
}
