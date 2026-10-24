'use strict';
// Pure conversion logic for Hayha <-> Polar AIO account and profile files.
// No Electron dependencies, so it can be tested with plain Node.

const crypto = require('crypto');

const STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
  ['PR', 'Puerto Rico'], ['GU', 'Guam'], ['VI', 'Virgin Islands'], ['AS', 'American Samoa'],
  ['MP', 'Northern Mariana Islands'],
  ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'],
  ['NL', 'Newfoundland and Labrador'], ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'],
  ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec'],
  ['SK', 'Saskatchewan'], ['YT', 'Yukon'],
];

function lookupState(value) {
  if (value && typeof value === 'object') value = value.name || value.shortCode;
  const v = String(value || '').trim();
  if (!v) return null;
  const upper = v.toUpperCase();
  const lower = v.toLowerCase();
  const hit = STATES.find(([code, name]) => code === upper || name.toLowerCase() === lower);
  return hit ? { shortCode: hit[0], name: hit[1] } : null;
}

const uuid = () => crypto.randomUUID();
const str = (v) => (v === undefined || v === null ? '' : String(v));
const trim = (v) => str(v).trim();
const slug = (s) => trim(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

// Alphabetical by profile name, with numbers in natural order (cam 1, cam 2, cam 10), ignoring case.
// Used for every exported profile list and for the Editor display. Ties keep their original order.
const nameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const profileSortName = (p) => trim(p && p.name) || `${trim(p && p.first)} ${trim(p && p.last)}`.trim();
const compareProfiles = (a, b) => nameCollator.compare(profileSortName(a), profileSortName(b));
const sortProfiles = (list) => list.slice().sort(compareProfiles);

function pad2(v) {
  const s = trim(v);
  return s.length === 1 ? '0' + s : s;
}

function fullYear(v) {
  const s = trim(v);
  return s.length === 2 ? '20' + s : s;
}

function maskCard(num) {
  const d = str(num).replace(/\D/g, '');
  return d.length >= 4 ? '•••• ' + d.slice(-4) : '••••';
}

// ---------------------------------------------------------------- detection

function detect(data) {
  if (Array.isArray(data)) {
    const first = data[0];
    if (!first) throw new Error('This Hayha file is empty, so there is nothing to convert.');
    if (first.cardInfo || first.shipping) return 'hayha-profiles';
    if ('username' in first) return 'hayha-accounts';
    throw new Error('Unrecognized Hayha file: entries are neither profiles nor accounts.');
  }
  if (data && data.polarExport) {
    const kind = data.polarExport.kind;
    if (kind === 'accounts') return 'polar-accounts';
    if (kind === 'profiles') return 'polar-profiles';
    throw new Error(`Unsupported Polar export kind: "${kind}".`);
  }
  throw new Error('Unrecognized file. Expected a Hayha (.hayha) or Polar (.json) export.');
}

// ---------------------------------------------------------------- accounts

function hayhaAccountsToPolar(arr, opts = {}) {
  const groupName = trim(opts.groupName) || 'Hayha Import';
  const warnings = [];
  const accounts = [];

  arr.forEach((a, i) => {
    const sites = Array.isArray(a.site) && a.site.length ? a.site : [{ name: '' }];
    if (!a.site || !a.site.length) warnings.push(`Account ${trim(a.username) || '#' + (i + 1)} has no site; its Polar type is blank.`);
    sites.forEach((s, j) => {
      accounts.push({
        accountGroup: groupName,
        id: j === 0 && a.id ? a.id : uuid(),
        password: str(a.password),
        type: trim(s.name),
        username: str(a.username),
      });
    });
  });

  if (accounts.length > arr.length) {
    warnings.push('Some Hayha accounts listed several sites; they were split into one Polar account per site.');
  }
  warnings.push('Site names are copied as-is. Check that they match the site/type names Polar expects.');

  return {
    output: {
      polarExport: {
        version: 1,
        kind: 'accounts',
        accountGroup: groupName,
        exportedAt: new Date().toISOString(),
        accounts,
      },
    },
    warnings,
    count: accounts.length,
  };
}

function polarAccountsToHayha(obj) {
  const warnings = [];
  const groupIds = new Map();
  const merged = new Map();
  const list = (obj.polarExport && obj.polarExport.accounts) || [];

  list.forEach((a) => {
    const group = trim(a.accountGroup) || trim(obj.polarExport.accountGroup) || 'Default';
    if (!groupIds.has(group)) groupIds.set(group, uuid());
    const key = [group, a.username, a.password].join('\u0000');
    const site = { name: trim(a.type), value: slug(a.type) };
    if (merged.has(key)) {
      merged.get(key).site.push(site);
    } else {
      merged.set(key, {
        username: str(a.username),
        password: str(a.password),
        groupId: groupIds.get(group),
        id: a.id || uuid(),
        site: [site],
        status: 'Not Signed In',
      });
    }
  });

  const out = [...merged.values()];
  if (out.length < list.length) {
    warnings.push('Polar accounts with the same login in the same group were merged into one Hayha account with multiple sites.');
  }
  if (groupIds.size > 0) {
    warnings.push('Hayha stores a group ID rather than a name, so Polar group names are not carried over: ' + [...groupIds.keys()].join(', '));
  }
  warnings.push('Hayha site values are generated by lowercasing the Polar type. Verify unusual site names.');

  return { output: out, warnings, count: out.length };
}

// ---------------------------------------------------------------- profiles

function hayhaAddressToPolar(h, p) {
  h = h || {};
  const st = lookupState(h.state);
  return {
    name: [trim(h.firstName), trim(h.lastName)].filter(Boolean).join(' '),
    email: str(h.email),
    phone: str(h.phone),
    line1: str(h.address),
    line2: str(h.address2),
    line3: '',
    postCode: str(h.zipCode),
    city: str(h.city),
    country: str(h.country),
    state: st ? st.name : trim(h.state && h.state.name ? h.state.name : h.state),
  };
}

function polarAddressToHayha(a, warnings, label) {
  a = a || {};
  const parts = trim(a.name).split(/\s+/).filter(Boolean);
  const st = lookupState(a.state);
  if (!st && trim(a.state)) warnings.push(`${label}: unknown state "${a.state}"; short code left as typed.`);
  return {
    firstName: parts.shift() || '',
    lastName: parts.join(' '),
    email: str(a.email),
    phone: str(a.phone),
    address: str(a.line1),
    address2: [a.line2, a.line3].map(trim).filter(Boolean).join(' '),
    country: str(a.country),
    state: st || { shortCode: trim(a.state), name: trim(a.state) },
    city: str(a.city),
    zipCode: str(a.postCode),
  };
}

function hayhaProfilesToPolar(arr, opts = {}) {
  const groupName = trim(opts.groupName) || 'Hayha Import';
  const warnings = [];
  const profiles = [];

  sortProfiles(arr).forEach((p, i) => {
    const label = trim(p.name) || '#' + (i + 1);
    if (p.encrypted) {
      warnings.push(`Skipped "${label}": it is encrypted in Hayha. Export it unencrypted first.`);
      return;
    }
    // Hayha uses one address for both billing and shipping.
    const shipping = hayhaAddressToPolar(p.shipping);
    const c = p.cardInfo || {};
    profiles.push({
      name: trim(p.name),
      notes: '',
      billingAddress: { ...shipping },
      shippingAddress: { ...shipping },
      paymentDetails: {
        nameOnCard: str(c.holder).trim(),
        cardType: '',
        cardNumber: str(c.cardNumber),
        cardExpMonth: pad2(c.expMonth),
        cardExpYear: fullYear(c.expYear),
        cardCvv: str(c.cvv),
      },
      sameBillingAndShippingAddress: true,
      onlyCheckoutOnce: false,
      matchNameOnCardAndAddress: false,
    });
  });

  warnings.push('Card type is left blank, matching your sample export. Polar can fill it in on import.');

  return {
    output: {
      polarExport: {
        version: 1,
        kind: 'profiles',
        format: 'aycd',
        profileGroup: groupName,
        exportedAt: new Date().toISOString(),
        profiles,
      },
    },
    warnings,
    count: profiles.length,
  };
}

function polarProfilesToHayha(obj) {
  const warnings = [];
  const groupId = uuid();
  const list = sortProfiles((obj.polarExport && obj.polarExport.profiles) || []);

  const out = list.map((p, i) => {
    const label = trim(p.name) || '#' + (i + 1);
    const shipping = polarAddressToHayha(p.shippingAddress, warnings, `"${label}" shipping`);
    const pay = p.paymentDetails || {};
    const same = p.sameBillingAndShippingAddress !== false;
    if (!same) {
      const b = p.billingAddress || {};
      const s = p.shippingAddress || {};
      const differs = ['line1', 'line2', 'city', 'state', 'postCode', 'country'].some((k) => trim(b[k]) !== trim(s[k]));
      if (differs) {
        warnings.push(`"${label}" has a different billing address in Polar. Hayha only supports one address, so the shipping address was used for both.`);
      }
    }
    const entry = {
      name: trim(p.name),
      shipping,
    };
    entry.cardInfo = {
      cardNumber: str(pay.cardNumber),
      holder: str(pay.nameOnCard),
      expMonth: pad2(pay.cardExpMonth),
      expYear: Number(fullYear(pay.cardExpYear)) || fullYear(pay.cardExpYear),
      cvv: str(pay.cardCvv),
    };
    entry.sameAsBilling = true;
    entry.groupId = groupId;
    entry.id = uuid();
    entry.encrypted = false;
    return entry;
  });

  warnings.push(`Hayha stores a group ID rather than a name, so the Polar group name "${trim(obj.polarExport.profileGroup)}" is not carried over.`);
  warnings.push('Polar-only fields (notes, onlyCheckoutOnce, matchNameOnCardAndAddress, card type) have no Hayha equivalent and were dropped.');

  return { output: out, warnings, count: out.length };
}

// ---------------------------------------------------------------- previews

function previewRows(kind, output) {
  switch (kind) {
    case 'polar-accounts':
      return { columns: ['Username', 'Password', 'Type', 'Group'], rows: output.polarExport.accounts.map((a) => [a.username, '••••••••', a.type, a.accountGroup]) };
    case 'hayha-accounts':
      return { columns: ['Username', 'Password', 'Sites', 'Status'], rows: output.map((a) => [a.username, '••••••••', a.site.map((s) => s.name).join(', '), a.status]) };
    case 'polar-profiles':
      return { columns: ['Profile', 'Name', 'City', 'State', 'Card'], rows: output.polarExport.profiles.map((p) => [p.name, p.shippingAddress.name, p.shippingAddress.city, p.shippingAddress.state, maskCard(p.paymentDetails.cardNumber)]) };
    case 'hayha-profiles':
      return { columns: ['Profile', 'Name', 'City', 'State', 'Card'], rows: output.map((p) => [p.name, `${p.shipping.firstName} ${p.shipping.lastName}`.trim(), p.shipping.city, p.shipping.state.shortCode, maskCard(p.cardInfo.cardNumber)]) };
    default:
      return { columns: [], rows: [] };
  }
}

// ---------------------------------------------------------------- entry point

const LABELS = {
  'hayha-accounts': 'Hayha accounts',
  'hayha-profiles': 'Hayha profiles',
  'polar-accounts': 'Polar accounts',
  'polar-profiles': 'Polar profiles',
};

function convert(text, opts = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('That file is not valid JSON, so it cannot be a Hayha or Polar export.');
  }
  const from = detect(data);
  let result;
  let to;
  let fileName;
  switch (from) {
    case 'hayha-accounts': result = hayhaAccountsToPolar(data, opts); to = 'polar-accounts'; fileName = 'polar-accounts.json'; break;
    case 'hayha-profiles': result = hayhaProfilesToPolar(data, opts); to = 'polar-profiles'; fileName = 'polar-profiles.json'; break;
    case 'polar-accounts': result = polarAccountsToHayha(data); to = 'hayha-accounts'; fileName = 'hayha-accounts.hayha'; break;
    case 'polar-profiles': result = polarProfilesToHayha(data); to = 'hayha-profiles'; fileName = 'hayha-profiles.hayha'; break;
  }
  const text2 = to.startsWith('polar') ? JSON.stringify(result.output, null, 2) : JSON.stringify(result.output);
  return {
    from,
    to,
    fromLabel: LABELS[from],
    toLabel: LABELS[to],
    needsGroupName: to.startsWith('polar'),
    count: result.count,
    warnings: result.warnings,
    fileName,
    outputText: text2,
    preview: previewRows(to, result.output),
  };
}

// ---------------------------------------------------------------- builder exports
// Used by the profile builder. Each profile: { name, first, last, email, phone,
// address: { line1, line2, city, state: {shortCode, name}, zip, country },
// card: { number, holder, expMonth, expYear, cvv } }. Hayha uses one address for both
// billing and shipping, and so do the Polar profiles written here.

function buildHayhaFile(profiles) {
  const groupId = uuid();
  const out = sortProfiles(profiles).map((p) => ({
    name: trim(p.name),
    shipping: {
      firstName: trim(p.first),
      lastName: trim(p.last),
      email: str(p.email),
      phone: str(p.phone),
      address: str(p.address.line1),
      address2: str(p.address.line2),
      country: str(p.address.country),
      state: { shortCode: p.address.state.shortCode, name: p.address.state.name },
      city: str(p.address.city),
      zipCode: str(p.address.zip),
    },
    cardInfo: {
      cardNumber: str(p.card.number),
      holder: trim(p.card.holder) || `${trim(p.first)} ${trim(p.last)}`.trim(),
      expMonth: pad2(p.card.expMonth),
      expYear: Number(fullYear(p.card.expYear)),
      cvv: str(p.card.cvv),
    },
    sameAsBilling: true,
    groupId,
    id: uuid(),
    encrypted: false,
  }));
  return JSON.stringify(out);
}

function buildPolarFile(profiles, groupName) {
  const addr = (p) => ({
    name: `${trim(p.first)} ${trim(p.last)}`.trim(),
    email: str(p.email),
    phone: str(p.phone),
    line1: str(p.address.line1),
    line2: str(p.address.line2),
    line3: '',
    postCode: str(p.address.zip),
    city: str(p.address.city),
    country: str(p.address.country),
    state: p.address.state.name,
  });
  const list = sortProfiles(profiles).map((p) => ({
    name: trim(p.name),
    notes: '',
    billingAddress: addr(p),
    shippingAddress: addr(p),
    paymentDetails: {
      nameOnCard: trim(p.card.holder) || `${trim(p.first)} ${trim(p.last)}`.trim(),
      cardType: '',
      cardNumber: str(p.card.number),
      cardExpMonth: pad2(p.card.expMonth),
      cardExpYear: fullYear(p.card.expYear),
      cardCvv: str(p.card.cvv),
    },
    sameBillingAndShippingAddress: true,
    onlyCheckoutOnce: false,
    matchNameOnCardAndAddress: false,
  }));
  return JSON.stringify({
    polarExport: {
      version: 1,
      kind: 'profiles',
      format: 'aycd',
      profileGroup: trim(groupName) || 'Builder',
      exportedAt: new Date().toISOString(),
      profiles: list,
    },
  }, null, 2);
}

// CSV for spreadsheets: Line 1, Line 2, City, State, Zip, Phone, First Name, Last Name (no card data).
function buildCsvFile(profiles) {
  const cell = (v) => {
    let t = str(v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // keep spreadsheets from reading it as a formula
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const rows = [['Line 1', 'Line 2', 'City', 'State', 'Zip', 'Phone', 'First Name', 'Last Name']];
  sortProfiles(profiles).forEach((p) => rows.push([p.address.line1, p.address.line2, p.address.city, p.address.state.shortCode, p.address.zip, p.phone, p.first, p.last]));
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// ---- account exports (Vault > Accounts). Each account: { retailer, email, password }.
const RETAILER_SITE = { target: 'Target', walmart: 'Walmart', other: 'Other', pokemoncenter: 'Pokemon Center' };
const siteName = (r) => RETAILER_SITE[r] || str(r);
const byEmail = (a, b) => nameCollator.compare(trim(a.email), trim(b.email));

// Hayha: one entry per login. The same email + password saved for several retailers becomes ONE entry with several sites.
function buildHayhaAccountsFile(accounts) {
  const groupId = uuid();
  const merged = new Map();
  accounts.slice().sort(byEmail).forEach((a) => {
    const key = `${a.email}\u0000${a.password}`;
    const site = { name: siteName(a.retailer), value: slug(siteName(a.retailer)) };
    if (merged.has(key)) merged.get(key).site.push(site);
    else merged.set(key, { username: str(a.email), password: str(a.password), groupId, id: uuid(), site: [site], status: 'Not Signed In' });
  });
  return JSON.stringify([...merged.values()]);
}

// Polar: one entry per account, with the retailer as its type.
function buildPolarAccountsFile(accounts, groupName) {
  const group = trim(groupName) || 'AIO Studio';
  return JSON.stringify({
    polarExport: {
      version: 1,
      kind: 'accounts',
      accountGroup: group,
      exportedAt: new Date().toISOString(),
      accounts: accounts.slice().sort(byEmail).map((a) => ({ accountGroup: group, id: uuid(), password: str(a.password), type: siteName(a.retailer), username: str(a.email) })),
    },
  }, null, 2);
}

// The first 56 entries are US states, DC and territories; the rest are Canadian provinces.
const US_STATES = STATES.slice(0, 56);

module.exports = { convert, detect, lookupState, maskCard, STATES, US_STATES, buildHayhaFile, buildPolarFile, buildCsvFile, buildHayhaAccountsFile, buildPolarAccountsFile, RETAILER_SITE, compareProfiles, sortProfiles };
