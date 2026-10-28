'use strict';
// Profiles page: Vault tab (addresses + cards) and Builder tab.
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.api;

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v);
      }
    }
    kids.flat(Infinity).forEach((c) => {
      if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return n;
  }

  // Drag-and-drop ordering for a list of <li data-id>. The row follows the pointer; the new order is saved on drop.
  function makeSortable(ul, kind) {
    let dragging = null;
    let before = '';
    ul.querySelectorAll('li[data-id]').forEach((li) => {
      li.draggable = true;
      li.addEventListener('dragstart', (e) => {
        dragging = li;
        before = [...ul.querySelectorAll('li[data-id]')].map((x) => x.dataset.id).join();
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', li.dataset.id);
      });
      li.addEventListener('dragend', async () => {
        li.classList.remove('dragging');
        dragging = null;
        const ids = [...ul.querySelectorAll('li[data-id]')].map((x) => x.dataset.id);
        if (ids.join() === before) return;
        const r = await api.vaultReorder(kind, ids);
        if (r.snapshot) applySnapshot(r.snapshot);
      });
    });
    ul.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const others = [...ul.querySelectorAll('li[data-id]')].filter((x) => x !== dragging);
      const next = others.find((x) => { const b = x.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
      if (next) ul.insertBefore(dragging, next);
      else if (others.length) others[others.length - 1].after(dragging);
    });
    ul.addEventListener('drop', (e) => { if (dragging) e.preventDefault(); });
  }

  function setMsg(id, text, cls) {
    const m = $(id);
    m.textContent = text || '';
    m.className = 'msg ' + (cls || '');
  }

  // ------------------------------------------------------------------ navigation
  const sx = (kind, raw) => Privacy.sx(kind, raw); // a value that Streamer Mode may blur or mask

  // Main views, switched from the icon dock on the left: Vault, Builder, Editor, Converter
  const TABS = { vault: 'tabVault', builder: 'tabBuilder', editor: 'tabEditor', converter: 'tabConverter' };
  const TITLES = { vault: 'Vault', builder: 'Builder', editor: 'Editor', converter: 'Converter' };
  function showTab(name) {
    document.querySelectorAll('[data-nav]').forEach((b) => {
      const on = b.dataset.nav === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    for (const [key, id] of Object.entries(TABS)) $(id).hidden = key !== name;
    $('sectionTitle').textContent = TITLES[name];
    $('vaultSubnav').hidden = name !== 'vault'; // the category pills only belong to the Vault view
    if (name !== 'converter') refresh();
  }

  document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.nav)));

  // Vault categories: one at a time, so the Vault never needs a long scrolling page.
  const VAULT_PANELS = { addresses: 'vpAddresses', cards: 'vpCards', domains: 'vpDomains', logins: 'vpLogins', jigs: 'vpJigs' };
  function showVaultTab(name) {
    document.querySelectorAll('[data-vtab]').forEach((b) => b.classList.toggle('active', b.dataset.vtab === name));
    for (const [key, id] of Object.entries(VAULT_PANELS)) $(id).hidden = key !== name;
  }
  document.querySelectorAll('[data-vtab]').forEach((b) => b.addEventListener('click', () => showVaultTab(b.dataset.vtab)));

  // ------------------------------------------------------------------ state
  let snap = { addresses: [], cards: [], groups: [], accounts: [], domains: [], imports: [], usedJigs: [], encrypted: true, loadError: null };
  let openGroup = null;
  const picked = new Set();
  const pickedAcct = new Set();
  let renamingGroup = null;
  let acctSort = 'date';
  try { if (localStorage.getItem('aioStudio.acctSort') === 'alpha') acctSort = 'alpha'; } catch (e) { /* default */ }
  const nameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  // Accounts as [{ label (day header or null), items }]: by date added (a header per day) or one A-Z list.
  function acctGroups(list) {
    if (acctSort === 'alpha') return [{ label: null, items: list.slice().sort((x, y) => nameCollator.compare(x.email, y.email)) }];
    return groupByDay(list, (a) => a.createdAt);
  }
  const RETAILER_LABEL = { target: 'Target', walmart: 'Walmart', pokemoncenter: 'Pokémon Center', other: 'Other' };
  const RETAILER_ORDER = ['target', 'walmart', 'other', 'pokemoncenter'];

  function applySnapshot(s) {
    snap = s;
    const ids = new Set(s.cards.map((c) => c.id));
    for (const id of [...picked]) if (!ids.has(id)) picked.delete(id);
    s.cards.forEach((c) => { if (c.used) picked.delete(c.id); });
    (s.accounts || []).forEach((a) => { if (a.used) pickedAcct.delete(a.id); }); // in-use accounts are not offered to the Builder
    const aids = new Set((s.accounts || []).map((a) => a.id));
    for (const id of [...pickedAcct]) if (!aids.has(id)) pickedAcct.delete(id);
    renderVault();
    renderDomains();
    renderAccounts();
    renderJigs();
    renderBuilderPickers();
    renderGroups();
    renderEditor();
    syncDeleteAll();
  }

  async function refresh() {
    const r = await api.vaultGet();
    if (r.ok) applySnapshot(r.snapshot);
  }

  // ------------------------------------------------------------------ vault
  // Addresses: street line and ZIP are sensitive; city, state and unit are shown.
  const addressNode = (a) => Privacy.group(sx('line1', a.line1), a.line2 ? `, ${a.line2}` : '', `, ${a.city}, ${a.state.shortCode} `, sx('zip', a.zip));
  // Plain-text version for dropdown options and confirm boxes (those cannot be blurred, so they are masked while Streamer Mode is on).
  const addressString = (a) => `${Privacy.text('line1', a.line1)}${a.line2 ? ', ' + Privacy.text('unit', a.line2) : ''}, ${a.city}, ${a.state.shortCode} ${Privacy.text('zip', a.zip)}`;
  // Cards: nickname, cardholder, last 4 and expiry are sensitive; the brand is shown.
  const cardMaskNode = (c) => [`${c.brand} •••• `, sx('last4', c.last4)];
  const cardMaskText = (c) => `${c.brand} •••• ${Privacy.text('last4', c.last4)}`;
  const cardLabelNode = (c) => (c.nickname ? [sx('name', c.nickname), ' (', cardMaskNode(c), ')'] : cardMaskNode(c));
  const cardLabelText = (c) => (c.nickname ? `${Privacy.text('name', c.nickname)} (${cardMaskText(c)})` : cardMaskText(c));
  const cardExpNode = (c) => ['exp ', sx('exp', `${c.expMonth}/${String(c.expYear).slice(-2)}`), c.holder ? [' · ', sx('name', c.holder)] : ''];
  // Cards grouped under one date header per day they were added (newest day first), no date on each card.
  const useFilter = (v) => (x) => v === 'all' || (v === 'used' ? !!x.used : !x.used); // 'free' (default), 'used' or 'all'
  function eachCardByDay(fn) {
    groupByDay(snap.cards.filter(useFilter($('cardFilter').value)), (c) => c.createdAt).forEach((day) => fn(day.label, day.items));
  }
  function usedTitle(c) {
    if (!c.used || !c.usedIn) return '';
    const d = c.usedIn.date ? new Date(c.usedIn.date).toLocaleDateString() : '';
    return `Used in ${c.usedIn.batch || 'a batch'}${c.usedIn.site ? ' (' + c.usedIn.site + ')' : ''} ${d}`.trim();
  }

  function renderVault() {
    $('vaultSec').textContent = (snap.encrypted
      ? '🔒 The vault is encrypted with your Windows login. Full card numbers never appear on screen.'
      : 'Encryption is not available on this system, so the vault is stored unencrypted on disk.')
      + (snap.loadError ? ' ' + snap.loadError : '');

    const al = $('addrList');
    al.replaceChildren();
    snap.addresses.forEach((a) => {
      al.append(el('li', { 'data-id': a.id, class: 'sortable', title: 'Drag to reorder' },
        el('div', { class: 'main' }, addressNode(a)),
        el('div', { class: 'acts' },
          el('button', { class: 'sec', type: 'button', text: 'Edit', onclick: () => startEdit(a) }),
          el('button', {
            class: 'sec danger', type: 'button', text: 'Delete',
            onclick: async () => {
              if (!(await askConfirm('Delete this address?'))) return;
              if (editingId === a.id) stopEdit();
              handleVault(await api.vaultDeleteAddress(a.id), 'vMsg');
            },
          }))));
    });
    makeSortable(al, 'addresses');
    if (!snap.addresses.length) al.append(el('li', null, el('div', { class: 'main meta', text: 'No addresses yet.' })));

    const free = snap.cards.filter((c) => !c.used).length;
    $('addrCount').textContent = snap.addresses.length ? `(${snap.addresses.length})` : '';
    $('cardCount').textContent = snap.cards.length ? `(${snap.cards.filter(useFilter($('cardFilter').value)).length})` : '';
    const cl = $('cardList');
    cl.replaceChildren();
    eachCardByDay((label, cards) => {
      cl.append(el('li', { class: 'datehead', text: label }));
      cards.forEach((c) => cl.append(vaultCardRow(c)));
    });
    if (!snap.cards.length) cl.append(el('li', null, el('div', { class: 'main meta', text: 'No cards yet.' })));
    else if (!cl.children.length) cl.append(el('li', null, el('div', { class: 'main meta', text: $('cardFilter').value === 'used' ? 'No cards in use.' : 'No available cards. Change the filter to see the rest.' })));
  }

  function vaultCardRow(c) {
    return (
      el('li', null,
        el('div', { class: 'main' },
          el('b', null, c.nickname ? sx('name', c.nickname) : cardMaskNode(c)),
          el('div', { class: 'meta' }, c.nickname ? [cardMaskNode(c), ' · '] : '', cardExpNode(c))),
        el('div', { class: 'acts' },
          (() => {
            const now = c.used ? 'In use' : 'Available';
            const next = c.used ? 'Mark available' : 'Mark in use';
            const b = el('button', {
              class: 'pill pillbtn ' + (c.used ? 'used' : 'free'), type: 'button',
              title: `${usedTitle(c) ? usedTitle(c) + '. ' : ''}Click to ${next.toLowerCase()}`,
              onclick: async () => handleVault(await api.vaultSetUsed(c.id, !c.used), 'vMsg'),
            }, el('span', { class: 'now', text: now }), el('span', { class: 'next', text: next }));
            return b;
          })(),
          el('button', {
            class: 'sec danger', type: 'button', text: 'Delete',
            onclick: async () => {
              if (!(await askConfirm(`Delete ${cardLabelText(c)}?`))) return;
              handleVault(await api.vaultDeleteCard(c.id), 'vMsg');
            },
          }))));
  }

  function renderDomains() {
    const l = $('domList');
    $('domCount').textContent = snap.domains.length ? `(${snap.domains.length})` : '';
    l.replaceChildren();
    snap.domains.forEach((d) => l.append(el('li', { 'data-id': d.id, class: 'sortable', title: 'Drag to reorder' },
      el('div', { class: 'main' }, sx('domain', d.domain)),
      el('div', { class: 'acts' }, el('button', {
        class: 'sec danger', type: 'button', text: 'Delete',
        onclick: async () => {
          if (!(await askConfirm(`Delete ${Privacy.text('domain', d.domain)}?`))) return;
          handleVault(await api.vaultDeleteDomain(d.id), 'vMsg');
        },
      })))));
    makeSortable(l, 'domains');
    if (!snap.domains.length) l.append(el('li', null, el('div', { class: 'main meta', text: 'No domains yet.' })));
  }

  // Accounts grouped under a date header per day they were added.
  function renderAccounts() {
    const l = $('acctList');
    $('acctCount').textContent = snap.accounts.length ? `(${snap.accounts.filter(useFilter($('acctFilter').value)).length})` : '';
    l.replaceChildren();
    // one section per retailer (Target, Walmart, Other, then any retailer saved earlier), each grouped by day added
    const retailers = [...new Set(snap.accounts.map((a) => a.retailer))]
      .sort((x, y) => (RETAILER_ORDER.indexOf(x) + 1 || 99) - (RETAILER_ORDER.indexOf(y) + 1 || 99));
    retailers.forEach((r) => {
      const mine = snap.accounts.filter((a) => a.retailer === r && useFilter($('acctFilter').value)(a));
      if (!mine.length) return;
      l.append(el('li', { class: 'rethead' }, RETAILER_LABEL[r] || r));
      acctGroups(mine).forEach((day) => {
        if (day.label) l.append(el('li', { class: 'datehead', text: day.label }));
        day.items.forEach((a) => l.append(el('li', null,
          el('div', { class: 'main' }, el('b', null, sx('email', a.email))),
          el('div', { class: 'acts' },
            (() => {
              const next = a.used ? 'Mark available' : 'Mark in use';
              return el('button', {
                class: 'pill pillbtn ' + (a.used ? 'used' : 'free'), type: 'button',
                title: `${usedTitle(a) ? usedTitle(a) + '. ' : ''}Click to ${next.toLowerCase()}`,
                onclick: async () => handleVault(await api.vaultSetAccountUsed(a.id, !a.used), 'vMsg'),
              }, el('span', { class: 'now', text: a.used ? 'In use' : 'Available' }), el('span', { class: 'next', text: next }));
            })(),
            el('button', {
              class: 'sec danger', type: 'button', text: 'Delete',
              onclick: async () => {
                if (!(await askConfirm(`Delete ${Privacy.text('email', a.email)}?`))) return;
                handleVault(await api.vaultDeleteAccount(a.id), 'vMsg');
              },
            })))));
      });
    });
    if (!snap.accounts.length) l.append(el('li', null, el('div', { class: 'main meta', text: 'No accounts yet.' })));
    else if (!l.children.length) l.append(el('li', null, el('div', { class: 'main meta', text: $('acctFilter').value === 'used' ? 'No accounts in use.' : 'No available accounts. Change the filter to see the rest.' })));
  }

  // Used jigs: address variations that were exported before (the Builder skips them). Re-add = let the Builder use one again.
  const JIG_FORMAT = { hayha: 'Hayha', polar: 'Polar', csv: 'CSV' };
  const JIG_SOURCE = { import: 'Imported', editor: 'Editor export' };
  function renderJigs() {
    const l = $('jigList');
    l.replaceChildren();
    const q = $('jigSearch').value.trim().toLowerCase();
    const all = snap.usedJigs || [];
    const shown = all.filter((j) => !q || `${j.line1} ${j.city} ${j.state} ${j.zip} ${j.batch} ${j.site}`.toLowerCase().includes(q));
    $('jigCount').textContent = all.length ? (q ? `(${shown.length} of ${all.length})` : `(${all.length})`) : '';
    $('jigReaddAll').disabled = !all.length;
    // Numerical (default): one list ordered by house number, then street, then unit. By retailer: a section per retailer,
    // each in the same numerical order. Date added: grouped by day.
    const byNum = (a, b) => nameCollator.compare(a.line1 || '', b.line1 || '') || nameCollator.compare(String(a.zip || ''), String(b.zip || ''));
    const sortMode = $('jigSort').value;
    let groups;
    if (sortMode === 'date') groups = groupByDay(shown, (j) => j.date);
    else if (sortMode === 'site') {
      const sites = [...new Set(shown.map((j) => j.site || ''))];
      const rank = (s) => (s === '' ? 999 : (RETAILER_ORDER.indexOf(s) + 1 || 99));
      sites.sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
      groups = sites.map((s) => {
        const items = shown.filter((j) => (j.site || '') === s).sort(byNum);
        return { label: `${s ? (RETAILER_LABEL[s] || s) : 'Any retailer'} (${items.length})`, items, head: 'rethead' };
      });
    } else if (sortMode === 'dup') {
      // Addresses used on more than one retailer: one section per address, a row for each retailer it was used on.
      const rank = (s) => (s === '' ? 999 : (RETAILER_ORDER.indexOf(s) + 1 || 99));
      const byKey = new Map();
      shown.forEach((j) => { if (!byKey.has(j.key)) byKey.set(j.key, []); byKey.get(j.key).push(j); });
      groups = [...byKey.values()]
        .filter((items) => new Set(items.map((j) => j.site || '')).size > 1)
        .sort((a, b) => byNum(a[0], b[0]))
        .map((items) => {
          const sorted = items.slice().sort((a, b) => rank(a.site || '') - rank(b.site || ''));
          const names = [...new Set(sorted.map((j) => (j.site ? (RETAILER_LABEL[j.site] || j.site) : 'Any retailer')))];
          return { label: `${items[0].line1} · used on ${names.join(' + ')}`, items: sorted, head: 'rethead', priv: true };
        });
      $('jigCount').textContent = `(${groups.length} duplicate${groups.length === 1 ? '' : 's'})`;
    } else groups = [{ label: null, items: shown.slice().sort(byNum) }];
    groups.forEach((day) => {
      if (day.label) l.append(el('li', { class: day.head || 'datehead' }, day.priv ? sx('line1', day.label) : day.label));
      day.items.forEach((j) => l.append(el('li', null,
        el('div', { class: 'main' },
          el('b', null, Privacy.group(sx('line1', j.line1), `, ${j.city}, ${j.state} `, sx('zip', j.zip))),
          el('div', { class: 'meta', text: `${j.batch || 'Batch'}${j.source ? ' · ' + (JIG_SOURCE[j.source] || j.source) : ''}${' · ' + (j.site ? (RETAILER_LABEL[j.site] || j.site) : 'Any retailer')}${j.format ? ' · ' + (JIG_FORMAT[j.format] || j.format) : ''}` })),
        el('div', { class: 'acts' }, el('button', {
          class: 'sec', type: 'button', text: 'Re-add', title: 'Let the Builder generate this address again',
          onclick: async () => handleVault(await api.vaultRemoveJig(j.id), 'vMsg', 'Re-added. The Builder can use that address again.'),
        })))));
    });
    if (!all.length) l.append(el('li', null, el('div', { class: 'main meta', text: 'No used jigs yet. Addresses are added here when you export a batch from the Builder.' })));
    else if (!shown.length) l.append(el('li', null, el('div', { class: 'main meta', text: 'Nothing matches that search.' })));
    else if ($('jigSort').value === 'dup' && !l.children.length) l.append(el('li', null, el('div', { class: 'main meta', text: 'No address has been used on more than one retailer.' })));
  }
  $('jigSearch').addEventListener('input', renderJigs);
  $('jigSort').addEventListener('change', renderJigs);
  $('jigReaddAll').addEventListener('click', async () => {
    const n = (snap.usedJigs || []).length;
    if (!n) return;
    if (!(await askConfirm(`Re-add all ${n} used jig${n === 1 ? '' : 's'}? The Builder will be able to generate those addresses again.`, 'Re-add all'))) return;
    handleVault(await api.vaultClearJigs(), 'vMsg', `Re-added ${n} jig${n === 1 ? '' : 's'}.`);
  });

  function handleVault(r, msgId, okText) {
    if (r.snapshot) applySnapshot(r.snapshot);
    if (!r.ok) { setMsg(msgId, r.error, 'err'); return false; }
    setMsg(msgId, okText || '', 'ok');
    return true;
  }

  // Add / edit address. Edit mode loads an address into the form on the right; Save keeps the same address entry.
  let editingId = null;
  const ADDR_FIELDS = ['vLine1', 'vLine2', 'vCity', 'vZip'];
  function stopEdit() {
    editingId = null;
    ADDR_FIELDS.forEach((id) => { $(id).value = ''; });
    $('vState').value = '';
    $('addrFormTitle').textContent = 'Add address';
    $('vAddAddr').textContent = 'Add address';
    $('vCancelEdit').hidden = true;
  }
  function startEdit(a) {
    editingId = a.id;
    $('vLine1').value = a.line1;
    $('vLine2').value = a.line2;
    $('vCity').value = a.city;
    $('vState').value = a.state.shortCode;
    $('vZip').value = a.zip;
    $('addrFormTitle').textContent = 'Edit address';
    $('vAddAddr').textContent = 'Save changes';
    $('vCancelEdit').hidden = false;
    setMsg('vMsg', '');
    $('vLine1').focus();
    $('vLine1').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  $('vCancelEdit').addEventListener('click', stopEdit);

  $('vAddAddr').addEventListener('click', async () => {
    const input = {
      line1: $('vLine1').value, line2: $('vLine2').value, city: $('vCity').value,
      state: $('vState').value, zip: $('vZip').value,
    };
    const r = editingId ? await api.vaultUpdateAddress(editingId, input) : await api.vaultAddAddress(input);
    if (handleVault(r, 'vMsg', editingId ? 'Address updated.' : 'Address added.')) stopEdit();
  });

  $('vAddDomain').addEventListener('click', async () => {
    if (handleVault(await api.vaultAddDomain($('dDomain').value), 'vMsg', 'Domain added.')) $('dDomain').value = '';
  });

  $('vAddAcct').addEventListener('click', async () => {
    const r = await api.vaultAddAccount({ retailer: $('aRetailer').value, email: $('aEmail').value, password: $('aPass').value });
    if (handleVault(r, 'vMsg', 'Account added.')) ['aEmail', 'aPass'].forEach((id) => { $(id).value = ''; });
  });

  $('vBulkAcct').addEventListener('click', async () => {
    const r = await api.vaultBulkAccounts($('aBulk').value, { retailer: $('aRetailer').value });
    if (r.snapshot) applySnapshot(r.snapshot);
    if (!r.ok) { setMsg('vMsg', r.error, 'err'); return; }
    const bad = r.skipped.length;
    setMsg('vMsg', `Imported ${r.added} account${r.added === 1 ? '' : 's'}${bad ? `, skipped ${bad}: ` + r.skipped.slice(0, 3).map((x) => `line ${x.line} (${x.reason})`).join('; ') + (bad > 3 ? '…' : '') : '.'}`, bad ? 'err' : 'ok');
    if (!bad) $('aBulk').value = '';
  });

  $('vAddCard').addEventListener('click', async () => {
    const r = await api.vaultAddCard({
      nickname: $('cNick').value, holder: $('cHolder').value, number: $('cNumber').value,
      expMonth: $('cMM').value, expYear: $('cYY').value, cvv: $('cCvv').value,
    }, { lenient: $('cLenient').checked });
    if (handleVault(r, 'vMsg', 'Card added.')) ['cNick', 'cNumber', 'cMM', 'cYY', 'cCvv'].forEach((id) => { $(id).value = ''; });
  });

  $('vBulk').addEventListener('click', async () => {
    const r = await api.vaultBulkCards($('cBulk').value, { holder: $('cBulkHolder').value, nickname: $('cBulkNick').value, lenient: $('cLenient').checked });
    if (r.snapshot) applySnapshot(r.snapshot);
    if (!r.ok) { setMsg('vMsg', r.error, 'err'); return; }
    const bad = r.skipped.length;
    setMsg('vMsg', `Imported ${r.added} card${r.added === 1 ? '' : 's'}${bad ? `, skipped ${bad}: ` + r.skipped.slice(0, 3).map((s) => `line ${s.line} (${s.reason})`).join('; ') + (bad > 3 ? '…' : '') : '.'}`, bad ? 'err' : 'ok');
    if (!bad) $('cBulk').value = '';
  });

  // Export the accounts that match the Available / In use / All filter (and the retailer picked next to the buttons) as a Hayha or Polar accounts file
  async function exportAccounts(format) {
    const r = await api.vaultExportAccounts(format, $('acctExpRetailer').value, $('acctFilter').value);
    if (r.ok) setMsg('vMsg', `Exported ${r.count} account${r.count === 1 ? '' : 's'} to ${r.filePath}.`, 'ok');
    else if (!r.canceled) setMsg('vMsg', r.error, 'err');
  }
  $('acctExpHayha').addEventListener('click', async () => { await exportAccounts('hayha'); $('acctExpDlg').close(); });
  $('acctExpPolar').addEventListener('click', async () => { await exportAccounts('polar'); $('acctExpDlg').close(); });
  $('acctExpClose').addEventListener('click', () => $('acctExpDlg').close());
  $('acctExport').addEventListener('click', () => {
    const f = $('acctFilter').value;
    $('acctExpNote').textContent = `Exports the ${f === 'free' ? 'available' : f === 'used' ? 'in-use' : ''} accounts${f === 'all' ? ' (every account)' : ''} for the retailer you pick. Change the filter above to export a different set.`.replace('  ', ' ');
    $('acctExpDlg').showModal();
  });
  // Sort and Delete all live behind one "..." button to keep the header clean.
  $('acctMore').addEventListener('click', () => {
    const r = $('acctMore').getBoundingClientRect();
    const setSort = (v) => () => {
      acctSort = v;
      try { localStorage.setItem('aioStudio.acctSort', acctSort); } catch (e) { /* ignore */ }
      renderAccounts();
      renderBuilderPickers();
    };
    showMenu(r.right - 190, r.bottom + 4, [
      { label: `${acctSort === 'date' ? '✓ ' : '    '}Sort by date added`, run: setSort('date') },
      { label: `${acctSort === 'alpha' ? '✓ ' : '    '}Sort A–Z`, run: setSort('alpha') },
      snap.accounts.length && { label: 'Delete all accounts', danger: true, run: () => deleteAll('accounts', 'accounts', snap.accounts.length) },
    ]);
  });

  $('cardFilter').addEventListener('change', () => renderVault());
  $('acctFilter').addEventListener('change', () => renderAccounts());

  // Delete all, one button per Vault section (with a confirmation)
  async function deleteAll(kind, noun, count) {
    if (!count) return;
    if (!(await askConfirm(`Delete all ${count} ${noun} from the Vault? This cannot be undone.`))) return;
    if (kind === 'addresses') stopEdit();
    handleVault(await api.vaultDeleteAll(kind), 'vMsg', `Deleted all ${noun}.`);
  }
  $('delAllAddr').addEventListener('click', () => deleteAll('addresses', 'addresses', snap.addresses.length));
  $('delAllCards').addEventListener('click', () => deleteAll('cards', 'cards', snap.cards.length));
  $('delAllDom').addEventListener('click', () => deleteAll('domains', 'catch-all domains', snap.domains.length));
  function syncDeleteAll() {
    $('delAllAddr').disabled = !snap.addresses.length;
    $('delAllCards').disabled = !snap.cards.length;
    $('delAllDom').disabled = !snap.domains.length;
    $('acctExport').disabled = !snap.accounts.length;
  }

  // ------------------------------------------------------------------ builder
  const HINTS = {
    target: 'Everything goes at the end of line 1 and line 2 stays empty. The house number and street name are never changed. If your address has a unit, it is kept and shown with different designators (APT, STE, Door, Floor...), street type spellings (St, St., Street...) and leading zeros (7H, 07H). If it has no unit, each profile gets a made-up one such as "APT 8B".',
  };
  HINTS.walmart = HINTS.target;
  HINTS.pokemoncenter = HINTS.target;
  HINTS.other = HINTS.target;
  HINTS[''] = HINTS.target; // no retailer picked yet
  const CAVEAT = ' Every address in a batch is unique. These tricks are not guaranteed to work and retailers change their checks, so test a small batch first.';

  const NEW_DOMAIN = '__new__';
  function currentDomain() {
    const v = $('bDomainSel').value;
    return v === NEW_DOMAIN ? $('bDomain').value : v;
  }

  function syncForm() {
    $('bFirstWrap').hidden = $('bFirstMode').value !== 'custom';
    $('bLastWrap').hidden = $('bLastMode').value !== 'same';
    const style = $('bEmailStyle').value;
    const seq = style === 'sequence';
    const acct = style === 'accounts';
    $('bEmailPrefixWrap').hidden = !seq;
    $('bEmailStartWrap').hidden = !seq;
    $('bDomainWrap').hidden = acct;
    const isNew = !acct && $('bDomainSel').value === NEW_DOMAIN;
    $('bDomainNewWrap').hidden = !isNew;
    $('bDomainSaveWrap').hidden = !isNew;
    $('bAcctBox').hidden = !acct;
    updateEmailHint();
    updateAcctSummary();
    const site = $('bSite').value;
    $('bHint').textContent = HINTS[site] + CAVEAT;
    const pm = $('bPhoneMode').value;
    $('bAreaWrap').hidden = pm !== 'area';
    $('bPhoneWrap').hidden = pm !== 'same';
  }

  function updateEmailHint() {
    const h = $('bEmailHint');
    const style = $('bEmailStyle').value;
    h.hidden = style !== 'sequence' && style !== 'accounts';
    if (h.hidden) return;
    if (style === 'accounts') {
      h.textContent = 'Each profile uses the email of one account you saved in the Vault (for the site you picked), in order, so profiles match accounts you already have. Select the accounts below (accounts already used on an earlier batch are hidden). You need at least as many as Profiles to generate.';
      return;
    }
    const prefix = $('bEmailPrefix').value.trim().replace(/@.*$/, '');
    const domain = currentDomain().trim().replace(/^@+/, '');
    const start = $('bEmailStart').value === '' ? 1 : Number($('bEmailStart').value);
    const n = Number($('bCount').value) || 0;
    const explain = 'Use this when your accounts already exist with numbered emails (like abc1@domain, abc2@domain...). Each profile gets the next number in order, so its email matches an account. Enter the part before the number, the number to start at, and your catch-all domain. The Profiles to generate count decides where it stops.';
    const mail = (i) => Privacy.text('email', `${prefix}${i}@${domain}`);
    const preview = prefix && domain && domain !== NEW_DOMAIN && n && Number.isInteger(start)
      ? `Right now: ${mail(start)} through ${mail(start + n - 1)}.`
      : 'Fill in the prefix, domain and number of profiles to see the exact range.';
    h.replaceChildren(explain, document.createElement('br'), Object.assign(document.createElement('b'), { textContent: preview }));
  }

  function updateAcctSummary() {
    const need = Number($('bCount').value) || 0;
    const s = $('bAcctSummary');
    s.textContent = `${pickedAcct.size} selected, ${need} needed`;
    s.style.color = pickedAcct.size < need ? 'var(--warn)' : '';
  }

  ['bSite', 'bFirstMode', 'bLastMode', 'bPhoneMode', 'bEmailStyle', 'bDomainSel'].forEach((id) => $(id).addEventListener('change', syncForm));
  $('bSite').addEventListener('change', () => {
    for (const id of [...pickedAcct]) {
      const a = snap.accounts.find((x) => x.id === id);
      if (!a || a.retailer !== $('bSite').value) pickedAcct.delete(id);
    }
    renderBuilderPickers();
  });
  ['bEmailPrefix', 'bEmailStart', 'bDomain', 'bCount'].forEach((id) => $(id).addEventListener('input', () => { updateEmailHint(); updateAcctSummary(); }));
  $('bAcctAll').addEventListener('click', () => {
    snap.accounts.filter((a) => a.retailer === $('bSite').value && !a.used).forEach((a) => pickedAcct.add(a.id));
    renderBuilderPickers();
  });
  $('bAcctNone').addEventListener('click', () => { pickedAcct.clear(); renderBuilderPickers(); });

  function renderBuilderPickers() {
    const ds = $('bDomainSel');
    const prevDomain = ds.value;
    ds.replaceChildren();
    ds.append(el('option', { value: '', text: 'Select catchall domain' }));
    ds.append(el('option', { value: NEW_DOMAIN, text: 'Enter a new domain...' })); // top of the list, above the saved domains
    snap.domains.forEach((d) => ds.append(el('option', { value: d.domain, text: Privacy.text('domain', d.domain) })));
    // keep what was picked (a saved domain, or "new domain" while typing); otherwise go back to the placeholder
    ds.value = prevDomain === NEW_DOMAIN || snap.domains.some((d) => d.domain === prevDomain) ? prevDomain : '';

    const site = $('bSite').value;
    const al = $('bAcctList');
    al.replaceChildren();
    const ofSite = snap.accounts.filter((a) => a.retailer === site);
    const mine = ofSite.filter((a) => !a.used); // accounts already used on a built batch are not offered again
    acctGroups(mine).forEach((day) => {
      if (day.label) al.append(el('li', { class: 'datehead', text: day.label }));
      day.items.forEach((a) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = pickedAcct.has(a.id);
        cb.addEventListener('change', () => { if (cb.checked) pickedAcct.add(a.id); else pickedAcct.delete(a.id); updateAcctSummary(); });
        const row = el('li', { class: 'pickrow' + (cb.checked ? ' on' : '') }, cb, el('div', { class: 'main' }, el('b', null, sx('email', a.email))));
        cb.addEventListener('change', () => row.classList.toggle('on', cb.checked));
        row.addEventListener('click', (e) => { if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); } }); // the whole row toggles
        al.append(row);
      });
    });
    if (!site) al.append(el('li', null, el('div', { class: 'main meta', text: 'Select a retailer above to see its accounts.' })));
    else if (!ofSite.length) al.append(el('li', null, el('div', { class: 'main meta', text: `No ${RETAILER_LABEL[site] || ''} accounts in the vault yet. Add them in the Vault tab.` })));
    else if (!mine.length) al.append(el('li', null, el('div', { class: 'main meta', text: `Every ${RETAILER_LABEL[site] || ''} account is marked in use. Add more in the Vault tab, or mark some available again.` })));
    syncForm();

    const sel = $('bAddress');
    const prev = sel.value;
    sel.replaceChildren();
    sel.append(el('option', { value: '', text: snap.addresses.length ? 'Select an address' : 'No addresses in the vault yet' }));
    snap.addresses.forEach((a) => sel.append(el('option', { value: a.id, text: addressString(a) })));
    if (snap.addresses.some((a) => a.id === prev)) sel.value = prev;

    // "Available Cards": cards marked in use are not offered here (they still show in the Vault tab)
    const list = $('bCardList');
    list.replaceChildren();
    const availableCards = snap.cards.filter((c) => !c.used);
    groupByDay(availableCards, (c) => c.createdAt).forEach((day) => {
      list.append(el('li', { class: 'datehead', text: day.label }));
      day.items.forEach((c) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = picked.has(c.id);
        cb.addEventListener('change', () => { if (cb.checked) picked.add(c.id); else picked.delete(c.id); updatePickSummary(); });
        const row = el('li', { class: 'pickrow' + (cb.checked ? ' on' : '') },
          cb,
          el('div', { class: 'main' },
            el('b', null, cardLabelNode(c)),
            el('span', { class: 'meta' }, '  ', cardExpNode(c))));
        cb.addEventListener('change', () => row.classList.toggle('on', cb.checked));
        row.addEventListener('click', (e) => { if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); } }); // the whole row toggles
        list.append(row);
      });
    });
    if (!snap.cards.length) list.append(el('li', null, el('div', { class: 'main meta', text: 'Add cards in the Vault tab first.' })));
    else if (!availableCards.length) list.append(el('li', null, el('div', { class: 'main meta', text: 'Every card is marked in use. Add more cards in the Vault tab.' })));
    updatePickSummary();
  }

  function updatePickSummary() {
    const need = Number($('bCount').value) || 0;
    const have = picked.size;
    const s = $('bPickSummary');
    s.textContent = `${have} selected, ${need} needed`;
    s.style.color = have < need ? 'var(--warn)' : '';
  }
  $('bCount').addEventListener('input', updatePickSummary);
  $('bPickAvail').addEventListener('click', () => {
    picked.clear();
    snap.cards.filter((c) => !c.used).forEach((c) => picked.add(c.id)); // every card in the list
    renderBuilderPickers();
  });
  $('bPickNone').addEventListener('click', () => { picked.clear(); renderBuilderPickers(); });

  function collectOpts() {
    return {
      site: $('bSite').value,
      addressId: $('bAddress').value,
      count: Number($('bCount').value),
      firstMode: $('bFirstMode').value,
      firstName: $('bFirst').value,
      lastMode: $('bLastMode').value,
      lastName: $('bLast').value,
      domain: currentDomain(),
      accountIds: [...pickedAcct],
      emailStyle: $('bEmailStyle').value,
      emailPrefix: $('bEmailPrefix').value,
      emailStart: $('bEmailStart').value,
      phoneMode: $('bPhoneMode').value,
      areaCode: $('bArea').value,
      phone: $('bPhone').value,
      prefix: $('bPrefix').value,
      groupName: $('bGroup').value,
      cardIds: [...picked],
      markUsed: $('bMark').checked,
      jigName: $('bNameJig').checked,
    };
  }

  // Fill a table cell from a string, a node, or an array of both.
  const fillCell = (td, v) => { [].concat(v).forEach((x) => td.append(x)); };

  let lastRows = null; // kept so the table can be redrawn when Streamer Mode changes
  let lastWarn = [];
  function renderPreview(rows) {
    lastRows = rows;
    const t = $('bTable');
    t.replaceChildren();
    const head = t.createTHead().insertRow();
    ['#', 'Profile', 'Name', 'Email', 'Phone', 'Address', 'Card'].forEach((h) => head.append(el('th', { text: h })));
    const body = t.createTBody();
    rows.forEach((r) => {
      const tr = body.insertRow();
      [r.n, r.profile, sx('name', r.name), sx('email', r.email), sx('phone', r.phone), Privacy.addrStr(r.address), Privacy.cardStr(r.card)]
        .forEach((v) => fillCell(tr.insertCell(), v));
    });
  }

  function setNotes(list) {
    lastWarn = list || [];
    const n = $('bNotes');
    n.replaceChildren();
    lastWarn.forEach((w) => n.append(el('li', { text: Privacy.scrub(w) })));
  }

  $('bGenerate').addEventListener('click', async () => {
    const btn = $('bGenerate');
    btn.disabled = true;
    setMsg('bMsg', '');
    try {
      const r = await api.builderGenerate(collectOpts());
      if (!r.ok) {
        $('bResult').hidden = true;
        setMsg('bMsg', (r.errors || [r.error]).join(' '), 'err');
        return;
      }
      $('bCountBadge').textContent = `${r.count} profile${r.count === 1 ? '' : 's'} ready`;
      renderPreview(r.rows);
      setNotes(r.warnings);
      $('bResult').hidden = false;
      if ($('bDomainSel').value === NEW_DOMAIN && $('bDomainSave').checked && $('bEmailStyle').value !== 'accounts') {
        const d = await api.vaultAddDomain($('bDomain').value); // already saved is fine
        if (d.snapshot) {
          const typed = $('bDomain').value.trim().replace(/^@+/, '').toLowerCase();
          applySnapshot(d.snapshot);
          if (d.ok) { $('bDomainSel').value = typed; $('bDomain').value = ''; syncForm(); }
        }
      }
    } finally {
      btn.disabled = false;
    }
  });

  async function exportAs(format) {
    const r = await api.builderExport(format);
    if (r.snapshot) applySnapshot(r.snapshot);
    if (r.ok) {
      const bits = [];
      if (r.saved) bits.push('saved the batch under Saved groups');
      if (r.marked) bits.push(`marked ${r.marked} card${r.marked === 1 ? '' : 's'} as in use`);
      if (r.markedAccounts) bits.push(`marked ${r.markedAccounts} account${r.markedAccounts === 1 ? '' : 's'} as in use`);
      if (r.markedJigs) bits.push(`remembered ${r.markedJigs} address jig${r.markedJigs === 1 ? '' : 's'} as used`);
      setMsg('bMsg', `Saved to ${r.filePath}${bits.length ? ' and ' + bits.join(' and ') : ''}.`, 'ok');
    } else if (!r.canceled) {
      setMsg('bMsg', r.error, 'err');
    }
  }
  $('bExportHayha').addEventListener('click', () => exportAs('hayha'));
  $('bExportPolar').addEventListener('click', () => exportAs('polar'));
  $('bExportCsv').addEventListener('click', () => exportAs('csv'));

  // Send built profiles to the Editor tab (the just-generated batch, or a saved group), then show them there.
  async function sendToEditor(groupId, msgId) {
    const r = await api.builderToEditor(groupId);
    if (r.snapshot) applySnapshot(r.snapshot);
    if (!r.ok) { setMsg(msgId, r.error, 'err'); return; }
    openImport = r.id;
    importFilter.clear();
    showTab('editor');
    renderEditor();
    setMsg('edMsg', `${r.existing ? 'Showing' : 'Opened'} ${r.count} built profile${r.count === 1 ? '' : 's'} in Built files below.`, 'ok');
    const row = document.querySelector('#edBuiltList .group-row.open');
    if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  $('bToEditor').addEventListener('click', () => sendToEditor(undefined, 'bMsg'));

  // ------------------------------------------------------------------ saved groups
  const SITE_LABEL = { target: 'Target', walmart: 'Walmart', pokemoncenter: 'Pokémon Center', other: 'Other' };
  const FORMAT_LABEL = { hayha: 'Hayha', polar: 'Polar' };

  function renderGroups() {
    const list = $('groupList');
    list.replaceChildren();
    $('groupCount').textContent = snap.groups.length ? `(${snap.groups.length})` : '';
    if (!snap.groups.length) {
      list.append(el('p', { class: 'hint', text: 'No groups yet. A group is saved when you export a batch for Hayha or Polar.' }));
      return;
    }
    groupByDay(snap.groups, (g) => g.createdAt).forEach((day) => {
      list.append(el('div', { class: 'group-date', text: day.label }));
      day.items.forEach((g) => renderGroupRow(list, g));
    });
    const edit = list.querySelector('.gedit');
    if (edit) { edit.focus(); edit.select(); }
  }

  async function saveGroupName(id, name) {
    renamingGroup = null;
    const r = await api.vaultRenameGroup(id, name);
    if (r.snapshot) applySnapshot(r.snapshot);
    if (!r.ok) { setMsg('bMsg', r.error, 'err'); renderGroups(); return; }
    setMsg('bMsg', 'Group renamed.', 'ok');
  }

  function renderGroupRow(list, g) {
    {
      const open = openGroup === g.id;
      list.append(el('div', {
        class: 'group-row' + (open ? ' open' : ''),
        onclick: () => { openGroup = open ? null : g.id; renderGroups(); },
      },
      el('span', { class: 'chev', text: open ? '▾' : '▸' }),
      renamingGroup === g.id
        ? el('input', {
          class: 'gedit', value: g.name, maxlength: '60', 'aria-label': 'Group name',
          onclick: (e) => e.stopPropagation(),
          onkeydown: (e) => {
            if (e.key === 'Enter') saveGroupName(g.id, e.target.value);
            else if (e.key === 'Escape') { renamingGroup = null; renderGroups(); }
          },
        })
        : el('span', { class: 'gname', text: g.name }),
      el('span', { class: 'gmeta', text: `${SITE_LABEL[g.site] || g.site} · ${g.profiles.length} profile${g.profiles.length === 1 ? '' : 's'} · exported for ${g.formats.map((f) => FORMAT_LABEL[f] || f).join(' + ')}` }),
      el('button', {
        class: 'sec', type: 'button', text: renamingGroup === g.id ? 'Save name' : 'Rename', title: 'Change the name of this group',
        onclick: (e) => {
          e.stopPropagation();
          if (renamingGroup === g.id) { saveGroupName(g.id, e.target.closest('.group-row').querySelector('.gedit').value); return; }
          renamingGroup = g.id;
          renderGroups();
        },
      }),
      el('button', {
        class: 'sec', type: 'button', text: 'Open in Editor', title: 'Send this group to the Editor tab',
        onclick: (e) => { e.stopPropagation(); sendToEditor(g.id, 'bMsg'); },
      }),
      el('button', {
        class: 'sec danger', type: 'button', text: 'Delete',
        onclick: async (e) => {
          e.stopPropagation();
          if (!(await askConfirm(`Delete the group "${g.name}"? Its cards stay marked as in use.`))) return;
          if (openGroup === g.id) openGroup = null;
          handleVault(await api.vaultDeleteGroup(g.id), 'bMsg');
        },
      })));
      if (open) {
        const t = el('table');
        const head = t.createTHead().insertRow();
        ['#', 'Profile', 'Name', 'Email', 'Phone', 'Address', 'Card'].forEach((h) => head.append(el('th', { text: h })));
        const body = t.createTBody();
        // alphabetical (cam 1, cam 2, cam 10...), also for groups saved before sorting existed
        const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
        g.profiles.slice().sort((x, y) => collator.compare(x.name || `${x.first} ${x.last}`, y.name || `${y.first} ${y.last}`)).forEach((p, i) => {
          const tr = body.insertRow();
          const a = p.address;
          [i + 1, p.name, sx('name', `${p.first} ${p.last}`), sx('email', p.email), sx('phone', p.phone),
            Privacy.group(sx('line1', a.line1), a.line2 ? ` | ${a.line2}` : ''), [`${p.cardBrand} •••• `, sx('last4', p.cardLast4)]]
            .forEach((v) => fillCell(tr.insertCell(), v));
        });
        list.append(el('div', { class: 'group-body table-wrap' }, t));
      }
    }
  }

  // ------------------------------------------------------------------ editor
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    address: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    email: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/>',
    card: '<rect x="1" y="4" width="22" height="16" rx="2"/><path d="M1 10h22"/>',
    name: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  };
  const FLAG_TEXT = { address: 'address', email: 'email', card: 'card', name: 'name' };
  const FLAG_ORDER = ['address', 'email', 'card', 'name'];
  function icon(kind) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ic-' + kind);
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[kind]; // fixed internal markup, no user text
    return svg;
  }

  let openImport = null;
  const importFilter = new Set(); // flag kinds to show (empty = all)

  async function importFiles(files) {
    const notes = [];
    let last = null;
    const results = [];
    for (const f of files) {
      const r = await api.editorImport(await f.text(), f.name, $('edSite').value);
      results.push(r);
      if (r.snapshot) applySnapshot(r.snapshot);
      if (!r.ok) { notes.push(`${f.name}: ${r.error}`); continue; }
      last = r;
      (r.warnings || []).forEach((w) => notes.push(`${f.name}: ${w}`));
    }
    $('edNotes').replaceChildren(...notes.map((n) => el('li', { text: Privacy.scrub(n) })));
    if (last) {
      openImport = last.id;
      importFilter.clear();
      renderEditor();
      const jigs = results.reduce((n, x) => n + (x.jigsAdded || 0), 0);
      setMsg('edMsg', `Imported ${last.count} profile${last.count === 1 ? '' : 's'}.${jigs ? ` ${jigs} address jig${jigs === 1 ? '' : 's'} added to Vault > Used Jigs.` : ''}`, 'ok');
    } else {
      setMsg('edMsg', 'Nothing was imported.', 'err');
    }
  }
  $('edImportBtn').addEventListener('click', () => $('edFile').click());
  $('edFile').addEventListener('change', () => { const fs = [...$('edFile').files]; $('edFile').value = ''; if (fs.length) importFiles(fs); });

  // Drag and drop Hayha / Polar profile files onto the Editor tab. Dropped files go through the same import
  // as the button, so detection, duplicate flags and warnings behave identically.
  const editorTab = $('tabEditor');
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  let dragDepth = 0;
  editorTab.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; editorTab.classList.add('dragging'); });
  editorTab.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  editorTab.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) editorTab.classList.remove('dragging'); });
  editorTab.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    editorTab.classList.remove('dragging');
    const dropped = [...e.dataTransfer.files];
    const ok = dropped.filter((f) => /\.(hayha|json|polar)$/i.test(f.name));
    const skipped = dropped.filter((f) => !ok.includes(f));
    if (skipped.length) setMsg('edMsg', `Skipped ${skipped.length} file${skipped.length === 1 ? '' : 's'} that ${skipped.length === 1 ? "isn't" : "aren't"} Hayha or Polar profile files (.hayha / .json).`, 'err');
    if (ok.length) importFiles(ok).then(() => {
      if (skipped.length) $('edNotes').append(...skipped.map((f) => el('li', { text: `${f.name}: not a .hayha or .json file, skipped.` })));
    });
  });
  // A file dropped anywhere else must not make the window navigate to it (Electron's default).
  ['dragover', 'drop'].forEach((t) => window.addEventListener(t, (e) => { if (hasFiles(e) && !editorTab.contains(e.target)) e.preventDefault(); }));

  // [line 1 (+ unit), city / state / zip] with the sensitive parts marked for Streamer Mode
  function addrNodes(a) {
    return [
      Privacy.group(sx('line1', a.line1), a.line2 ? ` | ${a.line2}` : ''),
      Privacy.group(`${a.city}, ${a.state.name || a.state.shortCode}, `, sx('zip', a.zip)),
    ];
  }
  const joinNodes = (list, sep) => list.reduce((acc, n, i) => (i ? [...acc, sep, n] : [n]), []);

  // Small right-click menu (closes on any click, Escape, scroll or when the window loses focus)
  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function showMenu(x, y, items) {
    closeMenu();
    const m = el('div', { class: 'ctxmenu', role: 'menu' });
    items.filter(Boolean).forEach((it) => m.append(el('button', {
      type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', text: it.label,
      onclick: () => { closeMenu(); it.run(); },
    })));
    document.body.append(m);
    menuEl = m;
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  }
  document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('blur', closeMenu);
  document.addEventListener('scroll', closeMenu, true);

  function profileCard(rec, p) {
    const f = p.flags;
    const sev = f.address ? 'sev-addr' : (f.email || f.card || f.name) ? 'sev-dup' : 'sev-ok';
    const [l1, l2] = addrNodes(p.address);
    const full = `${p.first} ${p.last}`.trim();
    const meta = joinNodes([full && sx('name', full), p.email && sx('email', p.email), p.phone && sx('phone', p.phone)].filter(Boolean), '  ·  ');
    const icons = FLAG_ORDER.filter((k) => f[k]).map((k) => {
      const w = el('span', { title: `Duplicate ${FLAG_TEXT[k]} (shared by ${f[k]} profiles)` });
      w.append(icon(k));
      return w;
    });
    return el('div', {
      class: 'pcard ' + sev,
      oncontextmenu: (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: 'Edit profile', run: () => openProfileEditor(rec, p) },
          { label: 'Jig address', run: async () => handleEditor(await api.editorJig(rec.id, p.id)) },
          p.changed && { label: 'Reset address', run: async () => handleEditor(await api.editorReset(rec.id, p.id)) },
          { label: 'Delete profile', danger: true, run: async () => handleEditor(await api.editorDeleteProfile(rec.id, p.id), `Deleted ${p.name || 'the profile'}.`) },
        ]);
      },
    },
      el('div', { class: 'ptop' },
        el('span', { class: 'gicons' }, icons),
        el('b', null, p.name || sx('name', full)),
        el('span', { class: 'pacts' },
          p.changed && el('button', {
            class: 'sec', type: 'button', text: 'Reset',
            onclick: async () => handleEditor(await api.editorReset(rec.id, p.id)),
          }),
          el('button', {
            class: 'sec', type: 'button', text: 'Edit',
            onclick: () => openProfileEditor(rec, p),
          }),
          el('button', {
            class: 'sec', type: 'button', text: 'Jig address',
            onclick: async () => handleEditor(await api.editorJig(rec.id, p.id)),
          }))),
      el('div', { class: 'pmeta' }, meta),
      el('div', { class: 'pgrid' },
        el('div', null,
          el('div', { class: 'plabel', text: 'Billing' }),
          el('div', null, l1, p.changed && el('span', { class: 'tagj', text: 'jigged' })),
          el('div', null, l2),
          p.changed && el('div', { class: 'origline' }, 'was: ', addrNodes({ ...p.address, line1: p.origAddress.line1, line2: p.origAddress.line2 })[0])),
        el('div', null,
          el('div', { class: 'plabel', text: 'Shipping' }),
          el('div', { class: 'same', text: 'Same as billing ✓' }))),
      el('div', { class: 'pay' },
        el('span', { class: 'plabel', text: 'Payment' }),
        el('b', { text: p.card.brand }), ' •••• ', sx('last4', p.card.last4), '  ·  Exp ', sx('exp', `${p.card.expMonth}/${p.card.expYear}`)));
  }

  // One centered line explaining a duplicate type, e.g. "Duplicate address: 15164 Example St (2 profiles)".
  const DUP_LABEL = { address: 'Duplicate address', email: 'Duplicate email', card: 'Duplicate card', name: 'Duplicate name' };
  function dupValue(p, kind) {
    if (kind === 'address') return p.address.line2 ? `${p.address.line1} | ${p.address.line2}` : p.address.line1;
    if (kind === 'email') return p.email;
    if (kind === 'card') return `${p.card.brand} •••• ${p.card.last4}`;
    return `${p.first} ${p.last}`.trim();
  }
  // The duplicated value as nodes, so Streamer Mode can blur or mask it.
  function dupNodes(p, kind) {
    if (kind === 'address') return [Privacy.group(sx('line1', p.address.line1), p.address.line2 ? ` | ${p.address.line2}` : '')];
    if (kind === 'email') return [sx('email', p.email)];
    if (kind === 'card') return [`${p.card.brand} •••• `, sx('last4', p.card.last4)];
    return [sx('name', `${p.first} ${p.last}`.trim())];
  }
  function dupLine(rec, kind) {
    const sets = new Map();
    rec.profiles.filter((p) => p.flags[kind]).forEach((p) => {
      const v = dupValue(p, kind);
      const k = v.toLowerCase().replace(/[.,#-]/g, '').replace(/\s+/g, ' ').trim();
      if (!sets.has(k)) sets.set(k, { p, n: 0 });
      sets.get(k).n++;
    });
    const list = [...sets.values()];
    const line = el('div', { class: 'dupline' });
    line.append(icon(kind), `${DUP_LABEL[kind]}: `);
    if (!list.length) line.append('none found');
    list.slice(0, 3).forEach((x, i) => {
      if (i) line.append('; ');
      dupNodes(x.p, kind).forEach((n) => line.append(n));
      line.append(` (${x.n} profiles)`);
    });
    if (list.length > 3) line.append(`; and ${list.length - 3} more`);
    return line;
  }

  // ---- Edit one imported profile (every field). Blank card number / CVV keeps the saved one; they never reach this window.
  let peTarget = null;
  let peStatesLoaded = false;
  async function openProfileEditor(rec, p) {
    if (!peStatesLoaded) {
      const sel = $('peState');
      sel.append(el('option', { value: '', text: '-' }));
      (await api.states()).forEach((st) => sel.append(el('option', { value: st.shortCode, text: `${st.shortCode} - ${st.name}` })));
      peStatesLoaded = true;
    }
    peTarget = { recId: rec.id, id: p.id };
    const set = (id, v) => { $(id).value = v || ''; };
    set('peName', p.name); set('peFirst', p.first); set('peLast', p.last); set('peEmail', p.email); set('pePhone', p.phone);
    set('peLine1', p.address.line1); set('peLine2', p.address.line2); set('peCity', p.address.city);
    $('peState').value = p.address.state && p.address.state.shortCode || '';
    set('peZip', p.address.zip); set('peCountry', p.address.country);
    set('peHolder', p.card.holder); set('peNumber', ''); set('peCvv', '');
    set('peMonth', p.card.expMonth); set('peYear', p.card.expYear);
    $('peNumber').placeholder = `${p.card.brand} •••• ${p.card.last4} (leave blank to keep)`;
    $('peCvv').placeholder = 'Leave blank to keep';
    $('peHint').textContent = 'Changing the street address makes it the new starting point for Jig address and Reset.';
    setMsg('peMsg', '', '');
    $('peMsg').textContent = '';
    $('profDlg').showModal();
  }
  $('peCancel').addEventListener('click', () => $('profDlg').close());
  $('peSave').addEventListener('click', async () => {
    if (!peTarget) return;
    const v = (id) => $(id).value;
    const fields = {
      name: v('peName'), first: v('peFirst'), last: v('peLast'), email: v('peEmail'), phone: v('pePhone'),
      address: { line1: v('peLine1'), line2: v('peLine2'), city: v('peCity'), state: v('peState'), zip: v('peZip'), country: v('peCountry') },
      card: { holder: v('peHolder'), number: v('peNumber'), expMonth: v('peMonth'), expYear: v('peYear'), cvv: v('peCvv') },
    };
    const r = await api.editorUpdateProfile(peTarget.recId, peTarget.id, fields);
    if (!r.ok) { setMsg('peMsg', r.error, 'err'); return; }
    $('profDlg').close();
    peTarget = null;
    handleEditor(r, 'Profile updated.');
  });

  // Rename an imported / built file in a small dialog (a dialog keeps typing reliable inside the clickable row).
  let renId = null;
  function openRename(rec) {
    renId = rec.id;
    $('renName').value = rec.name;
    setMsg('renMsg', '', '');
    $('renDlg').showModal();
    $('renName').focus();
    $('renName').select();
  }
  async function saveRename() {
    if (!renId) return;
    const r = await api.editorRename(renId, $('renName').value);
    if (!r.ok) { setMsg('renMsg', r.error, 'err'); return; }
    $('renDlg').close();
    renId = null;
    handleEditor(r, 'Renamed.');
  }
  $('renCancel').addEventListener('click', () => $('renDlg').close());
  $('renSave').addEventListener('click', saveRename);
  $('renName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveRename(); } });

  function handleEditor(r, okText) {
    if (r.snapshot) applySnapshot(r.snapshot);
    setMsg('edMsg', r.ok ? (okText || '') : r.error, r.ok ? 'ok' : 'err');
    return r.ok;
  }

  // Two lists share one renderer: files imported into the Editor, and batches sent over from the Builder.
  function renderEditor() {
    const imported = snap.imports.filter((r) => r.source !== 'built');
    const built = snap.imports.filter((r) => r.source === 'built');
    $('edCount').textContent = imported.length ? `(${imported.length})` : '';
    $('edBuiltCount').textContent = built.length ? `(${built.length})` : '';
    renderImportRows($('edList'), imported, 'Nothing imported yet.');
    renderImportRows($('edBuiltList'), built, 'Nothing here yet. In the Builder, use Open in Editor on a batch or on a saved group.');
  }

  function renderImportRows(list, items, emptyText) {
    list.replaceChildren();
    if (!items.length) {
      list.append(el('p', { class: 'hint', text: emptyText }));
      return;
    }
    groupByDay(items, (r) => r.createdAt).forEach((day) => {
      list.append(el('div', { class: 'group-date', text: day.label }));
      day.items.forEach((rec) => {
        const open = openImport === rec.id;
        const dupIcons = FLAG_ORDER.filter((k) => rec.counts[k]).map((k) => {
          const w = el('span', { title: `${rec.counts[k]} profiles with a duplicate ${FLAG_TEXT[k]}` });
          w.append(icon(k), String(rec.counts[k]));
          return w;
        });
        list.append(el('div', {
          class: 'group-row' + (open ? ' open' : ''),
          onclick: () => { openImport = open ? null : rec.id; importFilter.clear(); renderEditor(); },
        },
        el('span', { class: 'chev', text: open ? '▾' : '▸' }),
        el('span', { class: 'gname', text: rec.name }),
        el('span', { class: 'gmeta', text: `${rec.source === 'built' ? `Built${rec.site ? ' for ' + (SITE_LABEL[rec.site] || rec.site) : ''}` : (rec.format === 'hayha' ? 'Hayha' : 'Polar') + (rec.site ? ' · ' + (SITE_LABEL[rec.site] || rec.site) : '')} · ${rec.count} profile${rec.count === 1 ? '' : 's'}` }),
        dupIcons.length ? el('span', { class: 'gicons' }, dupIcons) : el('span', { class: 'gmeta', text: 'no duplicates' }),
        el('button', {
          class: 'sec', type: 'button', text: 'Rename',
          onclick: (e) => { e.stopPropagation(); openRename(rec); },
        }),
        el('button', {
          class: 'sec danger', type: 'button', text: 'Delete',
          onclick: async (e) => {
            e.stopPropagation();
            if (!(await askConfirm(`Remove "${rec.name}" from the Editor? ${rec.source === 'built' ? 'The saved group and any exported files are not touched.' : 'Your original file is not touched.'}`))) return;
            if (openImport === rec.id) openImport = null;
            handleEditor(await api.editorDelete(rec.id));
          },
        })));
        if (!open) return;

        const chips = FLAG_ORDER.map((k) => {
          const n = rec.counts[k];
          const b = el('button', {
            class: 'chip ' + (importFilter.has(k) ? 'active ' : '') + (n ? '' : 'zero'), type: 'button',
            title: `${n} profile${n === 1 ? '' : 's'} with a duplicate ${FLAG_TEXT[k]}. Click to filter.`,
            onclick: () => { if (importFilter.has(k)) importFilter.delete(k); else importFilter.add(k); renderEditor(); },
          });
          b.append(icon(k), String(n));
          return b;
        });
        const body = el('div', { class: 'group-body' },
          el('div', { class: 'flagchips' },
            chips,
            el('button', {
              type: 'button', text: 'Fix addresses', ...(rec.counts.address ? {} : { disabled: 'disabled' }),
              title: 'Re-jig every profile whose address is shared, keeping the first one of each set',
              onclick: async () => {
                const r = await api.editorFix(rec.id);
                handleEditor(r, r.ok ? `Fixed ${r.fixed} duplicate address${r.fixed === 1 ? '' : 'es'}${r.failed ? `; ${r.failed} could not be fixed (no unused variation left)` : ''}.` : '');
              },
            }),
            rec.source !== 'built' && siteSelect(rec),
            el('span', { class: 'grow' }),
            el('button', { type: 'button', class: 'sec', text: 'Merge…', title: 'Merge other files or saved groups into this one', onclick: () => openMerge(rec) }),
            el('button', { type: 'button', class: 'sec', text: 'Export Hayha', onclick: () => exportImport(rec.id, 'hayha') }),
            el('button', { type: 'button', class: 'sec', text: 'Export Polar', onclick: () => exportImport(rec.id, 'polar') })));
        const shown = rec.profiles.filter((p) => !importFilter.size || [...importFilter].some((k) => p.flags[k]));
        if (importFilter.size) {
          const info = el('div', { class: 'filterinfo' });
          FLAG_ORDER.filter((k) => importFilter.has(k)).forEach((k) => info.append(dupLine(rec, k)));
          info.append(el('div', { class: 'hint', text: `Showing ${shown.length} of ${rec.count} profiles.` }));
          body.append(info);
        }
        shown.forEach((p) => body.append(profileCard(rec, p)));
        list.append(body);
      });
    });
  }

  // Which retailer an imported file's profiles were used on. Its addresses are skipped for new jigs on that retailer
  // ("Not set" = skipped on every retailer).
  function siteSelect(rec) {
    const sel = el('select', { class: 'sortsel', 'aria-label': 'Retailer these profiles were used on', title: 'The retailer these profiles were used on. Their addresses are skipped for new jigs on that retailer.' },
      el('option', { value: '', text: 'Retailer: not set' }),
      el('option', { value: 'target', text: 'Target' }), el('option', { value: 'walmart', text: 'Walmart' }), el('option', { value: 'pokemoncenter', text: 'Pokémon Center' }));
    sel.value = rec.site || '';
    sel.addEventListener('change', async () => {
      const r = await api.editorSetSite(rec.id, sel.value);
      handleEditor(r, r.ok ? `Marked as ${sel.value ? (SITE_LABEL[sel.value] || sel.value) : 'not set (skipped on every retailer)'}${r.updated ? `; ${r.updated} used jig${r.updated === 1 ? '' : 's'} updated` : ''}.` : '');
    });
    return sel;
  }

  // ---- merge other Editor files / saved groups into a file (or a new file)
  let mergeTarget = null;
  function openMerge(rec) {
    mergeTarget = rec;
    $('mergeTitle').textContent = `Merge into “${rec.name}”`;
    $('mergeName').value = '';
    setMsg('mergeMsg', '');
    const list = $('mergeList');
    list.replaceChildren();
    const linked = new Set(snap.imports.map((r) => r.builtFrom).filter(Boolean)); // groups that already have an Editor copy
    const files = snap.imports.filter((r) => r.id !== rec.id);
    const groups = snap.groups.filter((g) => !linked.has(g.id));
    const row = (type, id, name, meta) => {
      const cb = el('input', { type: 'checkbox' });
      cb.dataset.type = type;
      cb.dataset.id = id;
      const li = el('li', { class: 'pickrow' }, cb, el('div', { class: 'main' }, el('b', { text: name }), el('span', { class: 'meta', text: `  ${meta}` })));
      cb.addEventListener('change', () => li.classList.toggle('on', cb.checked));
      li.addEventListener('click', (e) => { if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); } });
      return li;
    };
    if (files.length) {
      list.append(el('li', { class: 'mergehead', text: 'Editor files' }));
      files.forEach((r) => list.append(row('import', r.id, r.name, `${r.count} profile${r.count === 1 ? '' : 's'} · ${r.source === 'built' ? 'Built' : (r.format === 'hayha' ? 'Hayha' : 'Polar')}`)));
    }
    if (groups.length) {
      list.append(el('li', { class: 'mergehead', text: 'Saved groups' }));
      groups.forEach((g) => list.append(row('group', g.id, g.name, `${g.profiles.length} profile${g.profiles.length === 1 ? '' : 's'} · ${SITE_LABEL[g.site] || g.site}`)));
    }
    if (!files.length && !groups.length) list.append(el('li', null, el('div', { class: 'main meta', text: 'Nothing else to merge yet. Import another file in the Editor, or save a group in the Builder.' })));
    $('mergeGo').disabled = !files.length && !groups.length;
    $('mergeDlg').showModal();
  }
  $('mergeCancel').addEventListener('click', () => $('mergeDlg').close());
  (function () { // click outside the window to close it
    const dlg = $('mergeDlg');
    const outside = (e) => { const b = dlg.getBoundingClientRect(); return e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom; };
    let down = false;
    dlg.addEventListener('mousedown', (e) => { down = outside(e); });
    dlg.addEventListener('click', (e) => { if (down && outside(e)) dlg.close(); down = false; });
  })();
  $('mergeGo').addEventListener('click', async () => {
    const sources = [...$('mergeList').querySelectorAll('input:checked')].map((c) => ({ type: c.dataset.type, id: c.dataset.id }));
    if (!sources.length) { setMsg('mergeMsg', 'Pick at least one file or group.', 'err'); return; }
    const r = await api.editorMerge(mergeTarget.id, sources, $('mergeName').value);
    if (r.snapshot) applySnapshot(r.snapshot);
    if (!r.ok) { setMsg('mergeMsg', r.error, 'err'); return; }
    $('mergeDlg').close();
    openImport = r.id;
    importFilter.clear();
    renderEditor();
    setMsg('edMsg', `Merged ${r.added} profile${r.added === 1 ? '' : 's'}${r.newFile ? ' into a new file' : ''}${r.skipped ? `; skipped ${r.skipped} whose card is no longer in the vault` : ''}.`, r.skipped ? 'err' : 'ok');
  });

  async function exportImport(id, format) {
    const r = await api.editorExport(id, format);
    if (r.snapshot) applySnapshot(r.snapshot);
    if (r.ok) setMsg('edMsg', `Saved to ${r.filePath}.${r.jigsAdded ? ` ${r.jigsAdded} new address jig${r.jigsAdded === 1 ? '' : 's'} added to Vault > Used Jigs.` : ''}`, 'ok');
    else if (!r.canceled) setMsg('edMsg', r.error, 'err');
  }

  // ------------------------------------------------------------------ Streamer Mode + handoff from the Converter
  // Switching Streamer Mode on/off or changing its style only redraws what is on screen; no data is touched.
  Privacy.onChange(() => {
    applySnapshot(snap);
    if (lastRows) renderPreview(lastRows);
    setNotes(lastWarn);
  });

  // Used by Recently converted > Open in Editor (renderer.js).
  window.Studio = {
    showTab,
    // After Restore or Wipe: forget everything that was open or selected, then reload from the vault.
    reset() {
      stopEdit();
      openGroup = null;
      openImport = null;
      renamingGroup = null;
      picked.clear();
      pickedAcct.clear();
      importFilter.clear();
      lastRows = null;
      lastWarn = [];
      $('jigSearch').value = '';
      $('bResult').hidden = true;
      setMsg('bMsg', '');
      setMsg('edMsg', '');
      setMsg('vMsg', '');
      $('edNotes').replaceChildren();
      refresh();
    },
    openInEditor(r) {
      if (r.snapshot) applySnapshot(r.snapshot);
      openImport = r.id;
      importFilter.clear();
      $('edNotes').replaceChildren(...(r.warnings || []).map((w) => el('li', { text: Privacy.scrub(w) })));
      showTab('editor');
      renderEditor();
      setMsg('edMsg', `Opened ${r.count} profile${r.count === 1 ? '' : 's'} in the Editor.${r.jigsAdded ? ` ${r.jigsAdded} address jig${r.jigsAdded === 1 ? '' : 's'} added to Vault > Used Jigs.` : ''}`, 'ok');
    },
  };

  // ------------------------------------------------------------------ init
  (async function init() {
    const states = await api.states();
    ['vState'].forEach((id) => {
      const s = $(id);
      s.append(el('option', { value: '', text: 'State' }));
      states.forEach((st) => s.append(el('option', { value: st.shortCode, text: `${st.shortCode} - ${st.name}` })));
    });
    $('vState').value = '';
    syncForm();
    refresh();
  })();
})();
