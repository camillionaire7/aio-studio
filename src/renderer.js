'use strict';
// Converter view, Recently converted, and the Open Hayha / Open Polar buttons.
const $ = (id) => document.getElementById(id);

// Date headers (M/D, plus the year when it is not this year). Shared with ui.js.
function dayKey(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return 'Earlier';
  const base = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${base}/${String(d.getFullYear()).slice(-2)}`;
}
// [{ key, label, items }] newest day first; items keep their original order within a day.
function groupByDay(items, getIso) {
  const days = new Map();
  items.forEach((it) => {
    const iso = getIso(it);
    const key = dayKey(iso) || '0000';
    if (!days.has(key)) days.set(key, { key, label: dayLabel(iso), items: [] });
    days.get(key).items.push(it);
  });
  return [...days.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}
const drop = $('drop');
const fileInput = $('file');
let currentText = null;

function setMsg(text, cls) {
  const m = $('msg');
  m.textContent = text || '';
  m.className = cls || '';
}

// A short status line (used by the Open Hayha / Open Polar buttons, which live in the header on every tab).
let toastTimer;
function toast(text, cls) {
  const t = $('toast');
  t.textContent = Privacy.scrub(text || '');
  t.className = 'toast ' + (cls || '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

// Streamer Mode: which preview columns hold sensitive values (the card column is "•••• 1234").
const COL_KIND = { Name: 'name', Username: 'email', Card: 'card' };
let lastPreview = null;
let lastNotes = [];

function renderTable(preview) {
  lastPreview = preview;
  const t = $('table');
  t.replaceChildren();
  const head = t.createTHead().insertRow();
  preview.columns.forEach((c) => {
    const th = document.createElement('th');
    th.textContent = c;
    head.appendChild(th);
  });
  const kinds = preview.columns.map((c) => COL_KIND[c]);
  const body = t.createTBody();
  preview.rows.forEach((row) => {
    const tr = body.insertRow();
    row.forEach((cell, i) => {
      const td = tr.insertCell();
      const kind = kinds[i];
      if (kind === 'card') td.append(...Privacy.cardStr(cell));
      else if (kind) td.append(Privacy.sx(kind, cell));
      else td.textContent = cell;
    });
  });
}

function renderNotes() {
  const notes = $('notes');
  notes.replaceChildren();
  lastNotes.forEach((w) => {
    const li = document.createElement('li');
    li.textContent = Privacy.scrub(w);
    notes.appendChild(li);
  });
}

// Streamer Mode switched on/off or restyled: redraw what is on screen (the data itself is not touched).
Privacy.onChange(() => {
  if (lastPreview) renderTable(lastPreview);
  renderNotes();
});

async function run() {
  if (currentText === null) return;
  const res = await window.api.convert(currentText, $('group').value);
  if (!res.ok) {
    $('result').style.display = 'none';
    setMsg(res.error, 'err');
    return;
  }
  setMsg('');
  $('from').textContent = res.fromLabel;
  $('to').textContent = res.toLabel;
  $('groupLabel').style.display = res.needsGroupName ? 'flex' : 'none';
  $('save').textContent = `Save ${res.count} ${res.count === 1 ? 'item' : 'items'} as ${res.fileName}`;
  renderTable(res.preview);
  lastNotes = res.warnings;
  renderNotes();
  $('result').style.display = 'block';
}

async function loadFile(file) {
  if (!file) return;
  currentText = await file.text();
  await run();
}

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

let timer;
$('group').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });

$('save').addEventListener('click', async () => {
  const r = await window.api.save();
  if (r.ok) { setMsg('Saved to ' + r.filePath, 'ok'); if (r.history) renderRecent(r.history); }
  else if (!r.canceled) setMsg(r.error, 'err');
});

// ---------------------------------------------------------------- recently converted
function renderRecent(items) {
  const list = $('recentList');
  list.replaceChildren();
  $('recentClear').hidden = !items.length;
  if (!items.length) {
    const li = document.createElement('li');
    const d = document.createElement('div');
    d.className = 'main meta';
    d.textContent = 'Nothing converted yet. Files you save show up here.';
    li.appendChild(d);
    list.appendChild(li);
    return;
  }
  groupByDay(items, (i) => i.at).forEach((day) => {
    const head = document.createElement('li');
    head.className = 'datehead';
    head.textContent = day.label;
    list.appendChild(head);
    day.items.forEach((i) => {
      const li = document.createElement('li');
      const main = document.createElement('div');
      main.className = 'main';
      const b = document.createElement('b');
      b.textContent = i.fileName;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const time = new Date(i.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      meta.textContent = `${i.fromLabel} → ${i.toLabel} · ${i.count} ${i.count === 1 ? 'item' : 'items'} · ${time}`;
      main.append(b, meta);
      const acts = document.createElement('div');
      acts.className = 'acts';
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'sec';
      show.textContent = 'Show in folder';
      show.addEventListener('click', async () => {
        const r = await window.api.historyShow(i.id);
        if (!r.ok) setMsg(r.error, 'err');
      });
      const toEditor = document.createElement('button');
      toEditor.type = 'button';
      toEditor.className = 'sec';
      toEditor.textContent = 'Open in Editor';
      const isProfiles = /profiles/i.test(i.toLabel);
      toEditor.disabled = !isProfiles;
      toEditor.title = isProfiles ? 'Load this file into the Editor' : 'Only profile files can be opened in the Editor';
      toEditor.addEventListener('click', async () => {
        const r = await window.api.historyEditor(i.id);
        if (r.ok) window.Studio.openInEditor(r);
        else setMsg(r.error, 'err');
      });
      acts.append(toEditor, show);
      li.append(main, acts);
      list.appendChild(li);
    });
  });
}

$('recentClear').addEventListener('click', async () => {
  if (!confirm('Clear the recently converted list? Your saved files are not touched.')) return;
  const r = await window.api.historyClear();
  if (r.ok) renderRecent(r.history);
});

window.api.historyGet().then((r) => renderRecent(r.ok ? r.history : []));

// ---------------------------------------------------------------- launch Hayha / Polar
async function launchApp(key) {
  let r = await window.api.appsLaunch(key);
  if (!r.ok && r.needsPath) {
    r = await window.api.appsChoose(key);
    if (r.ok) r = await window.api.appsLaunch(key);
    else if (r.canceled) return;
  }
  const label = key === 'hayha' ? 'Hayha' : 'Polar';
  const text = r.ok ? `Opening ${label}...` : (r.error || `Could not open ${label}.`);
  toast(text, r.ok ? 'ok' : 'err'); // the buttons are in the header, so report in a toast that shows on any tab
}
document.querySelectorAll('[data-app]').forEach((b) => b.addEventListener('click', () => launchApp(b.dataset.app)));

function renderApps(status) {
  const rows = $('appsRows');
  rows.replaceChildren();
  Object.entries(status).forEach(([key, a]) => {
    const row = document.createElement('div');
    row.className = 'approw';
    const name = document.createElement('b');
    name.textContent = a.label;
    const p = document.createElement('div');
    p.className = 'apath';
    p.textContent = a.path ? `${a.path}${a.source === 'found' ? '  (found automatically)' : ''}` : 'Not found yet';
    const acts = document.createElement('div');
    acts.className = 'acts';
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'sec';
    choose.textContent = a.path ? 'Change...' : 'Choose...';
    choose.addEventListener('click', async () => {
      const r = await window.api.appsChoose(key);
      if (r.status) renderApps(r.status);
    });
    acts.appendChild(choose);
    if (a.source === 'chosen') {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'sec';
      reset.textContent = 'Use automatic';
      reset.addEventListener('click', async () => {
        const r = await window.api.appsClear(key);
        if (r.status) renderApps(r.status);
      });
      acts.appendChild(reset);
    }
    row.append(name, p, acts);
    rows.appendChild(row);
  });
}
document.querySelectorAll('.js-apps-cfg').forEach((b) => b.addEventListener('click', async () => {
  const r = await window.api.appsStatus();
  if (r.ok) renderApps(r.status);
  $('settingsDlg').showModal();
}));
$('appsClose').addEventListener('click', () => $('settingsDlg').close());
// Click outside the Settings window (on the dimmed backdrop) to close it.
(function () {
  const dlg = $('settingsDlg');
  const outside = (e) => {
    const b = dlg.getBoundingClientRect();
    return e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom;
  };
  let downOutside = false; // a text selection dragged out of the window must not close it
  dlg.addEventListener('mousedown', (e) => { downOutside = outside(e); });
  dlg.addEventListener('click', (e) => { if (downOutside && outside(e)) dlg.close(); downOutside = false; });
})();

// ---------------------------------------------------------------- Settings > Data & Backup
// Back up / Restore / Wipe all go through one small dialog. The password, the decrypted backup and the files stay in
// the main process; this code only sends the password (and the word WIPE) and shows the counts that come back.
(function () {
  const dlg = $('dataDlg');
  const MIN_PW = 8;
  let mode = null;
  let step = 'form'; // restore only: 'form' (pick the file) then 'confirm' (replace?)
  let busy = false;

  const COPY = {
    backup: {
      title: 'Back up everything',
      text: 'Saves your addresses, cards, catch-all domains, accounts, saved groups, Editor files, Recently converted list and Hayha / Polar paths to one file. The file is locked with the password below. There is no way to recover it if you forget the password.',
      pass: 'Backup password', go: 'Choose where to save…',
    },
    restore: {
      title: 'Restore from a backup',
      text: 'Enter the password the backup was made with, then choose the file. You will see what it contains before anything is changed.',
      pass: 'Backup password', go: 'Choose backup file…',
    },
    wipe: {
      title: 'Wipe everything',
      text: 'Permanently erases every address, card, catch-all domain, account, saved group and Editor file, plus the Recently converted list and your Hayha / Polar paths. Files you exported earlier are not touched. This cannot be undone, so make a backup first if you might want any of it back.',
      go: 'Wipe everything',
    },
  };

  const setMsgD = (t, cls) => { const m = $('dataMsg'); m.textContent = t || ''; m.className = 'msg ' + (cls || ''); };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const countsText = (c) => [
    plural(c.addresses, 'address', 'addresses'), plural(c.cards, 'card', 'cards'), plural(c.domains, 'catch-all domain', 'catch-all domains'),
    plural(c.accounts, 'account', 'accounts'), plural(c.groups, 'saved group', 'saved groups'), plural(c.imports, 'Editor file', 'Editor files'),
    plural(c.history, 'recently converted entry', 'recently converted entries'),
  ].join(', ');

  function layout() {
    const c = COPY[mode];
    const confirmStep = mode === 'restore' && step === 'confirm';
    $('dataTitle').textContent = c.title;
    $('dataPassLabel').textContent = c.pass || '';
    $('dataPassWrap').hidden = mode === 'wipe' || confirmStep;
    $('dataPass2Wrap').hidden = mode !== 'backup';
    $('dataConfirmWrap').hidden = mode !== 'wipe';
    $('dataGo').textContent = confirmStep ? 'Replace my data' : c.go;
    $('dataGo').classList.toggle('warnbtn', mode === 'wipe' || confirmStep);
    $('dataGo').hidden = false;
    $('dataCancel').textContent = 'Cancel';
    $('dataGo').disabled = mode === 'wipe' && $('dataConfirm').value !== 'WIPE';
  }

  function open(m) {
    mode = m;
    step = 'form';
    ['dataPass', 'dataPass2', 'dataConfirm'].forEach((id) => { $(id).value = ''; });
    $('dataText').textContent = COPY[m].text;
    setMsgD('');
    layout();
    dlg.showModal();
    ($(m === 'wipe' ? 'dataConfirm' : 'dataPass')).focus();
  }

  // Finished: show the result in place and leave only a Close button.
  function finish(text, cls) {
    ['dataPass', 'dataPass2', 'dataConfirm'].forEach((id) => { $(id).value = ''; });
    $('dataPassWrap').hidden = true;
    $('dataPass2Wrap').hidden = true;
    $('dataConfirmWrap').hidden = true;
    $('dataGo').hidden = true;
    $('dataCancel').textContent = 'Close';
    mode = 'done';
    setMsgD(text, cls);
  }

  // After a restore or wipe the data on screen is stale: reset every tab and reload the Recently converted list.
  function refreshEverything() {
    currentText = null;
    lastPreview = null;
    lastNotes = [];
    $('result').style.display = 'none';
    setMsg('');
    window.Studio.reset();
    window.api.historyGet().then((r) => renderRecent(r.ok ? r.history : []));
  }

  async function go() {
    if (busy || $('dataGo').disabled) return;
    busy = true;
    $('dataGo').disabled = true;
    setMsgD('');
    try {
      if (mode === 'backup') {
        const pw = $('dataPass').value;
        if (pw.length < MIN_PW) { setMsgD(`Choose a password of at least ${MIN_PW} characters.`, 'err'); return; }
        if (pw !== $('dataPass2').value) { setMsgD('The two passwords do not match.', 'err'); return; }
        const r = await window.api.dataBackup(pw);
        if (r.canceled) return;
        if (!r.ok) { setMsgD(r.error, 'err'); return; }
        finish(`Backup saved to ${r.filePath}. It holds ${countsText(r.counts)}. Keep the password somewhere safe: without it the backup cannot be opened.`, 'ok');
      } else if (mode === 'restore' && step === 'form') {
        const pw = $('dataPass').value;
        if (!pw) { setMsgD('Enter the backup password.', 'err'); return; }
        const r = await window.api.dataRestorePrepare(pw);
        if (r.canceled) return;
        if (!r.ok) { setMsgD(r.error, 'err'); return; }
        step = 'confirm';
        $('dataPass').value = '';
        const when = r.exportedAt && !isNaN(new Date(r.exportedAt)) ? ` made ${new Date(r.exportedAt).toLocaleString()}` : '';
        $('dataText').textContent = `This backup${when} contains ${countsText(r.counts)}. Restoring REPLACES everything currently in the app with it. A safety copy of your current vault is kept on this computer.`;
        layout();
      } else if (mode === 'restore') {
        const r = await window.api.dataRestoreApply();
        if (!r.ok) { setMsgD(r.error, 'err'); return; }
        refreshEverything();
        finish(`Restored ${countsText(r.counts)}.`, 'ok');
      } else if (mode === 'wipe') {
        const r = await window.api.dataWipe($('dataConfirm').value);
        if (!r.ok) { setMsgD(r.error, 'err'); return; }
        refreshEverything();
        finish('Everything was erased. The app is back to a fresh start.', 'ok');
      }
    } finally {
      busy = false;
      if (mode && mode !== 'done') layout();
    }
  }

  document.querySelectorAll('[data-data]').forEach((b) => b.addEventListener('click', () => open(b.dataset.data)));
  $('dataGo').addEventListener('click', go);
  $('dataCancel').addEventListener('click', () => dlg.close());
  $('dataConfirm').addEventListener('input', layout);
  [$('dataPass'), $('dataPass2'), $('dataConfirm')].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }));
  dlg.addEventListener('close', () => {
    // leaving a restore after the file was read: drop the decrypted copy held by the main process
    if (mode === 'restore' && step === 'confirm') window.api.dataRestoreCancel();
    ['dataPass', 'dataPass2', 'dataConfirm'].forEach((id) => { $(id).value = ''; });
    mode = null;
  });
})();
