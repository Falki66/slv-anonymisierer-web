// KI-Namenserkennung im Browser mit transformers.js (BERT, mehrsprachig: Personen, Organisationen, Orte).
// Das Modell wird beim ersten Gebrauch geladen und vom Browser zwischengespeichert;
// die Texte selbst verlassen das Gerät nie.
import { pipeline, env } from '@huggingface/transformers';

export const MODEL_ID = 'Xenova/bert-base-multilingual-cased-ner-hrl';
const CHUNK_CHARS = 800; // deutlich unter 512 Tokens pro Abschnitt
const BATCH = 4;

env.allowLocalModels = false;
if (typeof self !== 'undefined' && self.crossOriginIsolated) {
  env.backends.onnx.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 8);
}

let ner = null;
let loading = null;

export function loadNer(onProgress) {
  if (ner) return Promise.resolve(ner);
  loading ||= pipeline('token-classification', MODEL_ID, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: onProgress,
  }).then((p) => { ner = p; return p; }).catch((e) => { loading = null; throw e; });
  return loading;
}

// Text an Zeilen-/Satzgrenzen in Abschnitte teilen; liefert [startOffset, abschnitt].
function chunks(text) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_CHARS);
    if (end < text.length) {
      const window = text.slice(start, end);
      const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf(' '));
      if (cut > CHUNK_CHARS / 2) end = start + cut + 1;
    }
    out.push([start, text.slice(start, end)]);
    start = end;
  }
  return out;
}

// Token des Modells (in Reihenfolge, "##" = Wortfortsetzung) im Originaltext wiederfinden.
function align(chunk, tokens) {
  let cursor = 0;
  return tokens.map((t) => {
    const piece = t.word.startsWith('##') ? t.word.slice(2) : t.word;
    if (!piece || piece === '[UNK]') return null;
    const at = chunk.indexOf(piece, cursor);
    // nur akzeptieren, wenn dazwischen höchstens Leer-/Steuerzeichen liegen
    if (at < 0 || /\S/.test(chunk.slice(cursor, at))) return null;
    cursor = at + piece.length;
    return { start: at, end: cursor, tag: t.entity };
  });
}

// BIO-Tags zu Entitäten zusammenfassen: [{start, end, label}]
function group(aligned) {
  const ents = [];
  let cur = null;
  for (const a of aligned) {
    if (!a) continue;
    const [prefix, label] = a.tag.includes('-') ? a.tag.split('-') : ['O', a.tag];
    if (label === 'O' || prefix === 'O') { cur = null; continue; }
    if (cur && cur.label === label && (prefix === 'I' || a.start === cur.end)) {
      cur.end = a.end;
    } else {
      cur = { start: a.start, end: a.end, label };
      ents.push(cur);
    }
  }
  return ents;
}

// Erkennt Entitäten im ganzen Text. onProgress(anteil) für die Fortschrittsanzeige.
export async function detectEntities(text, onProgress) {
  const model = await loadNer();
  const parts = chunks(text).filter(([, c]) => /\p{L}/u.test(c));
  const entities = [];
  for (let i = 0; i < parts.length; i += BATCH) {
    const batch = parts.slice(i, i + BATCH);
    // Eingabe ist immer eine Liste -> Ergebnis ist eine Liste je Abschnitt
    const results = await model(batch.map(([, c]) => c), { ignore_labels: [] });
    batch.forEach(([offset, c], k) => {
      for (const e of group(align(c, results[k]))) {
        // auf ganze Wörter erweitern (das Modell markiert manchmal nur Wortteile, z. B. „Ötz“ von „Ötzi“)
        let { start, end } = e;
        while (start > 0 && /[\p{L}\p{N}]/u.test(c[start - 1])) start--;
        while (end < c.length && /[\p{L}\p{N}]/u.test(c[end])) end++;
        entities.push({ start: offset + start, end: offset + end, label: e.label });
      }
    });
    onProgress?.(Math.min(1, (i + batch.length) / parts.length));
  }
  return entities;
}
