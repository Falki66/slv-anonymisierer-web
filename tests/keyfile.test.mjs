// Schlüsseldatei: Verschlüsselung hin und zurück sowie Kompatibilität mit der Desktop-Version.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Mapping } from '../src/engine.js';
import { dumpKey, loadKey, isEncrypted } from '../src/keyfile.js';

const desktop = readFileSync(new URL('./fixtures/desktop.slvkey', import.meta.url));
assert.ok(isEncrypted(desktop));
const m1 = await loadKey(desktop, 'Test-Passwort-123');
assert.equal(m1.values['[NAME-1]'], 'Max Müller');
await assert.rejects(loadKey(desktop, 'falsch'), /Passwort falsch/);

const m = new Mapping();
m.placeholderFor('NAME', 'Özlem Ünal');
const blob = await dumpKey(m, 'geheim', { quelle: 'x' });
assert.equal((await loadKey(blob, 'geheim')).values['[NAME-1]'], 'Özlem Ünal');
assert.equal((await loadKey(await dumpKey(m))).values['[NAME-1]'], 'Özlem Ünal');
if (process.argv[2]) writeFileSync(process.argv[2], blob); // für die Gegenprobe mit Python
console.log('OK: Schlüsseldatei – Desktop-Datei lesbar, Verschlüsselung hin und zurück.');
