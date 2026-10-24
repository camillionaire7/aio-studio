'use strict';
// Local vault for addresses and credit cards.
// Stored in one file, encrypted with the OS keychain (Electron safeStorage) when available.
// Full card numbers never leave this module except through getCards(), which only the
// main process calls; the window only receives masked cards.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { lookupState, US_STATES, compareProfiles, sortProfiles } = require('./converter');
const editor = require('./editor');
const { jigKey } = require('./jig');

const uuid = () => crypto.randomUUID();
const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();
const fail = (error) => ({ ok: false, error });

// Retailers a login can be saved for. Pokémon Center has no accounts, so it is not offered; logins already
// saved under it (if any) are left alone and still shown.
const RETAILERS = ['target', 'walmart', 'other'];
const EMAIL_RE = /^[^\s@:|;]+@[^\s@:|;]+\.[A-Za-z]{2,}$/;
const DOMAIN_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

const US_CODES = new Set(US_STATES.map(([c]) => c));

function luhn(num) {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = Number(num[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function detectBrand(n) {
  if (/^4/.test(n)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/.test(n)) return 'Mastercard';
  if (/^3[47]/.test(n)) return 'Amex';
  if (/^(6011|65|64[4-9])/.test(n)) return 'Discover';
  return 'Card';
}

function normExp(mm, yy) {
  const m = parseInt(str(mm), 10);
  let y = str(yy);
  if (y.length === 2) y = '20' + y;
  const yn = parseInt(y, 10);
  if (!(m >= 1 && m <= 12) || !(yn >= 2000 && yn <= 2100)) return null;
  return { month: String(m).padStart(2, '0'), year: yn };
}

function validateCard(input, opts = {}) {
  const lenient = !!opts.lenient;
  const now = opts.now || new Date();
  const number = str(input.number).replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(number)) return fail('Card number must be 13 to 19 digits.');
  if (!lenient && !luhn(number)) return fail('That card number fails the check-digit test. Re-check it, or tick "Test card".');
  const exp = normExp(input.expMonth, input.expYear);
  if (!exp) return fail('Enter a valid expiry month (1-12) and year.');
  if (!lenient && (exp.year < now.getFullYear() || (exp.year === now.getFullYear() && Number(exp.month) < now.getMonth() + 1))) {
    return fail('That card is expired.');
  }
  const cvv = str(input.cvv);
  const brand = detectBrand(number);
  if (!/^\d{3,4}$/.test(cvv)) return fail('CVV must be 3 or 4 digits.');
  if (!lenient && brand === 'Amex' && cvv.length !== 4) return fail('Amex cards use a 4-digit CVV.');
  if (!lenient && brand !== 'Amex' && cvv.length !== 3) return fail('CVV should be 3 digits.');
  return {
    ok: true,
    card: {
      id: uuid(),
      number,
      holder: str(input.holder),
      nickname: str(input.nickname).slice(0, 40),
      expMonth: exp.month,
      expYear: exp.year,
      cvv,
      brand,
      used: false,
      usedIn: null,
      createdAt: new Date().toISOString(),
    },
  };
}

class VaultStore {
  constructor(file, cryptoApi) {
    this.file = file;
    this.crypto = cryptoApi || null;
    this.data = { addresses: [], cards: [], groups: [], accounts: [], domains: [], imports: [], usedJigs: [] };
    this.loadError = null;
    this._load();
  }

  encrypted() {
    return !!(this.crypto && this.crypto.available());
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return;
      this.loadError = 'Could not read the vault file.';
      return;
    }
    try {
      const env = JSON.parse(raw);
      const data = env.enc
        ? JSON.parse(this.crypto.decrypt(Buffer.from(env.data, 'base64')))
        : env.data;
      this.data = {
        addresses: Array.isArray(data.addresses) ? data.addresses : [],
        cards: Array.isArray(data.cards) ? data.cards : [],
        groups: Array.isArray(data.groups) ? data.groups : [],
        accounts: Array.isArray(data.accounts) ? data.accounts : [],
        domains: Array.isArray(data.domains) ? data.domains : [],
        imports: Array.isArray(data.imports) ? data.imports : [],
        usedJigs: Array.isArray(data.usedJigs) ? data.usedJigs : [],
      };
    } catch (e) {
      // Keep the unreadable file instead of overwriting it.
      try { fs.renameSync(this.file, `${this.file}.unreadable-${Date.now()}`); } catch (e2) { /* ignore */ }
      this.loadError = 'The vault file could not be decrypted (it may belong to another Windows user). It was set aside and a new empty vault was started.';
    }
  }

  _save() {
    const json = JSON.stringify(this.data);
    const env = this.encrypted()
      ? { v: 1, enc: true, data: this.crypto.encrypt(json).toString('base64') }
      : { v: 1, enc: false, data: this.data };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  snapshot() {
    return {
      encrypted: this.encrypted(),
      loadError: this.loadError,
      addresses: this.data.addresses.map((a) => ({ ...a })),
      groups: this.data.groups.map((g) => JSON.parse(JSON.stringify(g))),
      domains: this.data.domains.map((d) => ({ ...d })),
      usedJigs: this.data.usedJigs.map((j) => ({ ...j })),
      // imported profile files (card numbers and CVVs stay in this module)
      imports: this.data.imports.map((rec) => {
        const a = editor.analyze(rec.profiles);
        return {
          id: rec.id, name: rec.name, fileName: rec.fileName, format: rec.format, createdAt: rec.createdAt,
          source: rec.source === 'built' ? 'built' : 'imported', site: rec.site || '', builtFrom: rec.builtFrom || '',
          count: rec.profiles.length, counts: a.counts,
          // shown alphabetically by profile name (the stored order is untouched)
          profiles: rec.profiles.map((p, i) => editor.publicProfile(p, a.flags[i])).sort(compareProfiles),
        };
      }),
      // account passwords never leave this module
      accounts: this.data.accounts.map((a) => ({ id: a.id, retailer: a.retailer, email: a.email, createdAt: a.createdAt, used: !!a.used, usedIn: a.usedIn || null })),
      cards: this.data.cards.map((c) => ({
        id: c.id,
        brand: c.brand,
        last4: c.number.slice(-4),
        holder: c.holder,
        nickname: c.nickname || '',
        createdAt: c.createdAt || null,
        expMonth: c.expMonth,
        expYear: c.expYear,
        used: !!c.used,
        usedIn: c.usedIn || null,
      })),
    };
  }

  // ---- addresses
  _checkAddress(input, selfId) {
    const i = input || {};
    const line1 = str(i.line1);
    const line2 = str(i.line2);
    const city = str(i.city);
    const zip = str(i.zip);
    const state = lookupState(i.state);
    if (!line1) return fail('Enter the street address.');
    if (!city) return fail('Enter the city.');
    if (!state || !US_CODES.has(state.shortCode)) return fail('Pick a state.');
    if (!/^\d{5}(-\d{4})?$/.test(zip)) return fail('Enter a 5-digit ZIP code.');
    const dupe = this.data.addresses.some((a) => a.id !== selfId &&
      a.line1.toLowerCase() === line1.toLowerCase() && a.line2.toLowerCase() === line2.toLowerCase() && a.zip === zip);
    if (dupe) return fail('That address is already in the vault.');
    return { ok: true, fields: { line1, line2, city, state, zip } };
  }

  addAddress(input) {
    const c = this._checkAddress(input, null);
    if (!c.ok) return c;
    this.data.addresses.push({ id: uuid(), ...c.fields, country: 'United States', createdAt: new Date().toISOString() });
    this._save();
    return { ok: true };
  }

  updateAddress(id, input) {
    const a = this.data.addresses.find((x) => x.id === str(id));
    if (!a) return fail('Address not found.');
    const c = this._checkAddress(input, a.id);
    if (!c.ok) return c;
    Object.assign(a, c.fields); // keeps the id, so saved selections still point at it
    this._save();
    return { ok: true };
  }

  deleteAddress(id) {
    const n = this.data.addresses.length;
    this.data.addresses = this.data.addresses.filter((a) => a.id !== str(id));
    if (this.data.addresses.length === n) return fail('Address not found.');
    this._save();
    return { ok: true };
  }

  getAddress(id) {
    return this.data.addresses.find((a) => a.id === str(id)) || null;
  }

  // ---- cards
  addCard(input, opts) {
    const v = validateCard(input || {}, opts);
    if (!v.ok) return v;
    if (this.data.cards.some((c) => c.number === v.card.number)) return fail('That card is already in the vault.');
    this.data.cards.push(v.card);
    this._save();
    return { ok: true };
  }

  // One card per line: [nickname:]number:MM:YY:CVV, with a 2 or 4 digit year.
  // Also accepts | , ; / or spaces between fields. Everything before the card number is the nickname.
  addCardsBulk(text, opts = {}) {
    const holder = str(opts.holder);
    const SEP = '[\\s|,;:/]+';
    const LINE = new RegExp(`^(.*?)${SEP.replace('+', '*')}(\\d[\\d-]{11,22}\\d)${SEP}(\\d{1,2})${SEP}(\\d{2}|\\d{4})${SEP}(\\d{3,4})\\s*$`);
    let added = 0;
    const skipped = [];
    String(text || '').split(/\r?\n/).forEach((line, idx) => {
      if (!line.trim()) return;
      const m = LINE.exec(line.trim());
      if (!m) { skipped.push({ line: idx + 1, reason: 'Expected [nickname:]number:MM:YY:CVV.' }); return; }
      const nickname = m[1].replace(/[\s|,;:/]+$/, '').trim() || str(opts.nickname);
      const v = validateCard({ number: m[2], expMonth: m[3], expYear: m[4], cvv: m[5], holder, nickname }, opts);
      if (!v.ok) { skipped.push({ line: idx + 1, reason: v.error }); return; }
      if (this.data.cards.some((c) => c.number === v.card.number)) { skipped.push({ line: idx + 1, reason: 'Already in the vault.' }); return; }
      this.data.cards.push(v.card);
      added++;
    });
    if (added) this._save();
    return { ok: true, added, skipped };
  }

  deleteCard(id) {
    const n = this.data.cards.length;
    this.data.cards = this.data.cards.filter((c) => c.id !== str(id));
    if (this.data.cards.length === n) return fail('Card not found.');
    this._save();
    return { ok: true };
  }

  setCardUsed(id, used) {
    const c = this.data.cards.find((x) => x.id === str(id));
    if (!c) return fail('Card not found.');
    c.used = !!used;
    if (!c.used) c.usedIn = null;
    else if (!c.usedIn) c.usedIn = { batch: 'Marked manually', site: '', date: new Date().toISOString() };
    this._save();
    return { ok: true };
  }

  markUsed(ids, info) {
    const set = new Set((ids || []).map(str));
    this.data.cards.forEach((c) => {
      if (set.has(c.id)) { c.used = true; c.usedIn = { ...info }; }
    });
    this._save();
  }

  // Drag-and-drop ordering of saved addresses / catch-all domains. Ids not listed keep their place at the end.
  reorder(kind, ids) {
    const key = kind === 'addresses' ? 'addresses' : kind === 'domains' ? 'domains' : null;
    if (!key) return fail('Unknown list.');
    const left = new Map(this.data[key].map((x) => [x.id, x]));
    const out = [];
    (Array.isArray(ids) ? ids : []).forEach((id) => { const x = left.get(str(id)); if (x) { out.push(x); left.delete(str(id)); } });
    left.forEach((x) => out.push(x));
    this.data[key] = out;
    this._save();
    return { ok: true };
  }

  // ---- catch-all domains
  addDomain(input) {
    const domain = str(input).replace(/^@+/, '').toLowerCase();
    if (!DOMAIN_RE.test(domain)) return fail('Enter a domain like yourdomain.com (no @ or spaces).');
    if (this.data.domains.some((d) => d.domain === domain)) return fail('That domain is already in the vault.');
    this.data.domains.push({ id: uuid(), domain, createdAt: new Date().toISOString() });
    this._save();
    return { ok: true };
  }

  deleteDomain(id) {
    const n = this.data.domains.length;
    this.data.domains = this.data.domains.filter((d) => d.id !== str(id));
    if (this.data.domains.length === n) return fail('Domain not found.');
    this._save();
    return { ok: true };
  }

  // ---- used address jigs
  // Every address variation that went out in an export is remembered, so the Builder never generates it again.
  // Re-adding one (or all) from the Vault makes it available to the Builder again.
  // Used per retailer: for a retailer, the jigs used on that retailer plus the ones with no retailer set (those count
  // everywhere). With no retailer given, every used jig counts.
  usedJigKeys(site) {
    const s = str(site);
    return new Set(this.data.usedJigs.filter((j) => !s || !j.site || j.site === s).map((j) => j.key));
  }

  listUsedJigs() {
    return this.data.usedJigs.map((j) => ({ ...j }));
  }

  recordJigs(profiles, info) {
    const site = str(info && info.site);
    const have = new Set(this.data.usedJigs.map((j) => `${j.key}|${j.site || ''}`)); // the same address on another retailer is a separate entry
    let added = 0;
    (profiles || []).forEach((p) => {
      const a = p.address || {};
      // the whole street line as a retailer sees it: line 1, plus line 2 when a profile has one (Builder jigs have none)
      const line = [a.line1, a.line2].map(str).filter(Boolean).join(' ');
      const key = jigKey(line, a.zip);
      if (!line || have.has(`${key}|${site}`)) return;
      have.add(`${key}|${site}`);
      this.data.usedJigs.push({
        id: uuid(), key, line1: line, city: str(a.city), state: str(a.state && (a.state.shortCode || a.state)), zip: str(a.zip),
        batch: str(info && info.batch), site, format: str(info && info.format), source: str(info && info.source), importId: str(info && info.importId),
        date: (info && info.date) || new Date().toISOString(),
      });
      added++;
    });
    if (added) this._save();
    return added;
  }

  // Change the retailer of an Editor file, and of the jigs that came in with it when it was imported.
  // Rename an imported or built file (the label shown in the Editor; also the batch name on its Used Jigs entries).
  renameImport(id, name) {
    const rec = this.data.imports.find((r) => r.id === str(id));
    if (!rec) return fail('Imported file not found.');
    const n = str(name).trim().slice(0, 60);
    if (!n) return fail('Enter a name.');
    rec.name = n;
    this.data.usedJigs.forEach((j) => { if (j.importId === rec.id) j.batch = n; });
    this._save();
    return { ok: true };
  }

  setImportSite(id, site) {
    const rec = this.data.imports.find((r) => r.id === str(id));
    if (!rec) return fail('Imported file not found.');
    const s = str(site);
    rec.site = s;
    let updated = 0;
    this.data.usedJigs.forEach((j) => { if (j.importId === rec.id) { j.site = s; updated++; } });
    const seen = new Set(); // two entries for the same address and retailer collapse into one
    this.data.usedJigs = this.data.usedJigs.filter((j) => { const k = `${j.key}|${j.site || ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
    this._save();
    return { ok: true, updated };
  }

  removeJig(id) {
    const n = this.data.usedJigs.length;
    this.data.usedJigs = this.data.usedJigs.filter((j) => j.id !== str(id));
    if (this.data.usedJigs.length === n) return fail('That jig is not in the list.');
    this._save();
    return { ok: true };
  }

  clearJigs() {
    this.data.usedJigs = [];
    this._save();
    return { ok: true };
  }

  // ---- retailer accounts (email + password)
  _checkAccount(retailer, email, password) {
    if (!RETAILERS.includes(retailer)) return fail('Pick a retailer.');
    const e = str(email);
    if (!EMAIL_RE.test(e)) return fail('Enter a valid email address.');
    if (!str(password)) return fail('Enter the password.');
    if (this.data.accounts.some((a) => a.retailer === retailer && a.email.toLowerCase() === e.toLowerCase())) {
      return fail('That account is already in the vault for this retailer.');
    }
    return { ok: true, email: e };
  }

  addAccount(input) {
    const i = input || {};
    const c = this._checkAccount(str(i.retailer), i.email, i.password);
    if (!c.ok) return c;
    this.data.accounts.push({ id: uuid(), retailer: str(i.retailer), email: c.email, password: String(i.password), createdAt: new Date().toISOString() });
    this._save();
    return { ok: true };
  }

  // One account per line: email:password (the password may contain colons).
  addAccountsBulk(text, opts = {}) {
    const retailer = str(opts.retailer);
    if (!RETAILERS.includes(retailer)) return fail('Pick a retailer.');
    let added = 0;
    const skipped = [];
    String(text || '').split(/\r?\n/).forEach((line, idx) => {
      if (!line.trim()) return;
      const m = /^\s*([^:|;\t]+?)\s*[:|;\t]\s*(.+?)\s*$/.exec(line);
      if (!m) { skipped.push({ line: idx + 1, reason: 'Expected email:password.' }); return; }
      const c = this._checkAccount(retailer, m[1], m[2]);
      if (!c.ok) { skipped.push({ line: idx + 1, reason: c.error }); return; }
      this.data.accounts.push({ id: uuid(), retailer, email: c.email, password: m[2], createdAt: new Date().toISOString() });
      added++;
    });
    if (added) this._save();
    return { ok: true, added, skipped };
  }

  deleteAccount(id) {
    const n = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter((a) => a.id !== str(id));
    if (this.data.accounts.length === n) return fail('Account not found.');
    this._save();
    return { ok: true };
  }

  // Accounts used as the emails of a built batch are marked "in use" (like cards), so the next build only offers fresh ones.
  markAccountsUsed(ids, info) {
    const set = new Set((ids || []).map(str));
    this.data.accounts.forEach((a) => { if (set.has(a.id)) { a.used = true; a.usedIn = { ...info }; } });
    this._save();
  }

  setAccountUsed(id, used) {
    const a = this.data.accounts.find((x) => x.id === str(id));
    if (!a) return fail('Account not found.');
    a.used = !!used;
    if (!a.used) a.usedIn = null;
    else if (!a.usedIn) a.usedIn = { batch: 'Marked manually', site: a.retailer, date: new Date().toISOString() };
    this._save();
    return { ok: true };
  }

  // Every account, or one retailer's, in vault order (main process only; used by the account export).
  listAccounts(retailer) {
    const r = str(retailer);
    return this.data.accounts.filter((a) => !r || a.retailer === r);
  }

  // Accounts for the given ids, in vault order (main process only).
  getAccounts(ids) {
    const set = new Set((ids || []).map(str));
    return this.data.accounts.filter((a) => set.has(a.id));
  }

  // ---- imported profile files (Editor tab)
  // source: 'imported' (a file dropped/picked in the Editor, or opened from Recently converted) or
  // 'built' (sent over from the Builder). builtFrom = the saved group id, or '' for a not-yet-exported batch.
  addImport({ name, fileName, format, profiles, source, site, builtFrom }) {
    const rec = {
      id: uuid(), name: str(name) || 'Imported profiles', fileName: str(fileName), format, createdAt: new Date().toISOString(), profiles,
      source: source === 'built' ? 'built' : 'imported', site: str(site), builtFrom: str(builtFrom),
    };
    this.data.imports.unshift(rec);
    this._save();
    return rec.id;
  }

  getImport(id) {
    return this.data.imports.find((r) => r.id === str(id)) || null;
  }

  // The Editor copy of a saved group, if the group was already sent there.
  getImportBuiltFrom(groupId) {
    return this.data.imports.find((r) => r.source === 'built' && r.builtFrom && r.builtFrom === str(groupId)) || null;
  }

  getGroup(id) {
    return this.data.groups.find((g) => g.id === str(id)) || null;
  }

  deleteImport(id) {
    const n = this.data.imports.length;
    this.data.imports = this.data.imports.filter((r) => r.id !== str(id));
    if (this.data.imports.length === n) return fail('Imported file not found.');
    this._save();
    return { ok: true };
  }

  commit() { this._save(); } // after editing an import in place

  // ---- saved profile groups (profiles hold only a card reference + last 4, never the full number)
  addGroup({ name, site, format, profiles }) {
    let finalName = str(name) || 'Group';
    const taken = new Set(this.data.groups.map((g) => g.name.toLowerCase()));
    for (let n = 2; taken.has(finalName.toLowerCase()); n++) finalName = `${str(name)} (${n})`;
    const group = {
      id: uuid(),
      name: finalName,
      site: str(site),
      createdAt: new Date().toISOString(),
      formats: [format],
      profiles: sortProfiles(profiles).map((p) => ({ // saved alphabetically, like the exports
        name: p.name,
        first: p.first,
        last: p.last,
        email: p.email,
        phone: p.phone || '',
        address: {
          line1: p.address.line1, line2: p.address.line2, city: p.address.city,
          state: { shortCode: p.address.state.shortCode, name: p.address.state.name }, zip: p.address.zip,
        },
        cardId: p.card.id,
        cardBrand: p.card.brand,
        cardLast4: p.card.number.slice(-4),
      })),
    };
    this.data.groups.unshift(group);
    this._save();
    return group.id;
  }

  addGroupFormat(id, format) {
    const g = this.data.groups.find((x) => x.id === str(id));
    if (!g || g.formats.includes(format)) return;
    g.formats.push(format);
    this._save();
  }

  // Rename a saved group (names stay unique, like when a group is first saved).
  renameGroup(id, name) {
    const g = this.data.groups.find((x) => x.id === str(id));
    if (!g) return fail('Group not found.');
    const base = str(name).slice(0, 60);
    if (!base) return fail('Enter a group name.');
    if (base === g.name) return { ok: true };
    let finalName = base;
    const taken = new Set(this.data.groups.filter((x) => x !== g).map((x) => x.name.toLowerCase()));
    for (let n = 2; taken.has(finalName.toLowerCase()); n++) finalName = `${base} (${n})`;
    g.name = finalName;
    this._save();
    return { ok: true };
  }

  // Delete everything in one Vault section.
  deleteAll(kind) {
    const keys = { addresses: 'addresses', cards: 'cards', domains: 'domains', accounts: 'accounts' };
    const key = keys[kind];
    if (!key) return fail('Unknown list.');
    this.data[key] = [];
    this._save();
    return { ok: true };
  }

  deleteGroup(id) {
    const n = this.data.groups.length;
    this.data.groups = this.data.groups.filter((g) => g.id !== str(id));
    if (this.data.groups.length === n) return fail('Group not found.');
    this._save();
    return { ok: true };
  }

  // Full cards (main process only), in vault order.
  getCards(ids) {
    const set = new Set((ids || []).map(str));
    return this.data.cards.filter((c) => set.has(c.id));
  }

  // ---- backup / restore / wipe (main process only: this is the full data, card numbers and passwords included)
  exportData() {
    return JSON.parse(JSON.stringify(this.data));
  }

  // Check data that came from a backup file. -> { ok, data } (a clean copy with all six lists) or { ok: false, error }.
  validateData(raw) {
    const bad = (what) => ({ ok: false, error: `The backup is damaged (${what}).` });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('no vault data');
    const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
    const s = (x) => typeof x === 'string';
    const out = {};
    for (const key of ['addresses', 'cards', 'groups', 'accounts', 'domains', 'imports', 'usedJigs']) {
      const list = raw[key] === undefined ? [] : raw[key];
      if (!Array.isArray(list)) return bad(`${key} is not a list`);
      out[key] = list;
    }
    if (!out.addresses.every((a) => isObj(a) && s(a.id) && s(a.line1) && s(a.city) && s(a.zip) && isObj(a.state))) return bad('an address is incomplete');
    if (!out.cards.every((c) => isObj(c) && s(c.id) && s(c.number) && /^\d{13,19}$/.test(c.number))) return bad('a card is incomplete');
    if (!out.domains.every((d) => isObj(d) && s(d.id) && s(d.domain))) return bad('a domain is incomplete');
    if (!out.accounts.every((a) => isObj(a) && s(a.id) && s(a.email) && s(a.password) && s(a.retailer))) return bad('an account is incomplete');
    if (!out.groups.every((g) => isObj(g) && s(g.id) && s(g.name) && Array.isArray(g.profiles) && Array.isArray(g.formats))) return bad('a saved group is incomplete');
    if (!out.usedJigs.every((j) => isObj(j) && s(j.id) && s(j.line1) && s(j.key))) return bad('a used address jig is incomplete');
    const profileOk = (p) => isObj(p) && s(p.id) && isObj(p.address) && isObj(p.address.state) && isObj(p.orig) && isObj(p.card) && s(p.card.number);
    if (!out.imports.every((r) => isObj(r) && s(r.id) && s(r.name) && Array.isArray(r.profiles) && r.profiles.every(profileOk))) return bad('an Editor file is incomplete');
    return { ok: true, data: JSON.parse(JSON.stringify(out)) };
  }

  _safetyCopies() {
    const dir = path.dirname(this.file);
    const prefix = `${path.basename(this.file)}.pre-restore-`;
    try { return fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort().map((n) => path.join(dir, n)); } catch (e) { return []; }
  }

  // Replace everything with restored data. The current vault file is kept next to it as "vault.json.pre-restore-<time>"
  // (still encrypted with this Windows login); only the newest three copies are kept.
  replaceAll(raw) {
    const v = this.validateData(raw);
    if (!v.ok) return v;
    let safetyCopy = false;
    try {
      if (fs.existsSync(this.file)) {
        fs.copyFileSync(this.file, `${this.file}.pre-restore-${Date.now()}`);
        safetyCopy = true;
        this._safetyCopies().slice(0, -3).forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } });
      }
    } catch (e) { /* the safety copy is best-effort */ }
    this.data = v.data;
    this.loadError = null;
    this._save();
    return { ok: true, safetyCopy };
  }

  // Erase everything, including the safety copies a restore left behind.
  wipe() {
    this.data = { addresses: [], cards: [], groups: [], accounts: [], domains: [], imports: [], usedJigs: [] };
    this.loadError = null;
    this._save();
    this._safetyCopies().forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } });
    return { ok: true };
  }
}

module.exports = { VaultStore, validateCard, luhn, detectBrand };
