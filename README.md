# SLV Anonymisierer – Web-Version

Erkennt personenbezogene Daten in juristischen Dokumenten (Bescheide, Urteile, Schriftsätze) und ersetzt sie
durch Platzhalter wie `[NAME-1]` oder schwärzt sie. Web-Version der lokalen Desktop-App.

**Datenschutz-Grundsatz:** Die App wird aus dem Internet geladen, die Verarbeitung läuft aber vollständig im
Browser. Dokumente werden nicht hochgeladen und nirgends gespeichert. Eine strenge Content-Security-Policy
(`security-headers.json`) erlaubt nur Verbindungen zur eigenen Adresse sowie zu Hugging Face (KI-Modell) und
jsDelivr (Texterkennung) – beides reine Programm-Downloads.

## Funktionen

- Word (`.docx`), PDF (mit Textebene und gescannt), Text, Bilder (`.png`, `.jpg`, `.tif`, `.bmp`)
- Muster-Erkennung (Namen, Adressen, IBAN, Steuer-ID, Aktenzeichen …) – identisch mit der Desktop-Version
- KI-Namenserkennung mit [transformers.js](https://huggingface.co/docs/transformers.js) und dem Modell
  `Xenova/bert-base-multilingual-cased-ner-hrl` (ersetzt spaCy und GLiNER der Desktop-Version)
- Echte PDF-Schwärzung mit [MuPDF](https://mupdf.com/) (Text wird entfernt, nicht nur überdeckt)
- Texterkennung für Scans mit [Tesseract.js](https://tesseract.projectnaptha.com/)
- Schlüsseldatei (`.slvkey`) mit optionaler Verschlüsselung – kompatibel mit der Desktop-Version
- Wiederherstellung der Originaldaten für Word und Text

## Entwicklung

Voraussetzung: [Node.js](https://nodejs.org/) (LTS).

```bash
npm install
npm run dev      # Entwicklungsserver unter http://localhost:5173
npm test         # automatische Tests (Erkennung, Word, PDF, Schlüsseldatei)
npm run build    # fertige Version in dist/
npm run preview  # fertige Version mit allen Sicherheits-Headern unter http://localhost:4173
```

## Aufbau

| Datei | Aufgabe |
|---|---|
| `index.html`, `src/main.js` | Oberfläche |
| `src/worker.js` | Hintergrund-Prozess: hält das Dokument im Arbeitsspeicher, steuert alle Schritte |
| `src/engine.js` | Erkennung, Platzhalter, Rück-Ersetzung (Portierung von `engine.py`) |
| `src/ner/bert.js` | KI-Namenserkennung |
| `src/formats/docx.js` | Word lesen, anonymisieren, wiederherstellen |
| `src/formats/pdf.js` | PDF/Bilder: Text lesen, echte Redaktion, Scans überdecken |
| `src/formats/ocr.js`, `ocr-layout.js` | Texterkennung und Positionsberechnung |
| `src/keyfile.js` | Schlüsseldatei (PBKDF2 + Fernet, kompatibel mit Python) |
| `public/` | Logo, Stylesheet, Hilfeseite |
| `security-headers.json`, `vercel.json` | Sicherheits-Header für Entwicklung und Hosting |

## Lizenz

Die App verwendet MuPDF, das unter der **GNU AGPL v3** steht. Wird die App öffentlich betrieben, muss deshalb
auch ihr Quellcode unter der AGPL öffentlich verfügbar sein (z. B. in diesem Repository).
