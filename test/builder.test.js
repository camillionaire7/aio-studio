'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { jigAddress, jigPhone, jigName, parseAddress, extractUnitCore, getUnitValueVariants, levenshtein, SUFFIX_VARIANTS, DESIGNATOR_LIST, AREA_CODES } = require('../src/jig');
const { buildCsvFile } = require('../src/converter');
const { VaultStore } = require('../src/vaultStore');
const { buildDraft, previewRows } = require('../src/profileBuilder');
const { createApi } = require('../src/api');
const { convert, STATES } = require('../src/converter');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-vault-'));
assert.strictEqual(STATES[56][0], 'AB', 'US_STATES slice must end before the Canadian provinces');

// ---------------------------------------------------------------- JigEngine (inline line 1, line 2 always empty)
{
  for (const [input, core] of [['unit 2814', '2814'], ['Apt. 4B', '4B'], ['# 12', '12'], ['2814.', '2814'], ['floor 2', '2'], ['Apt #4', '4'],
    ['APT 7H', '7H'], ['door 3', '3'], ['007H', '7H'], ['unit 0', '0'], ['', '']]) {
    assert.strictEqual(extractUnitCore(input), core, `extractUnitCore(${JSON.stringify(input)})`);
  }
  assert.deepStrictEqual(getUnitValueVariants('7H'), ['7H', '07H', '007H']);
  const raw = parseAddress({ line1: '17161 Alva Rd unit 2814', line2: '' });
  assert.deepStrictEqual([raw.baseStreet, raw.suffix, raw.unitCore, raw.isMultiUnit], ['17161 Alva', 'Road', '2814', true]);
  const st = parseAddress({ baseStreet: '123 Example', streetSuffix: 'St', existingUnit: 'APT 007H' });
  assert.deepStrictEqual([st.baseStreet, st.suffix, st.unitCore], ['123 Example', 'Street', '7H']);
  const fromLine2 = parseAddress({ line1: '12 N Oak Ave', line2: 'Apt 5' });
  assert.deepStrictEqual([fromLine2.baseStreet, fromLine2.suffix, fromLine2.unitCore], ['12 N Oak', 'Avenue', '5']);
  assert.strictEqual(parseAddress({ line1: 'Main Street', line2: '' }), null);
  assert.strictEqual(parseAddress({ line1: '5 Space Rd', line2: '' }).isMultiUnit, false, '"Space" is not a unit');
  assert.deepStrictEqual(SUFFIX_VARIANTS.Bend, ['Bend', 'Bend.', 'Bnd', 'Bnd.']);
  assert.ok(DESIGNATOR_LIST[0] === '' && DESIGNATOR_LIST.includes('Door') && DESIGNATOR_LIST.includes('#'));
}
// HAS_APARTMENT: the spec's priority order, line 2 empty, house number and street name untouched
for (const mode of ['TARGET', 'POKEMON_CENTER', 'CUSTOM']) {
  const r = jigAddress({ line1: '123 Example Street', line2: '7H' }, 8, { mode });
  assert.deepStrictEqual(r.variants.map((v) => v.line1), [
    '123 Example St. 7H', '123 Example Street APT 7H', '123 Example St. STE 7H', '123 Example St. Door 7H',
    '123 Example St. APT 07H', '123 Example St. STE 07H', '123 Example Street. Floor 7H', '123 Example Street 7H',
  ], mode);
  assert.ok(r.variants.every((v) => v.line2 === ''));
}
{
  const r = jigAddress('17161 Alva Rd unit 2814', 180, { mode: 'TARGET' });
  assert.strictEqual(r.variants.length, 180, 'every suffix x designator x unit combination');
  assert.strictEqual(new Set(r.variants.map((v) => v.line1)).size, 180, 'all unique');
  assert.ok(r.variants.every((v) => v.line1.startsWith('17161 Alva ') && v.line2 === '' && /(0{0,2}2814)$/.test(v.line1) && !/2814\./.test(v.line1)));
  assert.ok(r.variants.some((v) => /\bFl 002814$/.test(v.line1)) && r.variants.some((v) => /# 02814$/.test(v.line1)));
  const more = jigAddress('17161 Alva Rd unit 2814', 300, { mode: 'TARGET' });
  assert.strictEqual(more.variants.length, 180);
  assert.ok(more.warnings.some((w) => /Only 180 unique/.test(w)));
  assert.strictEqual(jigAddress({ baseStreet: '17161 Alva', streetSuffix: 'Bend', existingUnit: 'unit 2814' }, 3).variants[0].line1, '17161 Alva Bnd. 2814');
}
// NO_APARTMENT: made-up unit at the end of line 1, line 2 empty, bare unit never used
for (const mode of ['TARGET', 'POKEMON_CENTER']) {
  for (const n of [10, 60]) {
    const r = jigAddress({ line1: '123 Example Street', line2: '' }, n, { mode });
    assert.strictEqual(r.variants.length, n);
    assert.strictEqual(new Set(r.variants.map((v) => v.line1)).size, n);
    assert.ok(r.variants.every((v) => v.line2 === '' && /^123 Example (Street|Street\.|St|St\.) (APT|STE|Door|Floor|Unit|UNIT|Apt|Apt\.|Ste|Ste\.|Suite|Fl|Rm|#) 0?[1-9][A-H]?$/.test(v.line1)), r.variants[0].line1);
    if (n <= 20) assert.ok(r.variants.every((v) => /(APT|STE|Door|Floor) /.test(v.line1)), 'small batches use the primary designators only');
  }
}
// seed = repeatable, different seed = different
{
  const a = jigAddress('742 Evergreen Terrace', 6, { seed: 7 });
  assert.deepStrictEqual(a.variants, jigAddress('742 Evergreen Terrace', 6, { seed: 7 }).variants);
  assert.notDeepStrictEqual(a.variants, jigAddress('742 Evergreen Terrace', 6, { seed: 8 }).variants);
  assert.strictEqual(jigAddress({ line1: 'Main Street', line2: '' }, 3).variants.length, 0);
  assert.strictEqual(jigAddress('1 Oak St', 501).variants.length, 0, 'batch size above 500');
  assert.ok(jigAddress('1 Broadway', 3).warnings.some((w) => /No street type/.test(w)));
}
// phone + name jigs
{
  const taken = new Set();
  for (let i = 0; i < 200; i++) {
    const n = jigPhone('619', Math.random, taken);
    assert.match(n, /^619[2-9]\d\d\d{4}$/);
    assert.ok(n.slice(4, 6) !== '11' && n.slice(3, 6) !== '555');
  }
  assert.strictEqual(taken.size, 200, 'all unique');
  assert.throws(() => jigPhone('123'));
  for (let i = 0; i < 50; i++) {
    const r = jigName('Michael', 'Quiroz');
    assert.strictEqual(r.last, 'Quiroz');
    assert.ok(r.first !== 'Michael' && /^(Mike|Mikey|Michael [A-Z]|Mi[a-z]*)/i.test(r.first));
  }
  assert.strictEqual(jigName('Zed', 'Ng').last, 'Ng');
}

// ---------------------------------------------------------------- history + launcher
{
  const { History } = require('../src/history');
  const { createLauncher, autoFind } = require('../src/launcher');
  const h = new History(path.join(tmp, 'hist', 'history.json'), 3);
  for (let i = 0; i < 5; i++) h.add({ fileName: `f${i}.json`, fromLabel: 'Hayha', toLabel: 'Polar', count: i, filePath: `/x/f${i}.json` });
  assert.deepStrictEqual(h.list().map((i) => i.fileName), ['f4.json', 'f3.json', 'f2.json'], 'newest first, capped');
  assert.strictEqual(new History(path.join(tmp, 'hist', 'history.json'), 3).list().length, 3, 'persists');
  h.clear();
  assert.strictEqual(h.list().length, 0);

  // fake file system (posix separators; the launcher builds paths with the host path module)
  const pfiles = new Set([
    '/u/Roaming/Microsoft/Windows/Start Menu/Programs/Hayha AIO/Hayha AIO.lnk',
    '/u/Local/Programs/polar-aio/Polar AIO.exe',
    '/u/Local/Programs/polar-aio/Uninstall Polar AIO.exe',
  ]);
  const pfs = {
    existsSync: (p) => pfiles.has(p) || [...pfiles].some((f) => f.startsWith(p + '/')),
    readdirSync: (dir) => {
      const kids = new Map();
      for (const f of pfiles) {
        if (!f.startsWith(dir + '/')) continue;
        const rest = f.slice(dir.length + 1).split('/');
        kids.set(rest[0], rest.length === 1);
      }
      if (!kids.size) throw new Error('ENOENT');
      return [...kids].map(([name, isFile]) => ({ name, isFile: () => isFile, isDirectory: () => !isFile }));
    },
    readFileSync: () => { throw new Error('none'); }, mkdirSync: () => {}, writeFileSync: () => {},
  };
  const env = { APPDATA: '/u/Roaming', LOCALAPPDATA: '/u/Local' };
  assert.strictEqual(autoFind('hayha', { fs: pfs, env, platform: 'win32' }), '/u/Roaming/Microsoft/Windows/Start Menu/Programs/Hayha AIO/Hayha AIO.lnk', 'Start Menu shortcut');
  assert.strictEqual(autoFind('polar', { fs: pfs, env, platform: 'win32' }), '/u/Local/Programs/polar-aio/Polar AIO.exe', 'install folder, skipping the uninstaller');
  assert.strictEqual(autoFind('polar', { fs: pfs, env: {}, platform: 'linux' }), null);

  (async () => {
    const opened = [];
    const L = createLauncher({ settingsFile: path.join(tmp, 'apps.json'), fs: { ...pfs, readFileSync: fs.readFileSync, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync }, env, platform: 'win32', openPath: async (p) => { opened.push(p); return ''; }, pickFile: async () => null });
    assert.strictEqual((await L.launch('hayha')).ok, true);
    assert.deepStrictEqual(opened, ['/u/Roaming/Microsoft/Windows/Start Menu/Programs/Hayha AIO/Hayha AIO.lnk']);
    assert.strictEqual((await L.launch('evil')).ok, false, 'unknown app key is refused');
    assert.strictEqual(L.status().polar.source, 'found');
    const none = createLauncher({ settingsFile: path.join(tmp, 'apps2.json'), env: {}, platform: 'linux', openPath: async () => '', pickFile: async () => null });
    assert.strictEqual(none.status().hayha.path, null);
    const r = await none.launch('hayha');
    assert.ok(!r.ok && r.needsPath, 'asks for a path when the app is not found');
    assert.ok((await none.choose('hayha')).canceled, 'cancelled picker changes nothing');
    // a chosen path wins over auto-detection and is remembered
    const chosen = path.join(tmp, 'Hayha.exe');
    fs.writeFileSync(chosen, 'x');
    const withPick = createLauncher({ settingsFile: path.join(tmp, 'apps3.json'), env: {}, platform: 'linux', openPath: async () => '', pickFile: async () => chosen });
    assert.strictEqual((await withPick.choose('polar')).status.polar.path, chosen);
    const again = createLauncher({ settingsFile: path.join(tmp, 'apps3.json'), env: {}, platform: 'linux', openPath: async () => '', pickFile: async () => null });
    assert.strictEqual(again.status().polar.source, 'chosen', 'remembered after a restart');
    assert.strictEqual(withPick.clear('polar').status.polar.path, null);
    console.log('History and launcher tests passed.');
  })().catch((e) => { console.error(e); process.exit(1); });
}

// ---------------------------------------------------------------- vault
const file = path.join(tmp, 'vault.json');
const fakeCrypto = {
  available: () => true,
  encrypt: (s) => Buffer.from(s, 'utf8').reverse(),
  decrypt: (b) => Buffer.from(b).reverse().toString('utf8'),
};
let vault = new VaultStore(file, fakeCrypto);

assert.ok(vault.addAddress({ line1: '123 main st', line2: '', city: 'San Diego', state: 'CA', zip: '92127' }).ok);
assert.ok(vault.addAddress({ line1: '345 east ln', line2: '', city: 'San Diego', state: 'CA', zip: '92127' }).ok);
assert.ok(!vault.addAddress({ line1: '123 Main St', line2: '', city: 'San Diego', state: 'CA', zip: '92127' }).ok, 'duplicate');
{
  const id = vault.snapshot().addresses.find((a) => a.line1 === '345 east ln').id;
  assert.ok(!vault.updateAddress(id, { line1: '123 main st', line2: '', city: 'San Diego', state: 'CA', zip: '92127' }).ok, 'edit cannot duplicate another address');
  assert.ok(!vault.updateAddress(id, { line1: '', line2: '', city: 'x', state: 'CA', zip: '92127' }).ok, 'edit is validated');
  assert.ok(vault.updateAddress(id, { line1: '345 east ln', line2: 'apt 2', city: 'San Diego', state: 'CA', zip: '92127' }).ok, 'saving an address over itself is fine');
  assert.strictEqual(vault.snapshot().addresses.find((a) => a.id === id).line2, 'apt 2');
  assert.ok(vault.updateAddress(id, { line1: '345 east ln', line2: '', city: 'San Diego', state: 'CA', zip: '92127' }).ok);
  assert.ok(!vault.updateAddress('nope', { line1: 'x' }).ok);
}
assert.ok(!vault.addAddress({ line1: '1 x st', line2: '', city: 'x', state: 'ZZ', zip: '92127' }).ok, 'bad state');
assert.ok(!vault.addAddress({ line1: '1 x st', line2: '', city: 'x', state: 'AB', zip: '92127' }).ok, 'Canadian province rejected');
assert.ok(!vault.addAddress({ line1: '1 x st', line2: '', city: 'x', state: 'CA', zip: '9212' }).ok, 'bad zip');

const nums = ['4111111111111111', '5555555555554444', '378282246310005', '6011111111111117', '4012888888881881',
  '4222222222222', '5105105105105100', '4000056655665556', '4012000033330026', '5454545454545454'];
const lines = nums.map((n, i) => `${n}|${String(i % 12 + 1).padStart(2, '0')}|${30 + (i % 3)}|${n.startsWith('37') ? '1234' : '123'}`);
const bulk = vault.addCardsBulk(lines.join('\n') + '\n1234567890123456|01|30|123\nbad line', { holder: 'Camilo Quiroz' });
assert.strictEqual(bulk.added, 10);
assert.strictEqual(bulk.skipped.length, 2, 'Luhn failure and malformed line are skipped');
assert.ok(vault.addCard({ number: '1234567890123456', expMonth: '1', expYear: '28', cvv: '123' }, { lenient: true }).ok === true, 'test card with lenient');
assert.ok(!vault.addCard({ number: '4111111111111111', expMonth: '1', expYear: '30', cvv: '123' }).ok, 'duplicate card');
assert.ok(!vault.addCard({ number: '4242424242424242', expMonth: '1', expYear: '2020', cvv: '123' }).ok, 'expired');
assert.ok(!vault.addCard({ number: '371449635398431', expMonth: '1', expYear: '30', cvv: '123' }).ok, 'Amex needs a 4-digit CVV');

// Encrypted at rest, reloadable, and nothing sensitive in the snapshot.
const onDisk = fs.readFileSync(file, 'utf8');
assert.ok(!onDisk.includes('4111111111111111') && !onDisk.includes('123 main st'), 'vault file is encrypted');
const snapStr = JSON.stringify(vault.snapshot());
assert.ok(!snapStr.includes('4111111111111111') && !/"cvv"/.test(snapStr), 'snapshot has no full numbers or CVVs');
vault = new VaultStore(file, fakeCrypto);
assert.strictEqual(vault.snapshot().cards.length, 11);
assert.strictEqual(vault.snapshot().addresses.length, 2);

// Domains and retailer accounts
{
  const v4 = new VaultStore(path.join(tmp, 'accts.json'), fakeCrypto);
  assert.ok(v4.addDomain('@Mail.Example.com').ok);
  assert.ok(!v4.addDomain('mail.example.com').ok, 'duplicate domain');
  assert.ok(!v4.addDomain('nodot').ok && !v4.addDomain('a b.com').ok, 'invalid domains');
  assert.deepStrictEqual(v4.snapshot().domains.map((d) => d.domain), ['mail.example.com']);
  assert.ok(v4.deleteDomain(v4.snapshot().domains[0].id).ok);

  assert.ok(v4.addAccount({ retailer: 'target', email: 'one@mail.example.com', password: 'p:w1' }).ok);
  assert.ok(!v4.addAccount({ retailer: 'target', email: 'ONE@mail.example.com', password: 'x' }).ok, 'duplicate for the same retailer');
  assert.ok(v4.addAccount({ retailer: 'pokemoncenter', email: 'one@mail.example.com', password: 'x' }).ok, 'same email, other retailer');
  assert.ok(!v4.addAccount({ retailer: 'nope', email: 'a@b.com', password: 'x' }).ok && !v4.addAccount({ retailer: 'target', email: 'bad', password: 'x' }).ok && !v4.addAccount({ retailer: 'target', email: 'a@b.com', password: '' }).ok);
  const r = v4.addAccountsBulk('two@mail.example.com:pass:with:colons\nthree@mail.example.com|pw3\nbroken line\none@mail.example.com:dup\n\nnot-an-email:pw', { retailer: 'target' });
  assert.strictEqual(r.added, 2, JSON.stringify(r.skipped));
  assert.strictEqual(r.skipped.length, 3);
  assert.ok(!v4.addAccountsBulk('a@b.com:x', { retailer: '' }).ok, 'retailer required');
  const accts = v4.snapshot().accounts.filter((a) => a.retailer === 'target');
  assert.deepStrictEqual(accts.map((a) => a.email), ['one@mail.example.com', 'two@mail.example.com', 'three@mail.example.com']);
  assert.ok(!/p:w1|pass:with|"password"|pw3/.test(JSON.stringify(v4.snapshot())), 'snapshot has no passwords');
  assert.ok(!fs.readFileSync(path.join(tmp, 'accts.json'), 'utf8').includes('pw3'), 'passwords are encrypted at rest');
  assert.strictEqual(v4.getAccounts(accts.map((a) => a.id))[1].password, 'pass:with:colons');
  assert.ok(new VaultStore(path.join(tmp, 'accts.json'), fakeCrypto).snapshot().accounts.length === 4, 'persisted');
  assert.ok(v4.deleteAccount(accts[0].id).ok && !v4.deleteAccount('nope').ok);
}

// Bulk import: colon separated, 2 or 4 digit year
{
  const v2 = new VaultStore(path.join(tmp, 'bulk.json'), fakeCrypto);
  const r = v2.addCardsBulk('4111111111111111:10:29:123\n5555555555554444:10:2029:123\n378282246310005:1:2031:1234\n6011111111111117:10:029:123', { holder: 'X' });
  assert.strictEqual(r.added, 3);
  assert.strictEqual(r.skipped.length, 1, '3-digit year is rejected');
  const cs = v2.getCards(v2.snapshot().cards.map((c) => c.id));
  assert.deepStrictEqual(cs.map((c) => [c.expMonth, c.expYear]), [['10', 2029], ['10', 2029], ['01', 2031]]);
}
// Bulk import with nicknames, and the date each card was added
{
  const v3 = new VaultStore(path.join(tmp, 'nick.json'), fakeCrypto);
  const r = v3.addCardsBulk('main card:4111111111111111:10:29:123\nbackup: 5555555555554444:10:2029:123\n378282246310005:1:2031:1234\ncard 4 4242424242424242 10 30 123', { nickname: 'fallback' });
  assert.strictEqual(r.added, 4, JSON.stringify(r.skipped));
  const sn = v3.snapshot().cards;
  assert.deepStrictEqual(sn.map((c) => c.nickname), ['main card', 'backup', 'fallback', 'card 4']);
  assert.ok(sn.every((c) => !isNaN(new Date(c.createdAt))), 'every card has an added date');
  assert.ok(v3.addCard({ number: '4000056655665556', expMonth: '1', expYear: '30', cvv: '123', nickname: 'solo' }).ok);
  assert.strictEqual(v3.snapshot().cards.pop().nickname, 'solo');
}

// ---------------------------------------------------------------- builder (your example)
const snap = vault.snapshot();
const addr = snap.addresses.find((a) => a.line1 === '123 main st');
const tenCards = snap.cards.slice(0, 10).map((c) => c.id);
const base = {
  site: 'target', addressId: addr.id, count: 5, firstMode: 'random', lastMode: 'same', lastName: 'Quiroz',
  domain: '@valid3d.com', emailStyle: 'firstlast', phone: '(619) 555-0100', prefix: 'TGT', groupName: 'Target Batch',
  cardIds: tenCards, markUsed: true,
};
const r = buildDraft(vault, base);
assert.ok(r.ok, JSON.stringify(r));
const d = r.draft;
assert.strictEqual(d.profiles.length, 5);
assert.ok(d.profiles.every((p) => p.last === 'Quiroz'));
assert.strictEqual(new Set(d.profiles.map((p) => p.first)).size, 5, 'first names are different');
{
  // numbered accounts: prefix + number, matching accounts that already exist
  const seq = buildDraft(vault, { ...base, count: 8, emailStyle: 'sequence', emailPrefix: 'acct@x.com', emailStart: '3' });
  assert.ok(seq.ok, JSON.stringify(seq));
  assert.deepStrictEqual(seq.draft.profiles.map((p) => p.email), Array.from({ length: 8 }, (_, i) => `acct${3 + i}@valid3d.com`));
  assert.strictEqual(buildDraft(vault, { ...base, emailStyle: 'sequence', emailPrefix: '' }).ok, false, 'prefix required');
  assert.strictEqual(buildDraft(vault, { ...base, emailStyle: 'sequence', emailPrefix: 'a', emailStart: '1.5' }).ok, false);
  assert.strictEqual(buildDraft(vault, { ...base, emailStyle: 'sequence', emailPrefix: 'a', emailStart: '' }).draft.profiles[0].email, 'a1@valid3d.com', 'start defaults to 1');
  // match vault accounts: the profile emails are the account emails
  {
    const av = new VaultStore(path.join(tmp, 'match.json'), fakeCrypto);
    av.addAddress({ line1: '9 oak st', line2: '', city: 'x', state: 'CA', zip: '92127' });
    av.addCardsBulk(['4111111111111111', '5555555555554444', '378282246310005'].map((n) => `${n}:10:2031:${n.startsWith('37') ? '1234' : '123'}`).join('\n'));
    av.addAccountsBulk('a1@x.com:p1\na2@x.com:p2\na3@x.com:p3', { retailer: 'target' });
    av.addAccountsBulk('pk@x.com:p', { retailer: 'pokemoncenter' });
    const sn = av.snapshot();
    const o = { ...base, addressId: sn.addresses[0].id, cardIds: sn.cards.map((c) => c.id), count: 3, domain: '', emailStyle: 'accounts', accountIds: sn.accounts.filter((a) => a.retailer === 'target').map((a) => a.id) };
    const ok = buildDraft(av, o);
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.deepStrictEqual(ok.draft.profiles.map((p) => p.email), ['a1@x.com', 'a2@x.com', 'a3@x.com']);
    assert.ok(!JSON.stringify(ok.draft).includes('p1'), 'no passwords in the draft');
    assert.ok(!buildDraft(av, { ...o, count: 4, cardIds: sn.cards.map((c) => c.id) }).ok, 'needs enough accounts');
    assert.ok(!buildDraft(av, { ...o, accountIds: sn.accounts.map((a) => a.id), count: 3 }).ok, 'accounts must match the site');
    assert.ok(!buildDraft(av, { ...o, domain: '', emailStyle: 'firstlast' }).ok, 'domain still required for name-based emails');
  }
  const { MALE_FIRST_NAMES, FEMALE_FIRST_NAMES } = require('../src/names');
  const m = buildDraft(vault, { ...base, firstMode: 'male' });
  const f = buildDraft(vault, { ...base, firstMode: 'female' });
  assert.ok(m.draft.profiles.every((p) => MALE_FIRST_NAMES.includes(p.first)));
  assert.ok(f.draft.profiles.every((p) => FEMALE_FIRST_NAMES.includes(p.first)));
}
assert.ok(d.profiles.every((p) => p.email === `${p.first.toLowerCase()}quiroz@valid3d.com`));
assert.strictEqual(new Set(d.profiles.map((p) => p.address.line1 + '|' + p.address.line2)).size, 5);
assert.ok(d.profiles.every((p) => p.address.line1.startsWith('123 ')), 'house number untouched');
assert.deepStrictEqual(d.cardIds, tenCards.slice(0, 5), 'first 5 of the 10 selected cards');
assert.ok(d.profiles.every((p) => p.phone === '6195550100'));
assert.ok(d.profiles.every((p) => p.address.city === 'San Diego' && p.address.zip === '92127'));
assert.strictEqual(previewRows(d).length, 5);
assert.ok(!JSON.stringify(previewRows(d)).includes('4111111111111111'));

// Validation
assert.ok(!buildDraft(vault, { ...base, count: 11 }).ok, 'needs 11 cards but only 10 selected');
assert.ok(!buildDraft(vault, { ...base, domain: 'nodomain' }).ok);
assert.ok(!buildDraft(vault, { ...base, lastName: '' }).ok);
assert.ok(!buildDraft(vault, { ...base, addressId: 'nope' }).ok);
assert.ok(!buildDraft(vault, { ...base, phone: '123' }).ok);
// Same first + last on all still gives unique emails
const dup = buildDraft(vault, { ...base, firstMode: 'custom', firstName: 'Cami' });
assert.ok(dup.ok);
assert.strictEqual(new Set(dup.draft.profiles.map((p) => p.email)).size, 5);

// Phone jig keeps the area code, name jig keeps the last name
{
  const pj = buildDraft(vault, { ...base, phoneMode: 'area', areaCode: '619', firstMode: 'custom', firstName: 'Michael', jigName: true });
  assert.ok(pj.ok, JSON.stringify(pj));
  assert.ok(pj.draft.profiles.every((p) => p.phone.startsWith('619') && p.phone !== '6195550100'));
  assert.strictEqual(new Set(pj.draft.profiles.map((p) => p.phone)).size, 5);
  assert.ok(pj.draft.profiles.every((p) => p.last === 'Quiroz' && p.first !== 'Michael'));
  assert.ok(!buildDraft(vault, { ...base, phoneMode: 'area', areaCode: '' }).ok, 'custom area code mode needs an area code');
  assert.ok(!buildDraft(vault, { ...base, phoneMode: 'area', areaCode: '111' }).ok, 'invalid area code');
  assert.ok(!buildDraft(vault, { ...base, groupName: '  ' }).ok, 'group name is required');
  const rnd = buildDraft(vault, { ...base, phoneMode: 'random', areaCode: '' });
  assert.ok(rnd.ok, 'fully random phone needs no area code');
  assert.ok(rnd.draft.profiles.every((p) => /^[2-9]\d\d[2-9]\d\d\d{4}$/.test(p.phone) && AREA_CODES.includes(p.phone.slice(0, 3)) && p.phone.slice(4, 6) !== '11' && p.phone.slice(3, 6) !== '555'));
  assert.strictEqual(new Set(rnd.draft.profiles.map((p) => p.phone)).size, 5, 'phones are different');
  const none = buildDraft(vault, { ...base, phoneMode: 'none' });
  assert.ok(none.ok && none.draft.profiles.every((p) => p.phone === ''));
  // profile names: prefix + 1, 2, 3 (not zero padded)
  const named = buildDraft(vault, { ...base, prefix: 'camilo trg', count: 10, cardIds: tenCards });
  assert.deepStrictEqual(named.draft.profiles.map((p) => p.name), Array.from({ length: 10 }, (_, i) => `camilo trg ${i + 1}`));
}
// ---------------------------------------------------------------- export + mark used
(async () => {
  const written = {};
  const api = createApi({
    vault,
    showSave: async ({ defaultPath }) => path.join(tmp, defaultPath),
    writeFile: (p, text) => { written[p] = text; fs.writeFileSync(p, text); },
  });
  assert.ok((await api['builder:generate'](base)).ok);
  const ex = await api['builder:export']('hayha');
  assert.ok(ex.ok && ex.marked === 5);
  const hayhaText = written[ex.filePath];
  const hayha = JSON.parse(hayhaText);
  assert.strictEqual(hayha.length, 5);
  assert.deepStrictEqual(Object.keys(hayha[0]), ['name', 'shipping', 'cardInfo', 'sameAsBilling', 'groupId', 'id', 'encrypted']);
  assert.strictEqual(hayha[0].shipping.lastName, 'Quiroz');
  assert.strictEqual(typeof hayha[0].cardInfo.expYear, 'number');
  assert.strictEqual(hayha[0].cardInfo.holder, 'Camilo Quiroz');
  assert.strictEqual(hayha[0].sameAsBilling, true);
  assert.strictEqual(new Set(hayha.map((p) => p.groupId)).size, 1);

  // Cards 1-5 now in use, 6-10 still available; exporting Polar afterwards does not re-mark.
  let s = vault.snapshot();
  assert.strictEqual(s.cards.filter((c) => c.used).length, 5);
  assert.deepStrictEqual(s.cards.filter((c) => c.used).map((c) => c.id), tenCards.slice(0, 5));
  const ex2 = await api['builder:export']('polar');
  assert.ok(ex2.ok && ex2.marked === 0);
  assert.strictEqual(vault.snapshot().groups.length, 1, 'exporting the same batch again does not save a second group');
  assert.deepStrictEqual(vault.snapshot().groups[0].formats, ['hayha', 'polar']);
  const polar = JSON.parse(written[ex2.filePath]).polarExport;
  assert.strictEqual(polar.kind, 'profiles');
  assert.strictEqual(polar.profileGroup, 'Target Batch');
  assert.deepStrictEqual(polar.profiles[0].billingAddress, polar.profiles[0].shippingAddress);
  assert.strictEqual(polar.profiles[0].shippingAddress.state, 'California');
  assert.strictEqual(polar.profiles[0].paymentDetails.cardExpYear.length, 4);

  // The batch was saved as a group (profiles only keep a card reference and last 4)
  let snapG = vault.snapshot();
  assert.strictEqual(snapG.groups.length, 1);
  const grp = snapG.groups[0];
  assert.strictEqual(grp.name, 'Target Batch');
  assert.strictEqual(grp.site, 'target');
  assert.deepStrictEqual(grp.formats, ['hayha', 'polar']);
  assert.strictEqual(grp.profiles.length, 5);
  assert.strictEqual(grp.profiles[0].cardLast4, '1111');
  assert.strictEqual(grp.profiles[0].last, 'Quiroz');
  assert.ok(!JSON.stringify(snapG.groups).match(/4111111111111111|cvv/i), 'no full card numbers in saved groups');

  // CSV: spec columns, no card data, and it does not mark cards
  const before = vault.snapshot().cards.filter((c) => c.used).length;
  assert.ok((await api['builder:generate'](base)).ok);
  const csvEx = await api['builder:export']('csv');
  assert.ok(csvEx.ok && csvEx.marked === 0);
  const csv = written[csvEx.filePath];
  assert.strictEqual(csv.split('\r\n')[0], 'Line 1,Line 2,City,State,Zip,Phone,First Name,Last Name');
  assert.strictEqual(csv.trim().split('\r\n').length, 6);
  assert.ok(!/4111|5555|cvv/i.test(csv));
  assert.strictEqual(vault.snapshot().cards.filter((c) => c.used).length, before);
  assert.strictEqual(buildCsvFile([{ address: { line1: '=1+1', line2: 'a,b', city: 'x', state: { shortCode: 'CA' }, zip: '1' }, phone: '', first: 'A', last: 'B' }]).split('\r\n')[1], "'=1+1,\"a,b\",x,CA,1,,A,B");

  // Exports are valid input for the converter in both directions.
  assert.strictEqual(convert(hayhaText, { groupName: 'X' }).to, 'polar-profiles');
  assert.strictEqual(convert(written[ex2.filePath]).to, 'hayha-profiles');

  // Groups survive a restart, duplicate names are made unique, and groups can be deleted
  vault = new VaultStore(file, fakeCrypto);
  assert.strictEqual(vault.snapshot().groups.length, 1);
  assert.strictEqual(vault.snapshot().groups[0].profiles.length, 5);
  const api2 = createApi({ vault, showSave: async ({ defaultPath }) => path.join(tmp, 'again-' + defaultPath), writeFile: (p, t) => fs.writeFileSync(p, t) });
  const again = buildDraft(vault, { ...base, cardIds: vault.snapshot().cards.filter((c) => !c.used).map((c) => c.id), markUsed: false });
  assert.ok(again.ok);
  assert.ok((await api2['builder:generate']({ ...base, cardIds: vault.snapshot().cards.filter((c) => !c.used).map((c) => c.id), markUsed: false })).ok);
  assert.ok((await api2['builder:export']('polar')).saved);
  const names = vault.snapshot().groups.map((g) => g.name);
  assert.deepStrictEqual(names, ['Target Batch (2)', 'Target Batch']);
  assert.ok(vault.deleteGroup(vault.snapshot().groups[0].id).ok);
  assert.strictEqual(vault.snapshot().groups.length, 1);
  assert.ok(!vault.deleteGroup('nope').ok);

  // Next batch picks from the remaining 5 available cards.
  const avail = vault.snapshot().cards.filter((c) => !c.used).map((c) => c.id);
  const next = buildDraft(vault, { ...base, cardIds: avail, count: 5, lastMode: 'random' });
  assert.ok(next.ok);
  assert.strictEqual(next.warnings.filter((w) => /already marked/.test(w)).length, 0);
  // Reusing an in-use card warns.
  const reuse = buildDraft(vault, { ...base, cardIds: tenCards });
  assert.ok(reuse.warnings.some((w) => /already marked/.test(w)), 'first 5 are the used ones, so this warns');
})().then(() => console.log('All builder tests passed.')).catch((e) => { console.error(e); process.exit(1); });

// ---------------------------------------------------------------- editor (import, duplicates, re-jig)
(async () => {
  const { buildHayhaFile, buildPolarFile } = require('../src/converter');
  const ev = new VaultStore(path.join(tmp, 'editor.json'), fakeCrypto);
  const api = createApi({ vault: ev, showSave: async ({ defaultPath }) => path.join(tmp, defaultPath), writeFile: (p, t) => fs.writeFileSync(p, t) });
  const mk = (i, over = {}) => ({
    name: `P ${i}`, first: over.first || `First${i}`, last: over.last || `Last${i}`, email: over.email || `u${i}@x.com`, phone: '2105550100',
    address: { line1: over.line1 || `17161 Alva Rd Unit 2814`, line2: '', city: 'San Antonio', state: { shortCode: 'TX', name: 'Texas' }, zip: '78245', country: 'United States' },
    card: { number: over.card || ['4111111111111111', '5555555555554444', '378282246310005', '6011111111111117', '4012888888881881'][i], holder: 'H', expMonth: '10', expYear: '2031', cvv: '123' },
  });
  // 0 and 1 share an email, 1 and 2 share a name, 2 and 3 share a card, 0, 1, 2 and 4 share an address; 3 has its own address
  const profiles = [mk(0, { email: 'dup@x.com' }), mk(1, { email: 'dup@x.com', first: 'Same', last: 'Person' }), mk(2, { first: 'Same', last: 'Person', card: '378282246310005' }),
    mk(3, { card: '378282246310005', line1: '17161 Alva Rd Apt 9' }), mk(4)];
  const file = buildHayhaFile(profiles);
  assert.ok(!(await api['editor:import']('not json', 'x.json')).ok && !(await api['editor:import']('[]', 'x.hayha')).ok);
  assert.ok(!(await api['editor:import'](JSON.stringify([{ username: 'a', password: 'b' }]), 'x.hayha')).ok, 'accounts file is refused');
  const imp = await api['editor:import'](file, 'My File.hayha');
  assert.ok(imp.ok && imp.count === 5 && imp.format === 'hayha', JSON.stringify(imp));
  const rec = imp.snapshot.imports[0];
  assert.strictEqual(rec.name, 'My File');
  assert.deepStrictEqual(rec.counts, { email: 2, name: 2, address: 4, card: 2 }, JSON.stringify(rec.counts));
  assert.ok(rec.profiles[0].flags.email && !rec.profiles[4].flags.email && rec.profiles[3].flags.card && !rec.profiles[3].flags.address);
  assert.ok(!/4111111111111111|"cvv"|378282246310005/.test(JSON.stringify(imp.snapshot)), 'no card numbers or CVVs reach the window');
  assert.ok(!fs.readFileSync(path.join(tmp, 'editor.json'), 'utf8').includes('4111111111111111'), 'encrypted at rest');

  // re-jig one profile: changes, never matches another profile, can be repeated, can be reset
  const id = rec.id;
  const target = rec.profiles[0].id;
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    const r = await api['editor:jig'](id, target);
    assert.ok(r.ok, JSON.stringify(r));
    const p = r.snapshot.imports[0].profiles[0];
    assert.ok(p.changed && p.address.line2 === '' && /^17161 Alva /.test(p.address.line1));
    assert.ok(!r.snapshot.imports[0].profiles.slice(1).some((q) => q.address.line1 === p.address.line1), 'unique within the file');
    seen.add(p.address.line1);
  }
  assert.ok(seen.size >= 4, 'repeated jigs give different results');
  const rs = await api['editor:reset'](id, target);
  assert.strictEqual(rs.snapshot.imports[0].profiles[0].address.line1, '17161 Alva Rd Unit 2814');
  assert.strictEqual(rs.snapshot.imports[0].profiles[0].changed, false);

  // fix duplicate addresses: the first of each set is kept, the rest become unique
  const fx = await api['editor:fix'](id);
  assert.ok(fx.ok && fx.fixed === 3 && fx.failed === 0, JSON.stringify(fx));
  const after = fx.snapshot.imports[0];
  assert.strictEqual(after.counts.address, 0);
  assert.strictEqual(after.profiles[0].address.line1, '17161 Alva Rd Unit 2814', 'first profile kept');
  assert.strictEqual(after.counts.email, 2, 'other duplicates are left alone');

  // export keeps the edits and the full card data; round-trips through the importer
  for (const format of ['hayha', 'polar']) {
    const ex = await api['editor:export'](id, format);
    assert.ok(ex.ok, JSON.stringify(ex));
    const text = fs.readFileSync(ex.filePath, 'utf8');
    const back = await api['editor:import'](text, `back.${format}`);
    assert.ok(back.ok && back.count === 5);
    const bp = back.snapshot.imports[0].profiles;
    assert.deepStrictEqual(bp.map((p) => p.address.line1), after.profiles.map((p) => p.address.line1));
    assert.deepStrictEqual(bp.map((p) => p.card.last4), ['1111', '4444', '0005', '0005', '1881']);
    assert.strictEqual(back.snapshot.imports[0].counts.address, 0);
  }
  // a Polar file with a group name and a different billing address
  const polar = JSON.parse(buildPolarFile(profiles.slice(0, 2), 'Grp'));
  polar.polarExport.profiles[0].sameBillingAndShippingAddress = false;
  polar.polarExport.profiles[0].billingAddress.line1 = 'elsewhere';
  const pi = await api['editor:import'](JSON.stringify(polar), '');
  assert.ok(pi.ok && pi.warnings.some((w) => /different billing/.test(w)));
  assert.strictEqual(pi.snapshot.imports[0].name, 'Grp', 'falls back to the Polar group name');
  assert.ok((await api['editor:delete'](pi.id)).ok && !(await api['editor:delete']('nope')).ok);
  assert.ok(!(await api['editor:jig'](id, 'nope')).ok);
  console.log('Editor tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
