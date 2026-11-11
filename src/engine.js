// Erkennungs-Engine: findet personenbezogene Daten in Text und ersetzt sie durch
// standardisierte Platzhalter. Portierung von slv_anon/engine.py; läuft vollständig im Browser.
//
// Ablauf:
//   1. detect(text)        -> Liste von Treffern (Kategorie, Wert)
//   2. buildReplacements   -> Wert -> Platzhalter (optional nummeriert, damit umkehrbar)
//   3. applyText           -> ersetzt Werte im Text; Schlüssel (Mapping) bleibt erhalten
//
// Hinweis zu regulären Ausdrücken: In JavaScript gelten \w und \b nur für ASCII. Deshalb
// stehen hier W (Unicode-Wortzeichen) sowie B0/B1 (Wortgrenze vorne/hinten) an deren Stelle.

// --------------------------------------------------------------------------
// Kategorien und Platzhalter
// --------------------------------------------------------------------------
export const CATEGORIES = {
  NAME: { label: 'Namen von Personen', default: true },
  ADRESSE: { label: 'Adressen / Wohnorte', default: true },
  'E-MAIL': { label: 'E-Mail-Adressen', default: true },
  TELEFON: { label: 'Telefon- / Faxnummern', default: true },
  GEBURTSDATUM: { label: 'Geburtsdaten', default: true },
  FIRMA: { label: 'Firmennamen', default: true },
  BANKDATEN: { label: 'IBAN / BIC / Kontodaten', default: true },
  ID: { label: 'Steuernummern / Steuer-ID / SV-Nr. / Ausweis-Nr.', default: true },
  MGNR: { label: 'Mitgliedsnummer', default: true },
  AKTENZEICHEN: { label: 'Aktenzeichen / Geschäftszeichen', default: true },
  PERSONALNR: { label: 'Personalnummer / Dienstnummer', default: true },
  SCHULE: { label: 'Schulen / Dienststellen', default: true },
  GEBURTSORT: { label: 'Geburtsort', default: true },
  KFZ: { label: 'Kfz-Kennzeichen', default: true },
  IP: { label: 'IP-Adressen', default: true },
  URL: { label: 'Persönliche Web-/Profil-Links', default: false },
  MANUELL: { label: 'Eigene Begriffe', default: true },
};

// Reihenfolge = Priorität bei Überschneidungen (früher gewinnt bei gleicher Länge)
const PRIORITY = ['E-MAIL', 'BANKDATEN', 'IP', 'URL', 'MGNR', 'PERSONALNR', 'AKTENZEICHEN',
  'ID', 'GEBURTSDATUM', 'GEBURTSORT', 'TELEFON', 'KFZ', 'FIRMA', 'SCHULE',
  'ADRESSE', 'NAME', 'MANUELL'];

export const defaultCategories = () => Object.keys(CATEGORIES).filter((c) => CATEGORIES[c].default);

const hit = (start, end, category, value, source = 'regex') => ({ start, end, category, value, source });

// --------------------------------------------------------------------------
// Regex-Werkzeuge
// --------------------------------------------------------------------------
const W = String.raw`[\p{L}\p{N}_]`;
const B0 = `(?<!${W})`;
const B1 = `(?!${W})`;
const rx = (src, flags = '') => new RegExp(src, 'gud' + flags);

// Macht die Buchstaben eines Musterteils unabhängig von Groß-/Kleinschreibung (wie (?i:…) in Python).
// Escape-Sequenzen und Zeichenklassen bleiben unverändert.
function ci(p) {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      if (p[i + 1] === 'p' || p[i + 1] === 'P') { const j = p.indexOf('}', i); out += p.slice(i, j + 1); i = j; continue; }
      out += c + p[i + 1]; i++; continue;
    }
    if (c === '[') { const j = p.indexOf(']', i + 1); out += p.slice(i, j + 1); i = j; continue; }
    if (c === '(' && p[i + 1] === '?') {
      const m = /^\(\?(?:<[=!]|[:=!])/.exec(p.slice(i));
      out += m[0]; i += m[0].length - 1; continue;
    }
    if (c === '{') { const j = p.indexOf('}', i); out += p.slice(i, j + 1); i = j; continue; }
    const lo = c.toLowerCase(); const up = c.toUpperCase();
    out += lo !== up && lo.length === 1 && up.length === 1 ? `[${lo}${up}]` : c;
  }
  return `(?:${out})`;
}

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const isWordChar = (ch) => /[\p{L}\p{N}_]/u.test(ch || '');

// --------------------------------------------------------------------------
// Regex-Bausteine
// --------------------------------------------------------------------------
const UP = 'A-ZÄÖÜ';
const LOW = 'a-zäöüß';
const CAPWORD = `[${UP}][${LOW}]+(?:-[${UP}][${LOW}]+)*`; // Müller, Meier-Schulz
const NAMEPART = String.raw`(?:(?:von|van|zu|de|der|den|vom|zur|da|di|le|la|el|al|bin|ten|ter)\s+)*${CAPWORD}`;

const TITLES = String.raw`(?:Prof\.\s*(?:Dr\.\s*)?|Dr\.\s*(?:med\.\s*|jur\.\s*|rer\.\s*nat\.\s*)?|Dipl\.-${W}+\.?\s*|Mag\.\s*)`;
const SALUTE = '(?:Herrn|Herr|Frau|Fräulein)';
const ROLES = '(?:Kläger(?:in)?|Beklagte[rn]?|Antragsteller(?:in)?|Antragsgegner(?:in)?|Beschwerdeführer(?:in)?|'
  + 'Widerspruchsführer(?:in)?|Beigeladene[rn]?|Zeuge|Zeugin|Betroffene[rn]?|Mandant(?:in)?|'
  + 'Lehrer(?:in)?|Lehrkraft|Schüler(?:in)?|Angestellte[rn]?|Beamte[rn]?|Schulleiter(?:in)?|'
  + 'Rechtsanwalt|Rechtsanwältin|RA|Richter(?:in)?|Vorsitzende[rn]?|Mitglied)';

const RE_EMAIL = rx(String.raw`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`);
const RE_IBAN = rx(String.raw`\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b`);
const RE_BIC = rx(String.raw`(?:(?<=BIC)|(?<=BIC:)|(?<=SWIFT)|(?<=SWIFT:))\s*([A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b`);
const RE_KONTO = rx(ci(String.raw`Konto(?:nummer|-Nr\.?|nr\.?)?|Kto\.?(?:-Nr\.?)?|BLZ|Bankleitzahl`) + String.raw`\s*[:.]?\s*(\d[\d ]{3,14}\d)`);
const RE_IP = rx(String.raw`\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b`);
const RE_URL = rx(String.raw`\bhttps?:\/\/[^\s<>"]+|\bwww\.[^\s<>"]+`, 'i');

// Telefon: +49 351 83922-0, 0351 83922-0, 0172/1234567, (0351) 123456
const RE_PHONE = rx(
  String.raw`(?<![\p{L}\p{N}_\/.\-])(?:\+49|0049)[\s\-.\/]*\(?0?\d{2,5}\)?[\s\-.\/]*\d{2,}(?:[\s\-.\/]?\d{1,}){0,4}`
  + String.raw`|(?<![\p{L}\p{N}_\/.\-])\(?0\d{2,5}\)?[\s\-.\/]*\d{2,}(?:[\s\-.\/]\d{1,}){0,4}`);
const RE_PHONE_LABEL = rx(String.raw`\b(?:Tel(?:efon)?|Fax|Telefax|Mobil|Handy|Fon)\.?\s*(?:-?Nr\.?)?\s*[:.]?\s*`, 'i');

const DATE = String.raw`(?:\d{1,2}\.\s?\d{1,2}\.\s?(?:19|20)?\d{2}|\d{1,2}\.\s?(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+(?:19|20)\d{2})`;
const RE_BIRTH = rx(
  ci(String.raw`\bgeb(?:oren)?\.?(?:\s+am)?|Geburtsdatum|Geb\.-Datum|Geburtstag|Geb\.-Dat\.|\*`) + String.raw`\s*[:.]?\s*(${DATE})`);
const RE_BIRTHPLACE = rx(
  ci(String.raw`\bgeb(?:oren)?\.?\s+am\s+${DATE}\s+in|Geburtsort\s*[:.]?`)
  + String.raw`\s*(${CAPWORD}(?:\s+(?:an der|am|im|bei)\s+${CAPWORD}|\s+${CAPWORD})?)`);

const RE_TAXNR = rx(String.raw`\b\d{2,3}\/\d{3}\/\d{4,5}\b`);
const RE_USTID = rx(String.raw`\bDE\s?\d{9}\b`);
const RE_TAXID_CTX = rx(
  ci(String.raw`Steuer-?ID(?:-Nr\.?)?|Steuer-?Identifikationsnummer|IdNr\.?|Identifikationsnummer|Steuernummer|St\.-?Nr\.?`)
  + String.raw`\s*(?:(?:lautet|ist|beträgt|war)\s+)?[:.]?\s*(\d[\d \/]{8,14}\d)`);
const RE_SVNR = rx(String.raw`\b\d{2}\s?\d{6}\s?[A-Z]\s?\d{3}\b`);
const RE_SVNR_CTX = rx(
  ci(String.raw`Sozialversicherungsnummer|SV-Nr\.?|Rentenversicherungsnummer|RVNR`) + String.raw`\s*[:.]?\s*(\d{2}\s?\d{6}\s?[A-Z]\s?\d{3})`);
const RE_ID_CTX = rx(
  ci(String.raw`Personalausweis(?:nummer|-Nr\.?)?|Ausweis-?Nr\.?|Reisepass(?:nummer|-Nr\.?)?|Pass-?Nr\.?|Kundennummer|Kunden-Nr\.?|`
    + String.raw`Versicherungsnummer|Vers\.-Nr\.?|Vertragsnummer|Vertrags-Nr\.?|Rechnungsnummer|Beihilfenummer|Betriebsnummer|`
    + String.raw`Lehrer-?ID|Schüler-?ID|ID-Nr\.?`)
  + String.raw`\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/ ]{4,18}[A-Z0-9])`);

const RE_MGNR = rx(
  ci(String.raw`Mitglieds(?:nummer|-Nr\.?|nr\.?)|Mitglieds-Nummer|Mitgl\.?-?(?:Nr\.?|Nummer)|MG-?Nr\.?|Mitgliedsausweis(?:-Nr\.?)?`)
  + String.raw`\s*[:.]?\s*([A-Z]{0,4}[\-\/ ]?\d[\d\-\/ ]{2,14}\d)`);
const RE_PERSNR = rx(
  ci(String.raw`Personal(?:nummer|-Nr\.?|nr\.?)|Pers\.-?Nr\.?|PNr\.?|P-Nr\.?|Dienstnummer|Personenkennzeichen|PKZ`)
  + String.raw`\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/ ]{2,14}[A-Z0-9])`);

// Aktenzeichen: "Az.: 3 K 123/24", "Az. ABC-123/2024", "1 BvR 123/20", "S 12 AL 34/22", "Gz.: 12-345/678"
const RE_AZ_CTX = rx(
  ci(String.raw`Aktenzeichen|Akten-Zeichen|Az\.?|Gz\.?|Geschäftszeichen|Ihr Zeichen|Unser Zeichen|Unser Az\.?|Ihr Az\.?|Gesch\.-Z\.|Bearbeitungsnummer`)
  + String.raw`\s*[:.]?\s*([A-Z0-9ÄÖÜ][A-Za-z0-9ÄÖÜäöüß.\-\/ ]{3,28}[A-Za-z0-9])`);
const RE_AZ_COURT = rx(
  String.raw`\b(?:\d{1,2}\s+(?:[A-ZÄÖÜ]{1,4}[a-z]?\s+)?[A-ZÄÖÜ][A-Za-zÄÖÜ]{0,4}\s+\d{1,5}\/\d{2,4}(?:\s?[A-Z]{1,3})?`
  + String.raw`|[A-Z]{1,3}\s+\d{1,3}\s+[A-Z]{1,3}\s+\d{1,5}\/\d{2,4}`
  + String.raw`|\d\s+Bv[A-Z]\s+\d{1,5}\/\d{2,4}`
  + String.raw`|\d{1,2}\s+(?:Ca|Sa|Ta|BV|Gs|Ga|AZR|AZB|AZA|AZN)\s+\d{1,5}\/\d{2,4})${B1}`);

// KFZ
const RE_KFZ = rx(ci(String.raw`(?:Kennzeichen|amtl\.\s*Kennzeichen|Kfz-Kennzeichen|PKW)\s*[:.]?\s*`)
  + String.raw`([A-ZÄÖÜ]{1,3}[\s\-][A-Z]{1,2}\s?\d{1,4}[EH]?)${B1}`);

// Firmen: Rechtsformen
const LEGAL = String.raw`(?:GmbH\s*&\s*Co\.?\s*KG|GmbH|gGmbH|mbH|UG\s*\(haftungsbeschränkt\)|UG|AG|SE|KG(?:aA)?|OHG|GbR|PartG(?:mbB)?|`
  + String.raw`e\.\s?V\.|e\.\s?K\.|eG|Co\.\s*KG|Ltd\.?|Inc\.?|S\.A\.|B\.V\.|Stiftung|GmbH\s*i\.\s?L\.)`;
const RE_LEGAL_END = new RegExp(LEGAL + '$', 'u');
const CO_TOKEN = String.raw`(?:[${UP}0-9][\p{L}\p{N}_\-]*(?:\.[\p{L}\p{N}_\-]+)*|&|\+)`;
const RE_COMPANY = rx(String.raw`(?<!${W})((?:${CO_TOKEN}\s+){0,6}${CO_TOKEN}\s+${LEGAL})(?!${W})`);

// Schulen / Dienststellen
const SCHOOLTYPE = String.raw`(?:Grundschule|Oberschule|Gymnasium|Förderschule|Gemeinschaftsschule|Mittelschule|Berufsschulzentrum|`
  + String.raw`Berufliches\s+Schulzentrum|Berufsbildende\s+Schule|Schulzentrum|Förderzentrum|Kolleg|Landesgymnasium|`
  + String.raw`Grund-\s*und\s*Oberschule|Evangelische\s+(?:Grund|Ober)schule|Freie\s+(?:Grund|Ober)schule|`
  + String.raw`Montessori-Schule|Waldorfschule|Internat|Schule)`;
const RE_SCHOOL_A = rx(
  String.raw`${B0}((?:${SCHOOLTYPE})(?:\s+(?:für\s+${W}+\s+)?(?:der|des|am|an der|im|zu|in|bei)?\s*(?:${CAPWORD}|„[^“\n]{2,50}“|"[^"\n]{2,50}"))(?:\s+(?:${CAPWORD}|„[^“\n]{2,50}“)){0,3})`);
const RE_SCHOOL_B = rx(
  String.raw`${B0}((?:${CAPWORD}(?:\s+${CAPWORD}){0,2}[\s\-]+)(?:Grundschule|Oberschule|Gymnasium|Förderschule|Gemeinschaftsschule|Mittelschule|Berufsschulzentrum|Schulzentrum))${B1}`);
const RE_SCHOOL_PERS = rx(
  String.raw`${B0}((?:${CAPWORD}[\- ])?(?:${CAPWORD})\s*-\s*(?:Grundschule|Oberschule|Gymnasium|Schule|Schulzentrum))${B1}`);

// Adressen
const STREETSUF = String.raw`(?:straße|strasse|str\.|weg|platz|allee|gasse|ring|damm|ufer|chaussee|pfad|steig|hof|markt|berg|brücke|`
  + String.raw`promenade|park|siedlung|zeile|stieg|graben|winkel|kamp)`;
const STREETWORD = String.raw`(?:Straße|Strasse|Str\.|Weg|Platz|Allee|Gasse|Ring|Damm|Ufer|Chaussee|Pfad|Steig|Hof|Markt|Berg|Brücke|Promenade|Zeile|Stieg|Graben)`;
const RE_STREET = rx(
  String.raw`${B0}((?:[${UP}][${LOW}\-]*${STREETSUF}`
  + String.raw`|${CAPWORD}(?:\s+${CAPWORD})?\s+${STREETWORD}`
  + String.raw`|(?:An der|An den|Am|Im|Zum|Zur|Auf dem|Auf der|Unter den|Hinter dem|Bei der)\s+${CAPWORD}))`
  + String.raw`\s+(\d{1,4}\s?[a-zA-Z]?(?:\s?[\-–\/]\s?\d{1,4}\s?[a-zA-Z]?)?)${B1}`);
const RE_PLZ_ORT = rx(String.raw`${B0}(?:D-)?(0[1-9]\d{3}|[1-9]\d{4})\s+(${CAPWORD}(?:\s+(?:an der|am|im|bei|ob der|in der)\s+${CAPWORD}|[\s\/]+${CAPWORD})?)${B1}`);
const RE_POSTFACH = rx(String.raw`${B0}Postfach\s+\d{2,8}${B1}`);
const RE_WOHNORT_CTX = rx(
  ci(String.raw`wohnhaft\s+in|wohnt\s+in|wohnhaft\s+im|Wohnort\s*[:.]?|wohnhaft\s+(?:in|im)\s+der`)
  + String.raw`\s+(${CAPWORD}(?:\s+${CAPWORD}){0,2})`);

// Namen
const RE_NAME_SALUTE = rx(String.raw`${B0}${SALUTE}\s+(?:${TITLES})?((?:${NAMEPART})(?:\s+${NAMEPART}){0,3})`);
const RE_NAME_TITLE = rx(String.raw`${B0}${TITLES}((?:${NAMEPART})(?:\s+${NAMEPART}){0,3})`);
const RE_NAME_LABEL = rx(
  String.raw`(?:${B0}(?:Name|Vorname|Nachname|Familienname|Antragsteller(?:in)?|Kläger(?:in)?|Beklagte[rn]?|Mandant(?:in)?|`
  + String.raw`Betroffene[rn]?|Zeuge|Zeugin|Absender(?:in)?|Empfänger(?:in)?|Bearbeiter(?:in)?|Ansprechpartner(?:in)?|`
  + String.raw`Sachbearbeiter(?:in)?|Unterschrift|Verfasser(?:in)?|Schulleiter(?:in)?|Rechtsanwalt|Rechtsanwältin)\s*:\s*)`
  + String.raw`(?:${SALUTE}\s+)?(?:${TITLES})?((?:${NAMEPART})(?:\s+${NAMEPART}){0,3})`);
const RE_NAME_ROLE = rx(
  String.raw`${B0}(?:der|die|den|dem|des|vom|von der)\s+${ROLES}\s+(?:${SALUTE}\s+)?(?:${TITLES})?((?:${NAMEPART})(?:\s+${NAMEPART}){0,2})`);
const RE_NAME_LASTFIRST = rx(String.raw`${B0}(${CAPWORD}),\s+(${CAPWORD})${B1}(?=\s*(?:\(|,|;|geb\.|\*|$|\n))`);
const RE_NAMEPART_FULL = new RegExp(String.raw`^${NAMEPART}(?:\s+${NAMEPART})*$`, 'u');

// Wörter, die nach Anrede/Rolle folgen können, aber keine Namen sind
const NAME_STOP = new Set([
  'Der', 'Die', 'Das', 'Den', 'Dem', 'Des', 'Ein', 'Eine', 'Einen', 'Und', 'Oder', 'Aber', 'Wenn', 'Als', 'Wie', 'Nach', 'Vor',
  'Mit', 'Ohne', 'Für', 'Gegen', 'Auf', 'Aus', 'Bei', 'Seit', 'Von', 'Zu', 'Zur', 'Zum', 'Im', 'Am', 'An', 'In', 'Ist', 'Sind',
  'War', 'Wird', 'Wurde', 'Hat', 'Haben', 'Hatte', 'Kann', 'Soll', 'Muss', 'Darf', 'Sehr', 'Geehrte', 'Geehrter', 'Liebe', 'Lieber',
  'Betreff', 'Sachverhalt', 'Gründe', 'Tenor', 'Tatbestand', 'Entscheidungsgründe', 'Rechtsmittelbelehrung', 'Verwaltungsgericht',
  'Landesamt', 'Schule', 'Landeshauptstadt', 'Freistaat', 'Sachsen', 'Bundesverwaltungsgericht', 'Oberverwaltungsgericht',
  'Arbeitsgericht', 'Landesarbeitsgericht', 'Sozialgericht', 'Kultusministerium', 'Staatsministerium', 'Gewerkschaft',
  'Lehrerverband', 'Sächsischer', 'Sächsische', 'Sächsisches', 'Beamtenrecht', 'Besoldung', 'Beschluss', 'Urteil', 'Bescheid',
  'Widerspruch', 'Klage', 'Antrag', 'Anlage', 'Anlagen', 'Seite', 'Datum', 'Telefon', 'Telefax', 'Fax', 'Mail', 'Straße', 'Platz',
  'Geschäftsstelle', 'Landesgeschäftsstelle', 'Radebeul', 'Dresden', 'Leipzig', 'Chemnitz', 'Anhörung', 'Dienstherr', 'Dienststelle',
  'Kläger', 'Klägerin', 'Beklagte', 'Beklagter', 'Beklagten', 'Antragsteller', 'Antragstellerin', 'Antragsgegner', 'Widerspruchsführer',
  'Widerspruchsführerin', 'Lehrer', 'Lehrerin', 'Lehrkraft', 'Schüler', 'Schülerin', 'Zeuge', 'Zeugin', 'Beamte', 'Beamter',
  'Beamtin', 'Angestellte', 'Angestellter', 'Rechtsanwalt', 'Rechtsanwältin', 'Richter', 'Richterin', 'Kammer', 'Senat', 'Gericht',
  'Hiermit', 'Bezug', 'Hinweis', 'Vorname', 'Nachname', 'Name', 'Herr', 'Frau', 'Dr', 'Prof', 'Sehr geehrte', 'Mit freundlichen',
  'Freundlichen', 'Grüßen', 'Gruß', 'Grüße', 'Hochachtungsvoll', 'Unterschrift', 'Aktenzeichen', 'Verfahren', 'Rechtssache',
]);
// Anrede-Nachfolge, die abgebrochen werden soll (z. B. "Herr Müller wurde" -> Name = Müller)
const NAME_TAIL_STOP = new Set([...NAME_STOP, 'Wurde', 'Wird', 'Hat', 'Ist', 'Sagte', 'Erklärte', 'Trug', 'Legte', 'Beantragte', 'Teilte', 'Gab']);

// Häufige Wörter, die als Nachname fehlinterpretiert würden (klein, nur Absicherung)
const COMMON_WORDS = new Set(['sachsen', 'schule', 'land', 'recht', 'gericht', 'mark', 'stein', 'berg', 'wald', 'haus', 'hof', 'bach', 'brandt']);

const splitWs = (s) => s.split(/\s+/).filter(Boolean);
const titleCase = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

// Schneidet Stoppwörter am Ende ab, damit z. B. 'Müller Wurde' nicht entsteht.
function cleanName(s) {
  const parts = splitWs(s);
  while (parts.length && (NAME_TAIL_STOP.has(parts.at(-1)) || ['Dr', 'Prof'].includes(parts.at(-1).replace(/\.+$/, '')))) parts.pop();
  while (parts.length && NAME_STOP.has(parts[0])) parts.shift();
  return parts.join(' ');
}

// --------------------------------------------------------------------------
// KI-Namenserkennung (BERT): Nachbearbeitung der Modell-Treffer
// --------------------------------------------------------------------------
const NER_PREFIX = /^\s*(?:(?:herrn?|frau|hr|fr|gez|ppa|i\.\s*[av]|dr|prof)(?![\p{L}\p{N}_])\.?\s*|(?:med|jur|rer|nat|phil)\.\s*)*/iu;
const NER_WORD = String.raw`[\p{L}](?:[\p{L}]*)(?:[\-'’][\p{L}]+)*\.?`;
const NER_NAME = new RegExp(String.raw`^${NER_WORD}(?:,?\s+${NER_WORD})*$`, 'u');
const NER_PARTICLES = new Set(['von', 'van', 'zu', 'de', 'der', 'den', 'vom', 'zur', 'da', 'di', 'le', 'la', 'el', 'al', 'bin', 'ten', 'ter']);
const nerStop = (w) => { const x = w.replace(/\.+$/, ''); return NAME_TAIL_STOP.has(x) || NAME_TAIL_STOP.has(titleCase(x)); };
const isLower = (w) => w === w.toLowerCase() && w !== w.toUpperCase();

// Personen-Treffer des Modells bereinigen: Anrede/Titel abschneiden, Aufzählungen trennen,
// Beschreibungen (gemischt mit normalen Kleinwörtern) verwerfen. Großschrift und Initialen bleiben erlaubt.
function nerPersonHits(text, start, end) {
  const out = [];
  const span = text.slice(start, end);
  for (const seg of span.matchAll(/[^/;]+/gu)) {
    const body = seg[0];
    const cut = NER_PREFIX.exec(body)[0].length;
    const rest = body.slice(cut);
    if (!NER_NAME.test(rest.replace(/^[\s,:]+|[\s,:]+$/g, ''))) continue;
    const words = [...rest.matchAll(new RegExp(NER_WORD, 'gu'))];
    while (words.length && nerStop(words[0][0])) words.shift();
    while (words.length && nerStop(words.at(-1)[0])) words.pop();
    if (!words.length) continue;
    const lower = words.map((w) => w[0]).filter(isLower);
    if (lower.length && lower.length < words.length && lower.some((w) => !NER_PARTICLES.has(w))) continue;
    const first = words[0].index;
    const last = words.at(-1);
    const val = rest.slice(first, last.index + last[0].length).replace(/\.+$/, '');
    if (val.length < 3) continue;
    const s = start + seg.index + cut + first;
    out.push(hit(s, s + val.length, 'NAME', val, 'ner'));
  }
  return out;
}

// entities: [{start, end, label: 'PER'|'ORG'|'LOC'|…}] aus dem Modell (Zeichenpositionen im Text)
function nerHits(text, entities) {
  const hits = [];
  for (const e of entities || []) {
    if (e.label === 'PER') hits.push(...nerPersonHits(text, e.start, e.end));
    else if (e.label === 'ORG') {
      const val = text.slice(e.start, e.end).trim();
      // nur mit Rechtsform – Behörden sind meist keine personenbezogenen Daten
      if (val.length >= 3 && RE_LEGAL_END.test(val)) {
        const s = e.start + text.slice(e.start, e.end).indexOf(val);
        hits.push(hit(s, s + val.length, 'FIRMA', val, 'ner'));
      }
    }
  }
  return hits;
}

// --------------------------------------------------------------------------
// Erkennung
// --------------------------------------------------------------------------
function add(hits, cat, text, m, grp = 0, source = 'regex') {
  const [s, e0] = m.indices[grp];
  const val = text.slice(s, e0).replace(/[ .,;:]+$/, '');
  if (val) hits.push(hit(s, s + val.length, cat, val, source));
}

// Findet alle personenbezogenen Daten. Gibt nicht überlappende Treffer zurück.
// enabled: Set der aktiven Kategorien; customTerms: [{term, category}]; entities: KI-Treffer (optional)
export function detect(text, { enabled, customTerms = [], entities = [] } = {}) {
  enabled = enabled || new Set(defaultCategories());
  const H = [];
  const all = (re) => text.matchAll(re);

  for (const m of all(RE_EMAIL)) add(H, 'E-MAIL', text, m);
  for (const m of all(RE_IBAN)) if (ibanOk(m[0].replace(/\s/g, ''))) add(H, 'BANKDATEN', text, m);
  for (const m of all(RE_BIC)) add(H, 'BANKDATEN', text, m, 1);
  for (const m of all(RE_KONTO)) add(H, 'BANKDATEN', text, m, 1);
  for (const m of all(RE_IP)) add(H, 'IP', text, m);
  for (const m of all(RE_URL)) add(H, 'URL', text, m);

  for (const m of all(RE_MGNR)) add(H, 'MGNR', text, m, 1);
  for (const m of all(RE_PERSNR)) add(H, 'PERSONALNR', text, m, 1);
  for (const m of all(RE_AZ_CTX)) add(H, 'AKTENZEICHEN', text, m, 1);
  for (const m of all(RE_AZ_COURT)) add(H, 'AKTENZEICHEN', text, m);

  for (const re of [RE_TAXNR, RE_USTID, RE_SVNR]) for (const m of all(re)) add(H, 'ID', text, m);
  for (const re of [RE_TAXID_CTX, RE_SVNR_CTX, RE_ID_CTX]) for (const m of all(re)) add(H, 'ID', text, m, 1);

  for (const m of all(RE_BIRTH)) add(H, 'GEBURTSDATUM', text, m, 1);
  for (const m of all(RE_BIRTHPLACE)) add(H, 'GEBURTSORT', text, m, 1);

  for (const m of all(RE_PHONE)) {
    const v = m[0];
    const digits = v.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15 && !/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(v.trim())) add(H, 'TELEFON', text, m);
  }
  for (const m of all(RE_PHONE_LABEL)) {
    const s = m.index + m[0].length;
    const mm = /^\(?\+?\d[\d\s\-./()]{5,24}\d/u.exec(text.slice(s, s + 30));
    if (mm) {
      const val = text.slice(s, s + mm[0].length).replace(/[ .,;:]+$/, '');
      H.push(hit(s, s + val.length, 'TELEFON', val));
    }
  }

  for (const m of all(RE_KFZ)) add(H, 'KFZ', text, m, 1);

  for (const m of all(RE_COMPANY)) {
    const v = m[1];
    const parts = splitWs(v);
    // führende Funktions-/Stoppwörter abschneiden ("Die Firma Müller GmbH" -> "Müller GmbH")
    while (parts.length > 2 && (NAME_STOP.has(parts[0]) || ['firma', 'fa.'].includes(parts[0].toLowerCase()))) parts.shift();
    let v2 = parts.join(' ');
    let off = v.indexOf(v2);
    if (off < 0) { v2 = v; off = 0; }
    const s = m.indices[1][0] + off;
    H.push(hit(s, s + v2.length, 'FIRMA', v2));
  }

  for (const re of [RE_SCHOOL_A, RE_SCHOOL_B, RE_SCHOOL_PERS]) for (const m of all(re)) add(H, 'SCHULE', text, m, 1);

  for (const m of all(RE_STREET)) add(H, 'ADRESSE', text, m);
  for (const m of all(RE_PLZ_ORT)) add(H, 'ADRESSE', text, m);
  for (const m of all(RE_POSTFACH)) add(H, 'ADRESSE', text, m);
  for (const m of all(RE_WOHNORT_CTX)) add(H, 'ADRESSE', text, m, 1);

  // Namen
  for (const re of [RE_NAME_SALUTE, RE_NAME_TITLE, RE_NAME_LABEL, RE_NAME_ROLE]) {
    for (const m of all(re)) {
      const val = cleanName(m[1]);
      if (!val || val.length < 2 || NAME_STOP.has(val)) continue;
      const s = m.indices[1][0];
      H.push(hit(s, s + val.length, 'NAME', val));
    }
  }
  for (const m of all(RE_NAME_LASTFIRST)) {
    if (NAME_STOP.has(m[1]) || NAME_STOP.has(m[2])) continue;
    H.push(hit(m.indices[1][0], m.indices[2][1], 'NAME', m[0]));
  }
  H.push(...nerHits(text, entities));

  // Eigene Begriffe
  for (const { term: raw, category } of customTerms) {
    const term = (raw || '').trim();
    if (!term) continue;
    const pat = new RegExp(`(?<!${W})${escapeRe(term).replace(/\s+/g, '\\s+')}(?!${W})`, 'giu');
    for (const m of text.matchAll(pat)) {
      H.push(hit(m.index, m.index + m[0].length, CATEGORIES[category] ? category : 'MANUELL', m[0], 'manual'));
    }
  }

  // Wert-Propagation: Nachnamen / Teilnamen aus vollständigen Namen
  H.push(...propagateNames(text, H));

  return resolveOverlaps(H.filter((h) => enabled.has(h.category)));
}

// Wenn 'Max Müller' erkannt wurde, wird auch 'Müller' (z. B. 'Herr Müller', 'Müllers') gefunden.
function propagateNames(text, hits) {
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    if (h.category !== 'NAME') continue;
    const toks = splitWs(h.value);
    const cand = new Set();
    if (toks.length >= 2) { cand.add(toks.at(-1)); cand.add(toks[0]); }
    for (let c of cand) {
      c = c.replace(/^,+|,+$/g, '');
      if (c.length < 4 || NAME_STOP.has(c) || seen.has(c) || COMMON_WORDS.has(c.toLowerCase())) continue;
      seen.add(c);
      const re = new RegExp(String.raw`(?<![\p{L}\p{N}_\-])${escapeRe(c)}(?:s)?(?![\p{L}\p{N}_\-])`, 'gu');
      for (const m of text.matchAll(re)) out.push(hit(m.index, m.index + m[0].length, 'NAME', m[0], 'propagated'));
    }
  }
  return out;
}

function resolveOverlaps(hits) {
  const rank = Object.fromEntries(PRIORITY.map((c, i) => [c, i]));
  // längere Treffer zuerst, bei Gleichstand höhere Priorität
  const sorted = [...hits].sort((a, b) => (b.end - b.start) - (a.end - a.start)
    || (rank[a.category] ?? 99) - (rank[b.category] ?? 99) || a.start - b.start);
  const taken = [];
  for (const h of sorted) {
    if (taken.some((t) => h.start < t.end && h.end > t.start)) continue;
    taken.push(h);
  }
  return taken.sort((a, b) => a.start - b.start);
}

function ibanOk(iban) {
  iban = iban.toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearr = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearr) {
    const v = parseInt(ch, 36);
    if (Number.isNaN(v)) return false;
    for (const d of String(v)) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

// --------------------------------------------------------------------------
// Mapping (Schlüssel) und Ersetzung
// --------------------------------------------------------------------------
// Whitespace-normalisiert, aber groß-/kleinschreibungs-sensitiv (exakte Rück-Ersetzung).
const norm = (v) => v.trim().replace(/\s+/g, ' ');

// Wert <-> Platzhalter. Ermöglicht die Rück-Ersetzung.
export class Mapping {
  constructor({ numbered = true, mode = 'platzhalter' } = {}) {
    this.numbered = numbered;
    this.mode = mode; // 'platzhalter' | 'schwaerzen'
    this.forward = new Map(); // "kategorie\u0000normalisierter Wert" -> Platzhalter
    this.values = {}; // Platzhalter -> Originalwert (erste Schreibweise)
    this.variants = {}; // Platzhalter -> Set aller Schreibweisen
    this.counters = {};
    this.sequence = []; // bei nicht-nummeriert: [Platzhalter, Original] in Reihenfolge
  }

  placeholderFor(category, value) {
    if (this.mode === 'schwaerzen') return '█'.repeat(Math.max(3, value.length));
    const key = category + '\u0000' + norm(value);
    let ph = this.forward.get(key);
    if (!ph) {
      const n = (this.counters[category] || 0) + 1;
      this.counters[category] = n;
      ph = this.numbered ? `[${category}-${n}]` : `[${category}]`;
      this.forward.set(key, ph);
      if (this.numbered) this.values[ph] = value;
    }
    if (this.numbered) (this.variants[ph] ||= new Set()).add(value);
    return ph;
  }

  toDict() {
    return {
      version: 1,
      numbered: this.numbered,
      mode: this.mode,
      values: this.values,
      variants: Object.fromEntries(Object.entries(this.variants).map(([k, v]) => [k, [...v].sort()])),
      sequence: this.sequence,
    };
  }

  static fromDict(d) {
    const m = new Mapping({ numbered: d.numbered ?? true, mode: d.mode || 'platzhalter' });
    m.values = d.values || {};
    m.variants = Object.fromEntries(Object.entries(d.variants || {}).map(([k, v]) => [k, new Set(v)]));
    m.sequence = (d.sequence || []).map((x) => [x[0], x[1]]);
    return m;
  }
}

// Ermittelt je einzigartigem Wert den Platzhalter (Reihenfolge des ersten Auftretens).
export function buildReplacements(hits, mapping) {
  const rep = new Map();
  for (const h of hits) if (!rep.has(h.value)) rep.set(h.value, mapping.placeholderFor(h.category, h.value));
  return rep;
}

// Regex für einen Wert: flexible Leerzeichen, Wortgrenzen nur wenn Rand ein Wortzeichen ist.
function valueRegex(value) {
  const v = value.trim();
  const body = escapeRe(v).replace(/\s+/g, '\\s+');
  return (isWordChar(v[0]) ? `(?<!${W})` : '') + body + (isWordChar(v.at(-1)) ? `(?!${W})` : '');
}

// Findet alle Vorkommen der zu ersetzenden Werte: [[start, ende, platzhalter]]
export function findSpans(text, rep) {
  if (!rep.size) return [];
  const lookup = new Map([...rep].map(([k, v]) => [norm(k), v]));
  const items = [...rep.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(items.map(valueRegex).join('|'), 'gu');
  const spans = [];
  for (const m of text.matchAll(re)) {
    const ph = lookup.get(norm(m[0]));
    if (ph !== undefined) spans.push([m.index, m.index + m[0].length, ph]);
  }
  return spans;
}

// Merkt sich Original je Platzhalter (für nicht nummerierte Platzhalter: Reihenfolge).
export function recordUse(mapping, ph, original) {
  if (!mapping || mapping.mode !== 'platzhalter') return;
  if (mapping.numbered) (mapping.variants[ph] ||= new Set()).add(original);
  else mapping.sequence.push([ph, original]);
}

export function applyText(text, rep, mapping) {
  const spans = findSpans(text, rep);
  if (!spans.length) return text;
  let out = '';
  let pos = 0;
  for (const [s, e, ph] of spans) {
    out += text.slice(pos, s) + ph;
    recordUse(mapping, ph, text.slice(s, e));
    pos = e;
  }
  return out + text.slice(pos);
}

// --------------------------------------------------------------------------
// Rück-Ersetzung
// --------------------------------------------------------------------------
const PH_SRC = String.raw`\[(?:${Object.keys(CATEGORIES).map(escapeRe).join('|')})(?:-\d+)?\]`;

export function findPlaceholders(text) {
  return [...text.matchAll(new RegExp(PH_SRC, 'g'))].map((m) => [m.index, m.index + m[0].length, m[0]]);
}

// Liefert eine Funktion Platzhalter -> Originalwert (bei nicht nummerierten Platzhaltern in Reihenfolge).
export function restorer(mapping) {
  if (mapping.mode === 'schwaerzen') throw new Error('Schwärzungen sind nicht umkehrbar – bitte das Original verwenden.');
  if (mapping.numbered) return (ph) => mapping.values[ph] ?? ph;
  const seq = mapping.sequence;
  let i = 0;
  return (ph) => {
    for (let j = i; j < seq.length; j++) {
      if (seq[j][0] === ph) { i = j + 1; return seq[j][1]; }
    }
    return ph;
  };
}

// Ersetzt Platzhalter wieder durch die Originalwerte.
export function restoreText(text, mapping) {
  const get = restorer(mapping);
  return text.replace(new RegExp(PH_SRC, 'g'), (ph) => get(ph));
}

// --------------------------------------------------------------------------
// Darstellung für die Oberfläche
// --------------------------------------------------------------------------
export const findingId = (h) => `${h.category}|${h.value}`;

export function groupFindings(hits) {
  const seen = new Map();
  for (const h of hits) {
    const id = findingId(h);
    if (!seen.has(id)) seen.set(id, { id, category: h.category, value: h.value, count: 0, source: h.source });
    seen.get(id).count += 1;
  }
  const order = Object.fromEntries(Object.keys(CATEGORIES).map((c, i) => [c, i]));
  const coll = new Intl.Collator('de', { sensitivity: 'base' });
  return [...seen.values()].sort((a, b) => (order[a.category] ?? 99) - (order[b.category] ?? 99) || coll.compare(a.value, b.value));
}

export function previewSegments(text, hits, limitChars) {
  const out = [];
  let pos = 0;
  const limit = Math.min(text.length, limitChars);
  for (const h of hits) {
    if (h.start >= limit) break;
    if (h.start > pos) out.push({ t: text.slice(pos, h.start) });
    out.push({ t: text.slice(h.start, h.end), id: findingId(h), c: h.category });
    pos = h.end;
  }
  if (pos < limit) out.push({ t: text.slice(pos, limit) });
  return out;
}
