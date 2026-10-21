'use strict';
// Global backup / restore / wipe. Electron-free (dialogs and file access are injected) so it can be tested directly.
//
// A backup is ONE password-protected file holding everything the app stores: the vault (addresses, full card numbers,
// catch-all domains, retailer logins, saved groups, Editor files), the Recently converted list and the Hayha / Polar paths.
// It is encrypted with a password you choose (scrypt + AES-256-GCM), NOT with the Windows login, so it can be restored
// on another computer. There is no way to recover a backup without its password.
//
// The decrypted contents stay in this (main) process: the window only ever sees counts.

const crypto = require('crypto');

const MAGIC = 'aio-studio-backup';
const VERSION = 1;
const KDF = { N: 32768, r: 8, p: 1 }; // fixed for v1; a file asking for anything else is refused
const MIN_PASSWORD = 8;
const FILE_EXT = 'aiobak';

const fail = (error) => ({ ok: false, error });

function deriveKey(password, salt) {
  return crypto.scryptSync(String(password), salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 128 * 1024 * 1024 });
}
const aad = () => Buffer.from(`${MAGIC}:v${VERSION}`);

// payload (plain object) -> backup file text
function encryptPayload(payload, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(password, salt), iv);
  cipher.setAAD(aad());
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return JSON.stringify({
    app: MAGIC, v: VERSION, kdf: 'scrypt', ...KDF,
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64'),
  });
}

// backup file text -> payload. Throws Error with a user-readable message.
function decryptPayload(text, password) {
  let env;
  try { env = JSON.parse(String(text)); } catch (e) { throw new Error('That file is not an AIO Studio backup.'); }
  if (!env || env.app !== MAGIC) throw new Error('That file is not an AIO Studio backup.');
  if (env.v !== VERSION) throw new Error('This backup was made by a newer version of the app. Update the app and try again.');
  if (env.kdf !== 'scrypt' || env.N !== KDF.N || env.r !== KDF.r || env.p !== KDF.p) throw new Error('This backup file uses settings this version does not support.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(password, Buffer.from(env.salt, 'base64')), Buffer.from(env.iv, 'base64'));
    decipher.setAAD(aad());
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  } catch (e) {
    throw new Error('Wrong password, or the backup file is damaged.');
  }
}

const two = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

function createBackupService({ vault, history, launcher, showSave, showOpen, readFile, writeFile, onChange = () => {}, now = () => new Date() }) {
  let pending = null; // a decrypted, validated backup waiting for the user's final "replace" click

  const counts = (p) => ({
    addresses: p.vault.addresses.length,
    cards: p.vault.cards.length,
    domains: p.vault.domains.length,
    accounts: p.vault.accounts.length,
    groups: p.vault.groups.length,
    imports: p.vault.imports.length,
    history: p.history.length,
  });

  return {
    // Save everything to a password-protected file.
    'data:backup': async (password) => {
      if (typeof password !== 'string' || password.length < MIN_PASSWORD) return fail(`Choose a password of at least ${MIN_PASSWORD} characters.`);
      const filePath = await showSave({ defaultPath: `aio-studio-backup-${stamp(now())}.${FILE_EXT}`, ext: FILE_EXT });
      if (!filePath) return { ok: false, canceled: true };
      const payload = {
        exportedAt: now().toISOString(),
        vault: vault.exportData(),
        history: history.list(),
        appPaths: launcher.exportPaths(),
      };
      try { writeFile(filePath, encryptPayload(payload, password)); } catch (e) { return fail(e.message || 'Could not write the backup file.'); }
      return { ok: true, filePath, counts: counts(payload) };
    },

    // Step 1 of a restore: pick the file, decrypt and check it. Nothing is changed yet.
    'data:restorePrepare': async (password) => {
      pending = null;
      if (typeof password !== 'string' || !password) return fail('Enter the password this backup was made with.');
      const filePath = await showOpen({ ext: FILE_EXT });
      if (!filePath) return { ok: false, canceled: true };
      let payload;
      try { payload = decryptPayload(readFile(filePath), password); } catch (e) { return fail(e.message); }
      const v = vault.validateData(payload && payload.vault);
      if (!v.ok) return fail(v.error);
      const hist = Array.isArray(payload.history) ? payload.history.filter((i) => i && i.id && i.fileName) : [];
      pending = { vault: v.data, history: hist, appPaths: payload.appPaths && typeof payload.appPaths === 'object' ? payload.appPaths : {} };
      return { ok: true, exportedAt: payload.exportedAt || '', counts: counts(pending) };
    },

    // Step 2: replace everything with the backup chosen in step 1.
    'data:restoreApply': () => {
      if (!pending) return fail('Choose a backup file first.');
      const p = pending;
      pending = null;
      const r = vault.replaceAll(p.vault); // keeps a safety copy of the current vault file
      if (!r.ok) return r;
      history.replace(p.history);
      launcher.importPaths(p.appPaths);
      onChange();
      return { ok: true, safetyCopy: !!r.safetyCopy, counts: counts(p), snapshot: vault.snapshot() };
    },

    'data:restoreCancel': () => { pending = null; return { ok: true }; },

    // Erase everything the app stores. The caller has to send the word WIPE.
    'data:wipe': (confirmText) => {
      if (confirmText !== 'WIPE') return fail('Type WIPE to confirm.');
      pending = null;
      vault.wipe();
      history.clear();
      launcher.clearAll();
      onChange();
      return { ok: true, snapshot: vault.snapshot() };
    },
  };
}

module.exports = { createBackupService, encryptPayload, decryptPayload, MIN_PASSWORD, FILE_EXT };
