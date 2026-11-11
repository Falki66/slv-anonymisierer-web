// Schlüsseldatei (.slvkey): enthält die Zuordnung Platzhalter -> Originalwert.
// Optional mit Passwort verschlüsselt: PBKDF2-HMAC-SHA256 (480 000 Iterationen) + Fernet
// (AES-128-CBC + HMAC-SHA256) – kompatibel mit den Schlüsseldateien der Desktop-Version.
import { Mapping } from './engine.js';

const ITER = 480_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_');
};
const unb64url = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/'));

async function deriveKeys(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, base, 256));
  const hmac = await crypto.subtle.importKey('raw', bits.slice(0, 16), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const aes = await crypto.subtle.importKey('raw', bits.slice(16), 'AES-CBC', false, ['encrypt', 'decrypt']);
  return { hmac, aes };
}

async function fernetEncrypt(keys, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, keys.aes, plain));
  const head = new Uint8Array(25);
  head[0] = 0x80;
  new DataView(head.buffer).setBigUint64(1, BigInt(Math.floor(Date.now() / 1000)));
  head.set(iv, 9);
  const body = new Uint8Array(head.length + ct.length);
  body.set(head); body.set(ct, head.length);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', keys.hmac, body));
  const token = new Uint8Array(body.length + 32);
  token.set(body); token.set(mac, body.length);
  return b64url(token);
}

async function fernetDecrypt(keys, token) {
  const raw = unb64url(token);
  if (raw.length < 57 || raw[0] !== 0x80) throw new Error('format');
  const body = raw.subarray(0, raw.length - 32);
  const ok = await crypto.subtle.verify('HMAC', keys.hmac, raw.subarray(raw.length - 32), body);
  if (!ok) throw new Error('mac');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: body.subarray(9, 25) }, keys.aes, body.subarray(25)));
}

export async function dumpKey(mapping, password = '', meta = {}) {
  const payload = { ...mapping.toDict(), meta };
  let out;
  if (password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const data = await fernetEncrypt(await deriveKeys(password, salt), enc.encode(JSON.stringify(payload)));
    out = { slv_key: 1, encrypted: true, salt: b64(salt), data };
  } else {
    out = { slv_key: 1, encrypted: false, data: payload };
  }
  return enc.encode(JSON.stringify(out, null, 1));
}

export function isEncrypted(blob) {
  try { return Boolean(JSON.parse(dec.decode(blob)).encrypted); } catch { return false; }
}

export async function loadKey(blob, password = '') {
  let d;
  try { d = JSON.parse(dec.decode(blob)); } catch {
    throw new Error('Die Schlüsseldatei ist beschädigt oder keine .slvkey-Datei.');
  }
  if (d.slv_key !== 1) throw new Error('Unbekanntes Schlüsseldatei-Format.');
  let payload;
  if (d.encrypted) {
    if (!password) throw new Error('Die Schlüsseldatei ist passwortgeschützt – bitte Passwort eingeben.');
    try {
      payload = JSON.parse(dec.decode(await fernetDecrypt(await deriveKeys(password, unb64(d.salt)), d.data)));
    } catch {
      throw new Error('Passwort falsch oder Schlüsseldatei beschädigt.');
    }
  } else {
    payload = d.data;
  }
  return Mapping.fromDict(payload);
}
