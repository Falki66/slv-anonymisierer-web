// Aufbereitung von OCR-Ergebnissen: Lesereihenfolge, Text mit Positionsindex und Rechtecke für Textbereiche.
// seg = {text, x0, y0, x1, y1} in Bildpixeln

// Sortiert in Lesereihenfolge: zeilenweise (oben -> unten), innerhalb der Zeile links -> rechts.
export function orderSegments(segs) {
  if (!segs.length) return segs;
  const yc = (s) => (s.y0 + s.y1) / 2;
  const sorted = [...segs].sort((a, b) => yc(a) - yc(b) || a.x0 - b.x0);
  const lines = [];
  for (const s of sorted) {
    const h = Math.max(1, s.y1 - s.y0);
    const last = lines.at(-1);
    if (last) {
      const ly = last.reduce((t, x) => t + yc(x), 0) / last.length;
      const lh = last.reduce((t, x) => t + (x.y1 - x.y0), 0) / last.length;
      if (Math.abs(yc(s) - ly) < 0.6 * Math.max(h, lh)) { last.push(s); continue; }
    }
    lines.push([s]);
  }
  return lines.flatMap((ln) => ln.sort((a, b) => a.x0 - b.x0));
}

// Fügt Segmente zu einem Text zusammen (Zeilenumbruch bei neuer Zeile).
// Rückgabe: {text, index: [[start, ende, segmentIndex]]}
export function joinSegments(segs) {
  let text = '';
  const index = [];
  let prev = null;
  segs.forEach((s, i) => {
    if (prev) {
      const same = Math.abs((s.y0 + s.y1) / 2 - (prev.y0 + prev.y1) / 2) < 0.6 * Math.max(s.y1 - s.y0, prev.y1 - prev.y0);
      text += same ? ' ' : '\n';
    }
    index.push([text.length, text.length + s.text.length, i]);
    text += s.text;
    prev = s;
  });
  return { text, index };
}

// Rechtecke für den Textbereich [s,e): anteilig nach Zeichenposition innerhalb jedes Segments.
export function spanRects(segs, index, s, e) {
  const rects = [];
  for (const [a, b, i] of index) {
    if (b <= s || a >= e) continue;
    const seg = segs[i];
    const n = Math.max(1, b - a);
    const lo = Math.max(s, a) - a;
    const hi = Math.min(e, b) - a;
    const h = seg.y1 - seg.y0;
    const pad = 0.04 * h;
    let x0; let x1;
    if (seg.chars && seg.chars.length === n) {
      // exakte Zeichenränder; bis zur Mitte des Abstands zum Nachbarzeichen ausdehnen
      x0 = lo > 0 ? (seg.chars[lo - 1][1] + seg.chars[lo][0]) / 2 : seg.x0 - 1;
      x1 = hi < n ? (seg.chars[hi - 1][1] + seg.chars[hi][0]) / 2 : seg.x1 + 1;
    } else {
      // geschätzt (anteilig); an angeschnittenen Rändern großzügiger, damit keine Zeichenreste bleiben
      const w = seg.x1 - seg.x0;
      x0 = seg.x0 + (w * lo) / n - (lo > 0 ? 0.15 * h : 1);
      x1 = seg.x0 + (w * hi) / n + (hi < n ? 0.15 * h : 1);
    }
    rects.push([x0, seg.y0 - pad, x1, seg.y1 + pad]);
  }
  return mergeLineRects(rects);
}

// Benachbarte Rechtecke derselben Zeile (einzelne Wörter) zu einem Rechteck zusammenfassen,
// damit z. B. „Max Müller“ ein Feld mit gut lesbarem Platzhalter ergibt.
function mergeLineRects(rects) {
  const out = [];
  for (const r of rects) {
    const last = out.at(-1);
    if (last) {
      const h = Math.min(last[3] - last[1], r[3] - r[1]);
      const vOverlap = Math.min(last[3], r[3]) - Math.max(last[1], r[1]);
      const gap = r[0] - last[2];
      if (vOverlap > 0.5 * h && gap < 1.5 * h && gap > -h) {
        out[out.length - 1] = [Math.min(last[0], r[0]), Math.min(last[1], r[1]), Math.max(last[2], r[2]), Math.max(last[3], r[3])];
        continue;
      }
    }
    out.push([...r]);
  }
  return out;
}
