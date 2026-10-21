'use strict';
// Generates a batch of profiles from the vault. Runs in the main process so full card
// numbers stay out of the window; the window only gets masked preview rows.

const { FIRST_NAMES, MALE_FIRST_NAMES, FEMALE_FIRST_NAMES, LAST_NAMES, pickUnique } = require('./names');
const { jigAddress, jigPhone, jigName, AREA_CODES } = require('./jig');
const { sortProfiles } = require('./converter');

const SITES = ['target', 'walmart', 'pokemoncenter', 'other'];
const EMAIL_STYLES = ['firstlast', 'first.last', 'firstlastNN', 'sequence', 'accounts'];
const FIRST_MODES = ['random', 'male', 'female', 'custom'];
const NAME_RE = /^[\p{L}][\p{L}'’.\- ]{0,29}$/u;
const DOMAIN_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const MAX_PROFILES = 500;

const clean = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d && d.length !== 10) return null;
  return d;
}

function buildDraft(vault, raw, rng = Math.random) {
  const o = raw || {};
  const errors = [];
  const warnings = [];

  const site = SITES.includes(o.site) ? o.site : null;
  if (!site) errors.push('Select a retailer.');
  const address = vault.getAddress(o.addressId);
  if (!address) errors.push('Pick an address from your vault.');
  const count = Number(o.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PROFILES) errors.push(`Profiles to generate must be a whole number from 1 to ${MAX_PROFILES}.`);

  const firstMode = FIRST_MODES.includes(o.firstMode) ? o.firstMode : 'random';
  const lastMode = o.lastMode === 'same' ? 'same' : 'random';
  const firstName = String(o.firstName || '').trim();
  const lastName = String(o.lastName || '').trim();
  if (firstMode === 'custom' && !NAME_RE.test(firstName)) errors.push('Enter the first name to use on all profiles.');
  if (lastMode === 'same' && !NAME_RE.test(lastName)) errors.push('Enter the last name to use on all profiles.');

  const domain = String(o.domain || '').trim().replace(/^@+/, '').toLowerCase();
  const emailStyle = EMAIL_STYLES.includes(o.emailStyle) ? o.emailStyle : 'firstlast';
  if (emailStyle !== 'accounts' && !DOMAIN_RE.test(domain)) errors.push('Select a catchall domain (or enter a new one).');
  // 'accounts' = use the emails of vault accounts (for the chosen site), one per profile, in vault order.
  let accounts = [];
  if (emailStyle === 'accounts') {
    accounts = vault.getAccounts(Array.isArray(o.accountIds) ? o.accountIds.map(String) : []);
    if (site && accounts.some((a) => a.retailer !== site)) errors.push('Some selected accounts belong to a different retailer than the site you picked.');
    if (Number.isInteger(count) && accounts.length < count) {
      errors.push(`You selected ${accounts.length} account${accounts.length === 1 ? '' : 's'} but need ${count}. Add more accounts in the Vault or select more here.`);
    }
  }
  // 'sequence' = numbered accounts that already exist (prefix1@domain, prefix2@domain...), so profiles match them.
  const emailPrefix = String(o.emailPrefix || '').trim().replace(/@.*$/, '').toLowerCase();
  const emailStart = Number(o.emailStart === undefined || o.emailStart === '' ? 1 : o.emailStart);
  if (emailStyle === 'sequence') {
    if (!/^[a-z0-9._+-]+$/.test(emailPrefix)) errors.push('Enter the email prefix your accounts use (the part before the number).');
    if (!Number.isInteger(emailStart) || emailStart < 0 || emailStart > 99999999) errors.push('Enter the first account number as a whole number.');
  }

  // Phone: 'random' = a random valid number per profile, 'area' = your area code + random valid 7 digits,
  // 'same' = one number on all, 'none' = blank.
  const phoneMode = ['random', 'area', 'same', 'none'].includes(o.phoneMode) ? o.phoneMode : 'same';
  let phone = '';
  let area = '';
  if (phoneMode === 'area') {
    area = String(o.areaCode || '').replace(/\D/g, '');
    if (!/^[2-9]\d\d$/.test(area) || area.endsWith('11')) errors.push('Enter a valid 3-digit area code.');
  } else if (phoneMode === 'same') {
    phone = normalizePhone(o.phone);
    if (phone === null) errors.push('Phone must be 10 digits (or leave it empty).');
    else if (!phone) warnings.push('No phone number was set, so the phone field is blank on every profile.');
  }

  const groupName = String(o.groupName || '').trim().slice(0, 60);
  if (!groupName) errors.push('Enter a group name.');

  const cardIds = Array.isArray(o.cardIds) ? o.cardIds.map(String) : [];
  const cards = vault.getCards(cardIds);
  if (Number.isInteger(count) && cards.length < count) {
    errors.push(`You selected ${cards.length} card${cards.length === 1 ? '' : 's'} but need ${count}. Add more cards in the Vault or select more here.`);
  }
  if (errors.length) return { ok: false, errors };

  const usedPicked = cards.slice(0, count).filter((c) => c.used).length;
  if (usedPicked) warnings.push(`${usedPicked} of the cards being used ${usedPicked === 1 ? 'is' : 'are'} already marked in use.`);

  const jig = jigAddress({ line1: address.line1, line2: address.line2 }, count, { rng, site });
  warnings.push(...jig.warnings);
  if (jig.variants.length < count) {
    return { ok: false, errors: [jig.variants.length ? `Only ${jig.variants.length} unique address variations exist for this address, but ${count} profiles were requested. Generate fewer profiles or add another address to the vault.` : jig.warnings[0]], warnings: jig.warnings };
  }

  const firsts = firstMode === 'custom' ? Array(count).fill(firstName) : pickUnique(firstMode === 'male' ? MALE_FIRST_NAMES : firstMode === 'female' ? FEMALE_FIRST_NAMES : FIRST_NAMES, count, rng);
  const lasts = lastMode === 'same' ? Array(count).fill(lastName) : pickUnique(LAST_NAMES, count, rng);

  const prefix = String(o.prefix || '').trim().slice(0, 40) || 'Profile';

  const nameJig = !!o.jigName && firstMode === 'custom';
  const takenPhones = new Set();
  const usedEmails = new Set();
  const profiles = [];
  for (let i = 0; i < count; i++) {
    if (nameJig) firsts[i] = jigName(firsts[i], lasts[i], rng).first;
    const f = clean(firsts[i]);
    const l = clean(lasts[i]);
    let local = emailStyle === 'first.last' ? `${f}.${l}` : `${f}${l}`;
    if (emailStyle === 'firstlastNN') local += String(10 + Math.floor(rng() * 90));
    if (emailStyle === 'sequence') local = `${emailPrefix}${emailStart + i}`;
    let unique = local;
    for (let n = 2; usedEmails.has(unique); n++) unique = `${local}${n}`;
    usedEmails.add(unique);
    profiles.push({
      name: `${prefix} ${i + 1}`,
      first: firsts[i],
      last: lasts[i],
      email: emailStyle === 'accounts' ? accounts[i].email : `${unique}@${domain}`,
      phone: phoneMode === 'random' ? jigPhone(AREA_CODES[Math.floor(rng() * AREA_CODES.length)], rng, takenPhones)
        : phoneMode === 'area' ? jigPhone(area, rng, takenPhones) : phone,
      address: {
        line1: jig.variants[i].line1,
        line2: jig.variants[i].line2,
        city: address.city,
        state: address.state,
        zip: address.zip,
        country: address.country,
      },
      card: cards[i],
    });
  }

  return {
    ok: true,
    warnings,
    draft: {
      profiles,
      cardIds: profiles.map((p) => p.card.id),
      opts: { site, prefix, groupName, markUsed: o.markUsed !== false },
      marked: false,
    },
  };
}

// Shown in the same alphabetical order the exported files use (the draft itself keeps its build order).
function previewRows(draft) {
  return sortProfiles(draft.profiles).map((p, i) => ({
    n: i + 1,
    profile: p.name,
    name: `${p.first} ${p.last}`,
    email: p.email,
    phone: p.phone || '',
    address: p.address.line2 ? `${p.address.line1} | ${p.address.line2}` : p.address.line1,
    card: `${p.card.brand} •••• ${p.card.number.slice(-4)}`,
  }));
}

module.exports = { buildDraft, previewRows, MAX_PROFILES };
