'use strict';
// Streamer Mode (privacy filter). Presentation only: this file never touches the vault, the app state,
// or anything that gets exported. The render code asks it how to DISPLAY a value; the real value is untouched.
//
//   Blur       - the value stays in the page but is blurred (CSS) and cannot be selected.
//   Asterisks  - the value is replaced by a masked string before it is put on screen.
//
// Native pieces that cannot be blurred (dropdown options, confirm() boxes) are always shown masked while
// Streamer Mode is on, whichever style is picked.
(function () {
  const KEY = 'aioStudio.streamerMode';
  const state = { on: false, style: 'blur' };
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (d && typeof d === 'object') {
      state.on = d.on === true;
      state.style = d.style === 'asterisks' ? 'asterisks' : 'blur';
    }
  } catch (e) { /* storage unavailable: start with Streamer Mode off */ }

  const listeners = [];

  // ---------------------------------------------------------------- mask functions
  const ALNUM = /[\p{L}\p{N}]/gu;
  const hide = (s) => String(s).replace(ALNUM, '*');
  // first character stays, the rest is hidden: "Camilo" -> "C*****"
  const word = (w) => {
    const a = Array.from(String(w));
    return a.length ? a[0] + hide(a.slice(1).join('')) : '';
  };
  const maskWords = (s) => String(s).replace(/\S+/g, word); // "Camilo Quiroz" -> "C***** Q*****"

  // "vault.example.com" -> "v****.e******.com" (the last label, the TLD, stays)
  function maskDomainPart(d) {
    const labels = String(d).split('.');
    if (labels.length < 2) return word(d);
    const tld = labels.pop();
    return `${labels.map(word).join('.')}.${tld}`;
  }
  // "camilo@vault.com" -> "c*****@v****.com"
  function maskEmail(s) {
    const t = String(s);
    const at = t.lastIndexOf('@');
    return at < 0 ? maskWords(t) : `${word(t.slice(0, at))}@${maskDomainPart(t.slice(at + 1))}`;
  }
  // keeps the area code: "6195551234" -> "619*******"
  function maskPhone(s) {
    let n = 0;
    return String(s).replace(/\d/g, (d) => (++n <= 3 ? d : '*'));
  }

  const SUFFIX = new Set(`street st str road rd avenue ave av avn drive dr drv boulevard blvd boul terrace ter terr court ct crt
    lane ln place pl circle cir parkway pkwy pky bend bnd way wy trail trl highway hwy square sq loop lp cove cv ridge rdg
    crossing xing alley aly glen gln run path pass trace`.split(/\s+/));
  const UNIT_START = /^(apt|apartment|unit|un|ste|suite|bldg|building|rm|room|fl|floor|door|lot|spc|space|dept|no)\.?$|^#/i;
  const norm = (w) => w.toLowerCase().replace(/[.,]/g, '');

  // Hides the house number and street name, keeps the street type and any unit:
  // "17161 Alva Rd Hngr 2814" -> "***** **** Rd Hngr 2814". With no street type or unit found, everything is hidden.
  function maskLine1(line) {
    const parts = String(line).match(/\S+|\s+/g) || [];
    const words = [];
    parts.forEach((p, i) => { if (!/^\s/.test(p)) words.push(i); });
    let keepFrom = -1;
    for (let k = 2; k < words.length && keepFrom < 0; k++) if (SUFFIX.has(norm(parts[words[k]]))) keepFrom = k;
    for (let k = 2; k < words.length && keepFrom < 0; k++) if (UNIT_START.test(parts[words[k]])) keepFrom = k;
    if (keepFrom < 0) keepFrom = words.length;
    return parts.map((p, i) => {
      const k = words.indexOf(i);
      return k >= 0 && k < keepFrom ? hide(p) : p;
    }).join('');
  }

  const digitsToStars = (s) => String(s).replace(/\d/g, '*');
  const MASKERS = {
    line1: maskLine1,
    zip: digitsToStars,
    name: maskWords, // person names, cardholders and card nicknames
    email: maskEmail,
    domain: maskDomainPart,
    phone: maskPhone,
    last4: digitsToStars, // "1234" -> "****"
    exp: digitsToStars, // "12/27" -> "**/**"
  };
  const mask = (kind, raw) => {
    const t = raw === undefined || raw === null ? '' : String(raw);
    if (!t) return t;
    const f = MASKERS[kind];
    return f ? f(t) : hide(t);
  };

  // ---------------------------------------------------------------- what the render code uses
  const asterisks = () => state.on && state.style === 'asterisks';
  const plain = (v) => (v === undefined || v === null ? '' : String(v));

  // text for a span: masked only in Asterisks style
  const display = (kind, raw) => (asterisks() ? mask(kind, raw) : plain(raw));
  // text for places that cannot be blurred (dropdown options, confirm boxes): masked whenever Streamer Mode is on
  const text = (kind, raw) => (state.on ? mask(kind, raw) : plain(raw));

  // A <span class="sx"> for a sensitive value. In Blur style the stylesheet blurs every .sx.
  function sx(kind, raw) {
    const t = display(kind, raw);
    if (!t) return document.createTextNode('');
    const s = document.createElement('span');
    s.className = 'sx';
    s.textContent = t;
    return s;
  }

  // Wraps several pieces (street, unit, city, state, ZIP) so Blur style blurs them as ONE block, unit included.
  // In Asterisks style it is a plain span and each piece keeps whatever masking it already has.
  function group(...parts) {
    const g = document.createElement('span');
    g.className = 'sxg';
    parts.flat(Infinity).forEach((p) => { if (p !== '' && p != null) g.append(p); });
    return g;
  }

  // For strings the main process already joined: "line1 | line2" and "Visa •••• 1234" (-> arrays of nodes).
  function addrStr(s) {
    const [first, ...rest] = plain(s).split(' | ');
    return [group(sx('line1', first), rest.length ? ` | ${rest.join(' | ')}` : '')];
  }
  function cardStr(s) {
    const m = /^(.*?)(\d{4})$/.exec(plain(s));
    return m ? [m[1], sx('last4', m[2])] : [plain(s)];
  }

  // Free text (notes, messages) that may mention an email address.
  const EMAIL_IN_TEXT = /[^\s@"'<>()]+@[^\s@"'<>()]+\.[A-Za-z]{2,}/g;
  const scrub = (t) => (state.on ? plain(t).replace(EMAIL_IN_TEXT, maskEmail) : plain(t));

  // ---------------------------------------------------------------- state, storage, settings controls
  function syncControls() {
    document.querySelectorAll('[data-sm]').forEach((b) => {
      const active = (b.dataset.sm === 'on') === state.on;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('[data-ss]').forEach((b) => {
      const active = b.dataset.ss === state.style;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    const row = document.getElementById('smStyleRow');
    if (row) row.classList.toggle('dim', !state.on);
  }

  function apply() {
    document.body.classList.toggle('priv-blur', state.on && state.style === 'blur');
    document.body.classList.toggle('priv-ast', state.on && state.style === 'asterisks');
    syncControls();
  }

  function set(patch) {
    if ('on' in patch) state.on = !!patch.on;
    if ('style' in patch) state.style = patch.style === 'asterisks' ? 'asterisks' : 'blur';
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    apply();
    listeners.forEach((f) => { try { f(); } catch (e) { /* one bad listener must not stop the rest */ } });
  }

  document.querySelectorAll('[data-sm]').forEach((b) => b.addEventListener('click', () => set({ on: b.dataset.sm === 'on' })));
  document.querySelectorAll('[data-ss]').forEach((b) => b.addEventListener('click', () => set({ style: b.dataset.ss })));
  apply();

  window.Privacy = {
    get on() { return state.on; },
    get style() { return state.style; },
    set,
    onChange: (f) => { listeners.push(f); },
    mask, display, text, sx, group, addrStr, cardStr, scrub,
  };
})();
