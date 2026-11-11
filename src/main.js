// Oberfläche des SLV Anonymisierers. Die eigentliche Arbeit erledigt der Web Worker (worker.js);
// diese Datei kümmert sich nur um Anzeige und Bedienung.

const $ = (id) => document.getElementById(id);
const state = { hasDoc: false, findings: [], exclude: new Set(), extras: [], cats: {}, timer: null, sel: '', lastPreview: [] };

// ---------- Verbindung zum Worker ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let nextId = 1;
let onProgress = null;
let markReady;
const ready = new Promise((r) => { markReady = r; });

worker.onmessage = ({ data }) => {
  if (data.type === 'ready') { markReady(); return; }
  if (data.type === 'progress') { onProgress?.(data.text, data.value); return; }
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  if (data.ok) p.resolve(data.result); else p.reject(new Error(data.error));
};
worker.onerror = (e) => {
  for (const p of pending.values()) p.reject(new Error('Interner Fehler: ' + (e.message || 'Hintergrundprozess abgestürzt')));
  pending.clear();
};

async function call(cmd, args) {
  await ready;
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, args });
  });
}

function saveBytes(bytes, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes]));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- Init ----------
async function init() {
  try {
    const st = await call('status');
    buildCategories(st.categories);
  } catch (e) { showErr(e.message); return; }
  // KI-Modell im Hintergrund vorladen, damit die erste Analyse schneller startet
  const badge = $('badgeNer');
  onProgress = (text, v) => { if (v !== undefined) badge.textContent = `KI: lädt ${Math.round(v * 100)} %`; };
  call('preload')
    .then(() => { badge.textContent = 'KI: bereit'; badge.classList.replace('gray', 'green'); })
    .catch(() => { badge.textContent = 'KI: nicht verfügbar'; badge.classList.replace('gray', 'warn'); badge.title = 'Die KI-Namenserkennung konnte nicht geladen werden (Internetverbindung?). Namen werden nur über Muster erkannt.'; })
    .finally(() => { if (!state.busy) onProgress = null; });
}

function buildCategories(cats) {
  const box = $('cats');
  box.textContent = '';
  const addSel = [$('extraCat'), $('selCat')];
  Object.entries(cats).forEach(([key, c]) => {
    state.cats[key] = c.default;
    const l = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = c.default; cb.dataset.cat = key;
    cb.addEventListener('change', () => { state.cats[key] = cb.checked; scheduleRedetect(); });
    const sp = document.createElement('span'); sp.textContent = c.label;
    l.append(cb, sp); box.appendChild(l);
    addSel.forEach((s) => {
      const o = document.createElement('option'); o.value = key; o.textContent = `[${key}]`;
      if (key === 'MANUELL') o.selected = true;
      s.appendChild(o);
    });
  });
}
const activeCats = () => Object.keys(state.cats).filter((k) => state.cats[k]);

// ---------- Fehler / Busy ----------
function showErr(msg) { const e = $('err'); e.textContent = msg; e.hidden = !msg; }
function busy(on, text) {
  state.busy = on;
  $('busy').hidden = !on;
  $('busyBar').hidden = true;
  if (text) $('busyText').textContent = text;
  onProgress = on ? (t, v) => {
    if (t) $('busyText').textContent = t;
    const bar = $('busyBar');
    bar.hidden = v === undefined;
    if (v !== undefined) bar.value = v;
  } : null;
}

// ---------- Tabs ----------
document.querySelectorAll('.tab[data-tab]').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab[data-tab]').forEach((x) => x.classList.toggle('active', x === t));
  $('tab-anon').hidden = t.dataset.tab !== 'anon';
  $('tab-restore').hidden = t.dataset.tab !== 'restore';
  document.querySelector('.titleband h1').textContent = t.dataset.tab === 'restore' ? 'Dokumente wiederherstellen' : 'Dokumente anonymisieren';
}));

// ---------- Datei wählen ----------
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) analyze(e.dataTransfer.files[0]); });
$('file').addEventListener('change', (e) => { if (e.target.files[0]) analyze(e.target.files[0]); });

async function analyze(file) {
  showErr(''); $('result').hidden = true; $('review').hidden = true; $('nerWarn').hidden = true;
  state.exclude = new Set();
  $('fileinfo').textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;
  const isScan = /\.(png|jpe?g|tiff?|bmp|pdf)$/i.test(file.name);
  busy(true, isScan ? 'Dokument wird analysiert (bei Scans mit Texterkennung – das kann etwas dauern) …' : 'Dokument wird analysiert …');
  try {
    const data = await call('analyze', { name: file.name, bytes: await file.arrayBuffer(), categories: activeCats(), extras: state.extras });
    state.hasDoc = true;
    if (data.ocr) { $('badgeOcr').textContent = 'OCR: bereit'; $('badgeOcr').classList.replace('gray', 'green'); }
    if (data.nerError) {
      $('nerWarn').textContent = 'Die KI-Namenserkennung war nicht verfügbar – Namen wurden nur über Muster erkannt. '
        + `Bitte die Treffer besonders sorgfältig prüfen. (Ursache: ${data.nerError})`;
      $('nerWarn').hidden = false;
    }
    renderReview(data);
    $('review').hidden = false;
    $('review').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { showErr(e.message); } finally { busy(false); $('file').value = ''; }
}

// ---------- Treffer / Vorschau ----------
function renderReview(data) {
  state.findings = data.findings;
  renderFindings(); renderPreview(data.preview);
  $('truncNote').hidden = !data.truncated;
}

function renderFindings() {
  const box = $('findings');
  box.textContent = '';
  let lastCat = null;
  state.findings.forEach((f) => {
    if (f.category !== lastCat) {
      const g = document.createElement('div'); g.className = 'fgroup'; g.textContent = `[${f.category}]`; box.appendChild(g); lastCat = f.category;
    }
    const row = document.createElement('label'); row.className = 'fitem' + (state.exclude.has(f.id) ? ' off' : '');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !state.exclude.has(f.id);
    cb.addEventListener('change', () => toggle(f.id));
    const v = document.createElement('span'); v.className = 'val'; v.textContent = f.value;
    const c = document.createElement('span'); c.className = 'cnt'; c.textContent = `${f.count}×`;
    row.append(cb, v, c); box.appendChild(row);
  });
  const active = state.findings.filter((f) => !state.exclude.has(f.id)).length;
  $('findCount').textContent = `${active} von ${state.findings.length} Treffern werden ersetzt`;
}

function renderPreview(segments) {
  state.lastPreview = segments;
  const box = $('preview');
  box.textContent = '';
  segments.forEach((s) => {
    if (s.id) {
      const m = document.createElement('mark'); m.textContent = s.t; m.dataset.id = s.id; m.dataset.c = s.c; m.title = `[${s.c}] – Klick zum Umschalten`;
      if (state.exclude.has(s.id)) m.classList.add('off');
      box.appendChild(m);
    } else box.appendChild(document.createTextNode(s.t));
  });
}
$('preview').addEventListener('click', (e) => { const m = e.target.closest('mark'); if (m) toggle(m.dataset.id); });

function toggle(id) {
  if (state.exclude.has(id)) state.exclude.delete(id); else state.exclude.add(id);
  renderFindings();
  document.querySelectorAll('#preview mark').forEach((m) => { if (m.dataset.id === id) m.classList.toggle('off', state.exclude.has(id)); });
}
$('selAll').addEventListener('click', () => { state.exclude.clear(); renderFindings(); renderPreview(state.lastPreview); });
$('selNone').addEventListener('click', () => { state.findings.forEach((f) => state.exclude.add(f.id)); renderFindings(); renderPreview(state.lastPreview); });

// Auswahl in der Vorschau -> eigener Begriff
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  const txt = sel ? sel.toString().trim() : '';
  const inside = sel && sel.anchorNode && $('preview').contains(sel.anchorNode);
  if (inside && txt.length >= 2 && txt.length <= 120 && !txt.includes('\n')) {
    state.sel = txt; $('selText').textContent = `„${txt}“`; $('selTools').hidden = false;
  }
});
$('selAdd').addEventListener('click', () => {
  if (!state.sel) return;
  addExtra(state.sel, $('selCat').value);
  state.sel = ''; $('selTools').hidden = true; window.getSelection().removeAllRanges();
});

// ---------- Eigene Begriffe ----------
function addExtra(term, category) {
  if (!term || state.extras.some((x) => x.term === term && x.category === category)) return;
  state.extras.push({ term, category }); renderExtras(); scheduleRedetect();
}
function renderExtras() {
  const ul = $('extraList');
  ul.textContent = '';
  state.extras.forEach((x, i) => {
    const li = document.createElement('li');
    const s = document.createElement('span'); s.textContent = `${x.term} → [${x.category}]`;
    const b = document.createElement('button'); b.type = 'button'; b.textContent = '×'; b.setAttribute('aria-label', 'Begriff entfernen');
    b.addEventListener('click', () => { state.extras.splice(i, 1); renderExtras(); scheduleRedetect(); });
    li.append(s, b); ul.appendChild(li);
  });
}
$('addExtra').addEventListener('click', () => { addExtra($('extraTerm').value.trim(), $('extraCat').value); $('extraTerm').value = ''; });
$('extraTerm').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('addExtra').click(); } });

function scheduleRedetect() {
  if (!state.hasDoc) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(async () => {
    try {
      const d = await call('redetect', { categories: activeCats(), extras: state.extras });
      state.findings = d.findings; renderFindings(); renderPreview(d.preview); $('truncNote').hidden = !d.truncated;
    } catch (e) { showErr(e.message); }
  }, 350);
}

// ---------- Verarbeiten ----------
$('process').addEventListener('click', async () => {
  showErr(''); $('process').disabled = true; busy(true, 'Dokument wird anonymisiert …');
  try {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const r = await call('process', {
      categories: activeCats(), extras: state.extras, exclude: [...state.exclude],
      mode, numbered: $('numbered').checked, stripMetadata: $('strip').checked, password: $('password').value,
    });
    $('resultText').textContent = `${r.replaced} verschiedene Angaben wurden ${mode === 'schwaerzen' ? 'geschwärzt' : 'durch Platzhalter ersetzt'}. `
      + (r.keyEncrypted ? 'Die Schlüsseldatei ist passwortgeschützt.' : 'Die Schlüsseldatei ist nicht verschlüsselt.');
    bindDownload($('dlDoc'), r.doc);
    bindDownload($('dlKey'), r.key);
    const n = $('resultNote'); n.hidden = !r.note; n.textContent = r.note || '';
    $('result').hidden = false; $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { showErr(e.message); } finally { $('process').disabled = false; busy(false); }
});

function bindDownload(a, file) {
  a.onclick = (e) => { e.preventDefault(); saveBytes(file.bytes, file.name); };
}

$('clear').addEventListener('click', async () => {
  try { await call('clear'); } catch { /* ignorieren */ }
  state.hasDoc = false; $('review').hidden = true; $('result').hidden = true; $('fileinfo').textContent = ''; showErr('');
  $('dlDoc').onclick = null; $('dlKey').onclick = null;
});

// ---------- Wiederherstellen ----------
$('restore').addEventListener('click', async () => {
  const f = $('rFile').files[0];
  const k = $('rKey').files[0];
  $('rErr').hidden = true; $('rOk').hidden = true;
  if (!f || !k) { $('rErr').textContent = 'Bitte Dokument und Schlüsseldatei auswählen.'; $('rErr').hidden = false; return; }
  $('rBusy').hidden = false;
  try {
    const res = await call('restore', { name: f.name, bytes: await f.arrayBuffer(), key: await k.arrayBuffer(), password: $('rPass').value });
    saveBytes(res.bytes, res.name);
    $('rOk').hidden = false;
  } catch (e) { $('rErr').textContent = e.message; $('rErr').hidden = false; } finally { $('rBusy').hidden = true; }
});

init();
