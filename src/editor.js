'use strict';
// Profile editor: import Hayha / Polar profile files, flag duplicates, and re-jig addresses.
// Pure functions (no Electron). Full card data stays in the main process; the window only gets masked profiles.

const crypto = require('crypto');
const { lookupState, buildHayhaFile, buildPolarFile } = require('./converter');
const { jigAddress, parseAddress } = require('./jig');

const str = (v) => (v === undefined || v === null ? '' : String(v));
const trim = (v) => str(v).trim();
const uuid = () => crypto.randomUUID();

function detectBrand(n) {
  if (/^4/.test(n)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/.test(n)) return 'Mastercard';
  if (/^3[47]/.test(n)) return 'Amex';
  if (/^(6011|65|64[4-9])/.test(n)) return 'Discover';
  return 'Card';
}

const normState = (v) => lookupState(v) || { shortCode: trim(v && v.shortCode ? v.shortCode : v), name: trim(v && v.name ? v.name : v) };

function makeProfile({ name, first, last, email, phone, line1, line2, city, state, zip, country, card }) {
  const number = str(card.number).replace(/[\s-]/g, '');
  return {
    id: uuid(),
    name: trim(name),
    first: trim(first),
    last: trim(last),
    email: trim(email),
    phone: trim(phone),
    address: { line1: trim(line1), line2: trim(line2), city: trim(city), state: normState(state), zip: trim(zip), country: trim(country) || 'United States' },
    orig: { line1: trim(line1), line2: trim(line2) }, // the address as imported; re-jigging always starts from this
    card: {
      number,
      holder: trim(card.holder),
      expMonth: trim(card.expMonth),
      expYear: trim(card.expYear),
      cvv: trim(card.cvv),
      brand: detectBrand(number),
    },
  };
}

// -> { format: 'hayha' | 'polar', groupName, profiles, warnings }
function parseProfilesFile(text) {
  let data;
  try { data = JSON.parse(String(text)); } catch (e) { throw new Error('That file is not valid JSON, so it cannot be read as a Hayha or Polar profile file.'); }
  const warnings = [];
  if (Array.isArray(data)) {
    if (!data.length) throw new Error('This Hayha file is empty.');
    if (!(data[0].cardInfo || data[0].shipping)) throw new Error('This looks like a Hayha accounts file. Import a profiles file here.');
    const profiles = [];
    data.forEach((p, i) => {
      const label = trim(p.name) || `#${i + 1}`;
      if (p.encrypted) { warnings.push(`Skipped "${label}": it is encrypted in Hayha. Export it unencrypted first.`); return; }
      const s = p.shipping || {};
      const c = p.cardInfo || {};
      profiles.push(makeProfile({
        name: p.name, first: s.firstName, last: s.lastName, email: s.email, phone: s.phone,
        line1: s.address, line2: s.address2, city: s.city, state: s.state, zip: s.zipCode, country: s.country,
        card: { number: c.cardNumber, holder: c.holder, expMonth: c.expMonth, expYear: c.expYear, cvv: c.cvv },
      }));
    });
    if (!profiles.length) throw new Error('Every profile in this file is encrypted, so nothing could be imported.');
    return { format: 'hayha', groupName: '', profiles, warnings };
  }
  if (data && data.polarExport) {
    if (data.polarExport.kind !== 'profiles') throw new Error('This looks like a Polar accounts file. Import a profiles file here.');
    const list = data.polarExport.profiles || [];
    if (!list.length) throw new Error('This Polar file has no profiles.');
    const profiles = list.map((p) => {
      const a = p.shippingAddress || {};
      const pay = p.paymentDetails || {};
      const parts = trim(a.name).split(/\s+/).filter(Boolean);
      const first = parts.shift() || '';
      if (p.sameBillingAndShippingAddress === false) {
        const b = p.billingAddress || {};
        if (['line1', 'line2', 'city', 'state', 'postCode'].some((k) => trim(b[k]) !== trim(a[k]))) {
          warnings.push(`"${trim(p.name) || first}" has a different billing address in Polar. The shipping address is used for both.`);
        }
      }
      return makeProfile({
        name: p.name, first, last: parts.join(' '), email: a.email, phone: a.phone,
        line1: a.line1, line2: [a.line2, a.line3].map(trim).filter(Boolean).join(' '), city: a.city, state: a.state, zip: a.postCode, country: a.country,
        card: { number: pay.cardNumber, holder: pay.nameOnCard, expMonth: pay.cardExpMonth, expYear: pay.cardExpYear, cvv: pay.cardCvv },
      });
    });
    return { format: 'polar', groupName: trim(data.polarExport.profileGroup), profiles, warnings };
  }
  throw new Error('Unrecognized file. Expected a Hayha (.hayha) or Polar (.json) profiles export.');
}

// ---------------------------------------------------------------- duplicates

const addrKey = (a) => `${`${a.line1} ${a.line2}`.toLowerCase().replace(/[.,#-]/g, '').replace(/\s+/g, ' ').trim()}|${trim(a.zip).slice(0, 5)}`;
const nameKey = (p) => `${p.first} ${p.last}`.toLowerCase().replace(/\s+/g, ' ').trim();
const emailKey = (p) => p.email.toLowerCase();
const cardKey = (p) => p.card.number;

// -> { flags: [{ email, name, address, card }] (each false or the number of profiles sharing it), counts: {email,name,address,card} }
function analyze(profiles) {
  const tally = (keyFn) => {
    const m = new Map();
    profiles.forEach((p) => { const k = keyFn(p); if (k && k !== '|') m.set(k, (m.get(k) || 0) + 1); });
    return (p) => { const n = m.get(keyFn(p)); return n > 1 ? n : false; };
  };
  const t = { email: tally(emailKey), name: tally(nameKey), address: tally((p) => addrKey(p.address)), card: tally(cardKey) };
  const flags = profiles.map((p) => ({ email: t.email(p), name: t.name(p), address: t.address(p), card: t.card(p) }));
  const counts = { email: 0, name: 0, address: 0, card: 0 };
  flags.forEach((f) => { for (const k of Object.keys(counts)) if (f[k]) counts[k]++; });
  return { flags, counts };
}

// ---------------------------------------------------------------- re-jigging

// Pick a different address for one profile, built from the address it was imported with.
// `taken` = address keys used by the other profiles in the file (and, optionally, the current one).
// `isUsed(line1, zip)` (optional) = true for a jig used in an earlier export or import: those are never picked.
function rejigProfile(profile, taken, rng = Math.random, isUsed = null) {
  const exclude = isUsed ? (l1) => isUsed(l1, profile.address.zip) : undefined;
  const r = jigAddress({ line1: profile.orig.line1, line2: profile.orig.line2 }, 500, { rng, mode: 'TARGET', exclude });
  const noneLeft = `No other unused variation is left for this address.${isUsed ? ' Jigs used in earlier exports or imports are skipped: re-add some in Vault > Used Jigs.' : ''}`;
  if (!r.variants.length) {
    // nothing came back: either the address can't be read, or every variation is already used
    if (!parseAddress({ line1: profile.orig.line1, line2: profile.orig.line2 })) return { ok: false, error: 'This address could not be read (it needs a house number and street name), so it cannot be jigged.' };
    return { ok: false, error: noneLeft };
  }
  const current = addrKey(profile.address);
  const options = r.variants.filter((v) => {
    const k = addrKey({ ...profile.address, line1: v.line1, line2: v.line2 });
    return k !== current && !taken.has(k) && !(isUsed && isUsed(v.line1, profile.address.zip));
  });
  if (!options.length) return { ok: false, error: noneLeft };
  const v = options[Math.floor(rng() * options.length)];
  profile.address.line1 = v.line1;
  profile.address.line2 = v.line2;
  return { ok: true };
}

// Manual edit of one profile. `f` holds the fields to change; a blank card number or CVV keeps the current one.
// Returns { ok } or { ok:false, error }. Nothing is changed when validation fails.
function updateProfile(p, f) {
  f = f || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(f, k) && f[k] !== undefined && f[k] !== null;
  const a = f.address || {};
  const c = f.card || {};
  const email = has('email') ? trim(f.email) : p.email;
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) return { ok: false, error: 'That email address does not look right.' };
  let number = p.card.number;
  if (trim(c.number)) {
    number = str(c.number).replace(/[\s-]/g, '');
    if (!/^\d{12,19}$/.test(number)) return { ok: false, error: 'The card number must be 12 to 19 digits.' };
  }
  let cvv = p.card.cvv;
  if (trim(c.cvv)) {
    cvv = trim(c.cvv);
    if (!/^\d{3,4}$/.test(cvv)) return { ok: false, error: 'The CVV must be 3 or 4 digits.' };
  }
  let expMonth = p.card.expMonth;
  if (c.expMonth !== undefined && trim(c.expMonth) !== '') {
    expMonth = trim(c.expMonth);
    if (!/^\d{1,2}$/.test(expMonth) || +expMonth < 1 || +expMonth > 12) return { ok: false, error: 'The expiry month must be 1 to 12.' };
  }
  let expYear = p.card.expYear;
  if (c.expYear !== undefined && trim(c.expYear) !== '') {
    expYear = trim(c.expYear);
    if (!/^(\d{2}|\d{4})$/.test(expYear)) return { ok: false, error: 'The expiry year must be 2 or 4 digits.' };
  }
  const line1 = a.line1 !== undefined ? trim(a.line1) : p.address.line1;
  if (!line1) return { ok: false, error: 'The address needs a street line.' };

  if (has('name')) p.name = trim(f.name);
  if (has('first')) p.first = trim(f.first);
  if (has('last')) p.last = trim(f.last);
  if (!p.name && !p.first && !p.last) { return { ok: false, error: 'The profile needs a name.' }; }
  p.email = email;
  if (has('phone')) p.phone = trim(f.phone);
  const line2 = a.line2 !== undefined ? trim(a.line2) : p.address.line2;
  if (line1 !== p.address.line1 || line2 !== p.address.line2) p.orig = { line1, line2 }; // an edited address is the new starting point for Jig / Reset
  p.address.line1 = line1;
  p.address.line2 = line2;
  if (a.city !== undefined) p.address.city = trim(a.city);
  if (a.state !== undefined) p.address.state = normState(a.state);
  if (a.zip !== undefined) p.address.zip = trim(a.zip);
  if (a.country !== undefined) p.address.country = trim(a.country) || 'United States';
  p.card.number = number;
  p.card.brand = detectBrand(number);
  p.card.cvv = cvv;
  p.card.expMonth = expMonth;
  p.card.expYear = expYear;
  if (c.holder !== undefined) p.card.holder = trim(c.holder);
  return { ok: true };
}

// Re-jig every profile whose address duplicates an earlier one. The first profile in each duplicate set is kept.
function fixDuplicateAddresses(profiles, rng = Math.random, isUsed = null) {
  const taken = new Set(profiles.map((p) => addrKey(p.address)));
  const seen = new Set();
  let fixed = 0;
  let failed = 0;
  for (const p of profiles) {
    const k = addrKey(p.address);
    if (!seen.has(k)) { seen.add(k); continue; }
    const others = new Set(taken);
    const r = rejigProfile(p, others, rng, isUsed);
    if (r.ok) {
      const nk = addrKey(p.address);
      taken.add(nk);
      seen.add(nk);
      fixed++;
    } else {
      failed++;
    }
  }
  return { fixed, failed };
}

const isChanged = (p) => p.address.line1 !== p.orig.line1 || p.address.line2 !== p.orig.line2;

// What the window sees: no card number or CVV.
function publicProfile(p, flags) {
  const exp = trim(p.card.expYear);
  return {
    id: p.id, name: p.name, first: p.first, last: p.last, email: p.email, phone: p.phone,
    address: { ...p.address, state: { ...p.address.state } },
    origAddress: { ...p.orig },
    changed: isChanged(p),
    card: { brand: p.card.brand, holder: p.card.holder, last4: p.card.number.slice(-4), expMonth: trim(p.card.expMonth).padStart(2, '0'), expYear: exp.length === 4 ? exp.slice(-2) : exp },
    flags,
  };
}

function exportProfiles(rec, format) {
  return format === 'polar' ? buildPolarFile(rec.profiles, rec.name) : buildHayhaFile(rec.profiles);
}

module.exports = { makeProfile, parseProfilesFile, analyze, rejigProfile, updateProfile, fixDuplicateAddresses, publicProfile, exportProfiles, addrKey, isChanged };
