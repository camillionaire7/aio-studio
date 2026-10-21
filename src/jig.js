'use strict';
// JigEngine: inline line-1 address jigging, plus phone and first-name jigs.
// Pure functions, no Electron dependencies. Pass `seed` (or `rng`) for repeatable output.
//
// Rules (same for every site):
//   - Address line 2 is ALWAYS empty. Everything is added at the end of line 1.
//   - The house number and the street name are never changed.
//   - HAS_APARTMENT (a unit was found): suffix x designator x zero-padded unit, in a fixed priority order.
//   - NO_APARTMENT: suffix + a designator + a short fake unit code, picked at random.
//   - Every line 1 in a batch is unique.

// Street types: [full, full with period, abbreviated, abbreviated with period].
const SUFFIX_VARIANTS = {
  Street: ['Street', 'Street.', 'St', 'St.'],
  Road: ['Road', 'Road.', 'Rd', 'Rd.'],
  Avenue: ['Avenue', 'Avenue.', 'Ave', 'Ave.'],
  Drive: ['Drive', 'Drive.', 'Dr', 'Dr.'],
  Boulevard: ['Boulevard', 'Boulevard.', 'Blvd', 'Blvd.'],
  Terrace: ['Terrace', 'Terrace.', 'Ter', 'Ter.'],
  Court: ['Court', 'Court.', 'Ct', 'Ct.'],
  Lane: ['Lane', 'Lane.', 'Ln', 'Ln.'],
  Place: ['Place', 'Place.', 'Pl', 'Pl.'],
  Circle: ['Circle', 'Circle.', 'Cir', 'Cir.'],
  Parkway: ['Parkway', 'Parkway.', 'Pkwy', 'Pkwy.'],
  Bend: ['Bend', 'Bend.', 'Bnd', 'Bnd.'],
  Way: ['Way', 'Way.', 'Wy', 'Wy.'],
  Trail: ['Trail', 'Trail.', 'Trl', 'Trl.'],
  // Extra street types so more addresses can be read (not in the spec's list).
  Highway: ['Highway', 'Highway.', 'Hwy', 'Hwy.'],
  Square: ['Square', 'Square.', 'Sq', 'Sq.'],
  Loop: ['Loop', 'Loop.', 'Lp', 'Lp.'],
  Cove: ['Cove', 'Cove.', 'Cv', 'Cv.'],
  Ridge: ['Ridge', 'Ridge.', 'Rdg', 'Rdg.'],
  Crossing: ['Crossing', 'Crossing.', 'Xing', 'Xing.'],
  Alley: ['Alley', 'Alley.', 'Aly', 'Aly.'],
  Glen: ['Glen', 'Glen.', 'Gln', 'Gln.'],
  Run: ['Run', 'Run.'],
  Path: ['Path', 'Path.'],
  Pass: ['Pass', 'Pass.'],
  Trace: ['Trace', 'Trace.'],
};
// Other spellings that are recognized when reading an address (not produced).
const SUFFIX_ALIASES = {
  Street: ['Str', 'Str.'], Avenue: ['Av', 'Avn'], Boulevard: ['Boul', 'Boulv'], Drive: ['Drv'], Terrace: ['Terr', 'Trce'],
  Court: ['Crt'], Circle: ['Crcl'], Parkway: ['Pky'], Bend: ['Bd'], Trail: ['Trls'],
};

// Designators put before the unit at the end of line 1.
const PRIMARY_DESIGNATORS = ['APT', 'STE', 'Door', 'Floor'];
const EXTENDED_DESIGNATORS = ['Unit', 'UNIT', 'Apt', 'Apt.', 'Ste', 'Ste.', 'Suite', 'Fl', 'Rm', '#'];
const DESIGNATOR_LIST = ['', ...PRIMARY_DESIGNATORS, ...EXTENDED_DESIGNATORS]; // '' = bare unit (only when a unit exists)

const MODES = ['TARGET', 'POKEMON_CENTER', 'CUSTOM'];
const SITE_TO_MODE = { target: 'TARGET', walmart: 'CUSTOM', pokemoncenter: 'POKEMON_CENTER', other: 'CUSTOM' };

// ---------------------------------------------------------------- helpers

const norm = (t) => String(t).toLowerCase().replace(/[.,]/g, '');
const SUFFIX_LOOKUP = (() => {
  const m = new Map();
  for (const [canon, variants] of Object.entries(SUFFIX_VARIANTS)) {
    m.set(norm(canon), canon);
    variants.forEach((v) => m.set(norm(v), canon));
  }
  for (const [canon, list] of Object.entries(SUFFIX_ALIASES)) list.forEach((v) => m.set(norm(v), canon));
  return m;
})();
const DIRECTION_RE = /^(n|s|e|w|ne|nw|se|sw|north|south|east|west|northeast|northwest|southeast|southwest)\.?$/i;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
const PREFIX_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O (used by the first-name jig)

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

// ---------------------------------------------------------------- parsing

const UNIT_WORDS = 'apt|apartment|unit|un|ste|suite|bldg|building|rm|room|fl|floor|door|lot|spc|space|dept|no|#';
const INLINE_UNIT_RE = new RegExp(`\\s+(${UNIT_WORDS})\\.?\\s*#?\\s*([A-Za-z0-9-]+)\\s*$`, 'i');
// Leading designator word. "floor" is tried before "fl" so "floor 2" is not cut to "oor 2".
const UNIT_STRIP_RE = /^(unit|un\.?|apt\.?|apartment|suite|ste\.?|#|no\.?|number|rm\.?|room|door|floor|fl\.?|bldg\.?|building|spc\.?|space|dept\.?|lot)\s*/i;

// "unit 2814" / "Apt. 4B" / "# 12" / "007H" -> "2814" / "4B" / "12" / "7H". Never a trailing period, never leading zeros.
function extractUnitCore(input) {
  let core = String(input || '').trim();
  for (let i = 0; i < 2; i++) core = core.replace(UNIT_STRIP_RE, '').trim(); // second pass handles "Apt #4"
  core = core.replace(/\.+$/, '');
  return core.replace(/^0+(?=.)/, '');
}

// A unit at the end of a raw line, e.g. "17161 Alva Rd unit 2814". The value needs a digit or a single letter,
// so street names like "Space Rd" are not mistaken for a unit.
function findInlineUnit(line) {
  const m = INLINE_UNIT_RE.exec(line);
  if (!m) return null;
  if (!/\d/.test(m[2]) && m[2].length !== 1) return null;
  return { index: m.index, text: line.slice(m.index).trim() };
}

const cleanNumber = (n) => String(n).trim().replace(/[^A-Za-z0-9]/g, ''); // never any punctuation on the house number

// -> { baseStreet, suffix (canonical or null), postDirection, unitCore, isMultiUnit } or null
function parseAddress(base) {
  let line1 = String((base && (base.line1 !== undefined ? base.line1 : base.baseStreet)) || '').trim().replace(/\s+/g, ' ');
  let suffixText = base && base.streetSuffix ? String(base.streetSuffix).trim() : '';
  let unitRaw = String((base && (base.line2 !== undefined ? base.line2 : base.existingUnit)) || '').trim();
  if (base && base.line2 === undefined && base.existingUnit === undefined) unitRaw = '';
  const found = findInlineUnit(line1);
  if (found) {
    unitRaw = found.text;
    line1 = line1.slice(0, found.index).trim();
  }
  if (suffixText) line1 = `${line1} ${suffixText}`;
  const tokens = line1.split(' ').filter(Boolean);
  if (tokens.length < 2 || !/^\d/.test(tokens[0])) return null;
  tokens[0] = cleanNumber(tokens[0]);
  if (!tokens[0]) return null;

  let postDirection = '';
  if (tokens.length >= 4 && DIRECTION_RE.test(tokens[tokens.length - 1]) && SUFFIX_LOOKUP.has(norm(tokens[tokens.length - 2]))) {
    postDirection = tokens.pop();
  }
  let suffix = null;
  if (tokens.length >= 3 && SUFFIX_LOOKUP.has(norm(tokens[tokens.length - 1]))) {
    suffix = SUFFIX_LOOKUP.get(norm(tokens.pop()));
  }
  const baseStreet = tokens.join(' ').replace(/[.,]+$/, ''); // house number + street name, exactly as entered
  const unitCore = extractUnitCore(unitRaw);
  return { baseStreet, suffix, postDirection, unitCore, isMultiUnit: !!unitCore };
}

// ---------------------------------------------------------------- generators

// [full, full with period, abbreviated, abbreviated with period]
function suffixRoles(suffix) {
  const v = SUFFIX_VARIANTS[suffix];
  return { full: v[0], fullDot: v[1], abbr: v[2] || v[0], abbrDot: v[3] || v[1] };
}

// Raw value, one leading zero, two leading zeros.
function getUnitValueVariants(unitCore) {
  return [unitCore, `0${unitCore}`, `00${unitCore}`];
}

// Short fake unit: 2, 04, 8B, 08B
function fakeUnitCode(rng) {
  const d = 1 + Math.floor(rng() * 9);
  const letter = 'ABCDEFGH'[Math.floor(rng() * 8)];
  switch (Math.floor(rng() * 4)) {
    case 0: return String(d);
    case 1: return `0${d}`;
    case 2: return `${d}${letter}`;
    default: return `0${d}${letter}`;
  }
}

const line1Of = (p, suffixText, designator, unit) =>
  [p.baseStreet, suffixText, p.postDirection, designator, unit].filter(Boolean).join(' ');

// Mode 1: no apartment. Random suffix style + designator + fake unit code.
function generateNoApartment(p, count, rng) {
  const styles = p.suffix ? Object.values(suffixRoles(p.suffix)) : [''];
  const designators = count > 20 ? [...PRIMARY_DESIGNATORS, ...EXTENDED_DESIGNATORS] : PRIMARY_DESIGNATORS;
  const seen = new Set();
  const out = [];
  for (let i = 0; i < count; i++) {
    let made = false;
    for (let t = 0; t < 1000 && !made; t++) {
      const line1 = line1Of(p, pick(styles, rng), pick(designators, rng), fakeUnitCode(rng));
      if (seen.has(line1)) continue;
      seen.add(line1);
      out.push({ line1, line2: '' });
      made = true;
    }
    if (!made) break;
  }
  return out;
}

// Mode 2: has an apartment. Fixed priority list first, then every remaining suffix x designator x unit combination.
function generateWithApartment(p, count) {
  const r = p.suffix ? suffixRoles(p.suffix) : { full: '', fullDot: '', abbr: '', abbrDot: '' };
  const [u0, u1, u2] = getUnitValueVariants(p.unitCore);
  const combos = [
    [r.abbrDot, '', u0], [r.full, 'APT', u0], [r.abbrDot, 'STE', u0], [r.abbrDot, 'Door', u0],
    [r.abbrDot, 'APT', u1], [r.abbrDot, 'STE', u1], [r.fullDot, 'Floor', u0],
  ];
  const styles = [r.full, r.fullDot, r.abbr, r.abbrDot];
  const tiers = [['', ...PRIMARY_DESIGNATORS], EXTENDED_DESIGNATORS];
  for (const tier of tiers) {
    for (const unit of [u0, u1, u2]) {
      for (const d of tier) for (const st of styles) combos.push([st, d, unit]);
    }
  }
  const seen = new Set();
  const out = [];
  for (const [st, d, unit] of combos) {
    const line1 = line1Of(p, st, d, unit);
    if (seen.has(line1)) continue;
    seen.add(line1);
    out.push({ line1, line2: '' });
    if (out.length >= count) break;
  }
  return out;
}

// ---------------------------------------------------------------- batch generation

function jigAddress(base, count, opts = {}) {
  const rng = opts.rng || (opts.seed !== undefined ? mulberry32(opts.seed) : Math.random);
  const rawMode = opts.mode || (base && base.retailerMode);
  const mode = MODES.includes(rawMode) ? rawMode : (SITE_TO_MODE[opts.site] || 'CUSTOM');
  if (count === undefined && base && base.batchSize !== undefined) count = base.batchSize;
  const warnings = [];

  if (!Number.isInteger(count) || count < 1 || count > 500) {
    return { variants: [], mode, warnings: ['The batch size must be a whole number from 1 to 500.'] };
  }
  const p = parseAddress(typeof base === 'string' ? { line1: base } : base);
  if (!p) {
    return { variants: [], mode, warnings: ['Could not find a house number followed by a street name on line 1, so this address cannot be jigged.'] };
  }
  if (!p.suffix) warnings.push('No street type (St, Ave, Rd...) was recognized, so the street type was not varied.');

  const variants = p.isMultiUnit ? generateWithApartment(p, count) : generateNoApartment(p, count, rng);
  if (variants.length < count) {
    warnings.push(`Only ${variants.length} unique variation${variants.length === 1 ? '' : 's'} exist for this address (requested ${count}).`);
  }
  warnings.push(p.isMultiUnit
    ? `Your unit (${p.unitCore}) was kept and moved to the end of line 1 with different designators, street type spellings and leading zeros. Line 2 is empty.`
    : 'No apartment was found, so each profile gets a made-up unit (like "APT 8B") at the end of line 1. Line 2 is empty.');
  return { variants, mode, warnings };
}

// ---------------------------------------------------------------- phone and name jigs

// Real, assigned US area codes, used for fully random phone numbers.
const AREA_CODES = `201 202 203 205 206 207 208 209 210 212 213 214 215 216 217 218 219 224 225 228 229 231 234 239 240 248 251 252 253 254 256 260 262 267 269 270 272 276 281 301 302 303 304 305 307 308 309 310 312 313 314 315 316 317 318 319 320 321 323 325 330 334 336 337 339 346 347 351 352 360 361 385 386 401 402 404 405 406 407 408 409 410 412 413 414 415 417 419 423 424 425 430 432 434 435 440 442 443 469 470 475 478 479 480 484 501 502 503 504 505 507 508 509 510 512 513 515 516 517 518 520 530 531 534 539 540 541 551 559 561 562 563 567 570 571 573 574 580 585 586 601 602 603 605 606 607 608 609 610 612 614 615 616 617 618 619 620 623 626 628 629 630 631 636 641 646 650 651 657 660 661 662 667 669 678 681 682 701 702 703 704 706 707 708 712 713 714 715 716 717 718 719 720 724 725 727 731 732 734 737 740 747 754 757 760 762 763 765 769 770 772 773 774 775 779 781 785 786 801 802 803 804 805 806 808 810 812 813 814 815 816 817 818 828 830 831 832 843 845 847 848 850 856 857 858 859 860 862 863 864 865 870 872 878 901 903 904 906 907 908 909 910 912 913 914 915 916 917 918 919 920 925 928 929 931 936 937 940 941 947 949 951 952 954 956 959 970 971 972 973 978 979 980 984 985 989`.split(/\s+/);

// Same area code, a valid exchange (200-999, never N11 or 555), and 4 random digits.
function jigPhone(areaCode, rng = Math.random, taken = null) {
  const ac = String(areaCode || '').replace(/\D/g, '').slice(0, 3);
  if (!/^[2-9]\d\d$/.test(ac)) throw new Error('A valid 3-digit area code is needed to jig phone numbers.');
  for (let i = 0; i < 1000; i++) {
    const exch = 200 + Math.floor(rng() * 800);
    if (exch % 100 === 11 || exch === 555) continue;
    const line = String(Math.floor(rng() * 10000)).padStart(4, '0');
    const num = `${ac}${exch}${line}`;
    if (taken && taken.has(num)) continue;
    if (taken) taken.add(num);
    return num;
  }
  throw new Error('Could not generate a unique phone number.');
}

const NICKNAMES = {
  michael: ['Mike', 'Mikey'], william: ['Will', 'Bill', 'Billy'], robert: ['Rob', 'Bob', 'Bobby'], james: ['Jim', 'Jimmy'],
  richard: ['Rick', 'Rich', 'Dick'], joseph: ['Joe', 'Joey'], thomas: ['Tom', 'Tommy'], christopher: ['Chris'],
  daniel: ['Dan', 'Danny'], matthew: ['Matt'], anthony: ['Tony'], elizabeth: ['Liz', 'Beth', 'Lizzy'],
  jennifer: ['Jen', 'Jenny'], jessica: ['Jess', 'Jessie'], katherine: ['Kate', 'Katie', 'Kathy'], samantha: ['Sam'],
  alexander: ['Alex'], benjamin: ['Ben'], nicholas: ['Nick'], jonathan: ['Jon'], stephen: ['Steve'], andrew: ['Andy', 'Drew'],
  patricia: ['Pat', 'Patty'], margaret: ['Maggie', 'Peggy'], rebecca: ['Becky'], joshua: ['Josh'], timothy: ['Tim'],
  kenneth: ['Ken', 'Kenny'], jeffrey: ['Jeff'], gregory: ['Greg'], edward: ['Ed', 'Eddie'], ronald: ['Ron'],
  donald: ['Don'], steven: ['Steve'], charles: ['Charlie', 'Chuck'], nathan: ['Nate'], zachary: ['Zach'],
  victoria: ['Vicky'], kimberly: ['Kim'], deborah: ['Debbie'], stephanie: ['Steph'], christine: ['Chris', 'Christy'],
  amanda: ['Mandy'], abigail: ['Abby'], isabella: ['Bella'], jacqueline: ['Jackie'], theresa: ['Terri'],
};

// Last name is never changed. Changes the first name by nickname, middle initial, or a doubled letter.
function jigName(firstName, lastName, rng = Math.random) {
  const first = String(firstName || '').trim();
  const options = [];
  const nick = NICKNAMES[first.toLowerCase()];
  if (nick) options.push(() => pick(nick, rng));
  options.push(() => `${first} ${pick(PREFIX_LETTERS.split(''), rng)}`);
  if (first.length >= 3) {
    options.push(() => {
      const i = 1 + Math.floor(rng() * (first.length - 1));
      return first.slice(0, i + 1) + first[i] + first.slice(i + 1);
    });
  }
  return { first: pick(options, rng)(), last: lastName };
}

module.exports = {
  jigAddress, jigPhone, jigName, parseAddress, extractUnitCore, getUnitValueVariants, levenshtein,
  AREA_CODES, SUFFIX_VARIANTS, DESIGNATOR_LIST, PRIMARY_DESIGNATORS, EXTENDED_DESIGNATORS, MODES, mulberry32,
};
