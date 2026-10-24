'use strict';
// Handlers behind the window's IPC calls for the vault and builder.
// Electron-free (dialogs and file writes are injected) so it can be tested directly.

const { US_STATES, buildHayhaFile, buildPolarFile, buildCsvFile, buildHayhaAccountsFile, buildPolarAccountsFile, RETAILER_SITE } = require('./converter');
const { buildDraft, previewRows } = require('./profileBuilder');
const editor = require('./editor');
const crypto = require('crypto');
const { jigKey } = require('./jig');

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profiles';

// A saved-group profile (plus its full card from the vault) as an Editor profile.
const toEditorProfile = (p, card) => editor.makeProfile({
  name: p.name, first: p.first, last: p.last, email: p.email, phone: p.phone,
  line1: p.address.line1, line2: p.address.line2, city: p.address.city, state: p.address.state && (p.address.state.shortCode || p.address.state),
  zip: p.address.zip, country: p.address.country,
  card: { number: card.number, holder: card.holder, expMonth: card.expMonth, expYear: card.expYear, cvv: card.cvv },
});
const cloneProfile = (p) => ({ ...JSON.parse(JSON.stringify(p)), id: crypto.randomUUID() });

function createApi({ vault, showSave, writeFile }) {
  let draft = null;
  const withSnap = (res) => ({ ...res, snapshot: vault.snapshot() });
  // (line1, zip) -> true when that address variation was used in an earlier export or import
  const usedFn = (site) => { const used = vault.usedJigKeys(site); return (l1, zip) => used.has(jigKey(l1, zip)); };
  const IMPORT_SITES = ['target', 'walmart', 'pokemoncenter', 'other'];

  const api = {
    'meta:states': () => US_STATES.map(([shortCode, name]) => ({ shortCode, name })),
    'vault:get': () => ({ ok: true, snapshot: vault.snapshot() }),
    'vault:addAddress': (input) => withSnap(vault.addAddress(input)),
    'vault:updateAddress': (id, input) => withSnap(vault.updateAddress(id, input)),
    'vault:deleteAddress': (id) => withSnap(vault.deleteAddress(id)),
    'vault:addCard': (input, opts) => withSnap(vault.addCard(input, { lenient: !!(opts && opts.lenient) })),
    'vault:bulkCards': (text, opts) => withSnap(vault.addCardsBulk(text, { holder: opts && opts.holder, nickname: opts && opts.nickname, lenient: !!(opts && opts.lenient) })),
    'vault:deleteCard': (id) => withSnap(vault.deleteCard(id)),
    'vault:setUsed': (id, used) => withSnap(vault.setCardUsed(id, used)),
    'vault:addDomain': (d) => withSnap(vault.addDomain(d)),
    'vault:deleteDomain': (id) => withSnap(vault.deleteDomain(id)),
    'vault:addAccount': (input) => withSnap(vault.addAccount(input)),
    'vault:bulkAccounts': (text, opts) => withSnap(vault.addAccountsBulk(text, { retailer: opts && opts.retailer })),
    'vault:deleteAccount': (id) => withSnap(vault.deleteAccount(id)),
    'vault:removeJig': (id) => withSnap(vault.removeJig(id)),
    'vault:clearJigs': () => withSnap(vault.clearJigs()),
    'vault:setAccountUsed': (id, used) => withSnap(vault.setAccountUsed(id, used)),
    // Save the vault's accounts (all, or one retailer) as a Hayha or Polar accounts file. Passwords stay in this process.
    'vault:exportAccounts': async (format, retailer, status) => {
      if (!['hayha', 'polar'].includes(format)) return { ok: false, error: 'Unknown export format.' };
      const accounts = vault.listAccounts(retailer).filter((x) => status === 'used' ? x.used : status === 'free' ? !x.used : true);
      const what = status === 'used' ? 'in-use ' : status === 'free' ? 'available ' : '';
      if (!accounts.length) return { ok: false, error: retailer ? `There are no ${what}${RETAILER_SITE[retailer] || retailer} accounts to export.` : `There are no ${what}accounts to export.` };
      const label = retailer ? (RETAILER_SITE[retailer] || retailer) : 'All';
      const ext = format === 'hayha' ? 'hayha' : 'json';
      const text = format === 'hayha' ? buildHayhaAccountsFile(accounts) : buildPolarAccountsFile(accounts, retailer ? `${label} accounts` : 'AIO Studio');
      const filePath = await showSave({ defaultPath: `${slugify(label)}-accounts.${ext}`, ext });
      if (!filePath) return { ok: false, canceled: true };
      try { writeFile(filePath, text); } catch (e) { return { ok: false, error: e.message }; }
      return { ok: true, filePath, count: accounts.length };
    },
    'vault:reorder': (kind, ids) => withSnap(vault.reorder(kind, ids)),
    'vault:renameGroup': (id, name) => withSnap(vault.renameGroup(id, name)),
    'vault:deleteAll': (kind) => withSnap(vault.deleteAll(kind)),
    'vault:deleteGroup': (id) => withSnap(vault.deleteGroup(id)),

    // ---- Editor: imported profile files
    'editor:import': (text, fileName, site) => {
      let parsed;
      try { parsed = editor.parseProfilesFile(text); } catch (e) { return { ok: false, error: e.message }; }
      const base = String(fileName || '').replace(/\.[^.]*$/, '').trim();
      const name = base || parsed.groupName || 'Imported profiles';
      const siteMark = IMPORT_SITES.includes(site) ? site : ''; // which retailer these profiles were used on ('' = not set)
      const id = vault.addImport({ name, fileName, format: parsed.format, profiles: parsed.profiles, site: siteMark });
      // Addresses in an imported file have been used somewhere already: the Builder and the Editor's re-jig skip them
      // from now on, on that retailer (or on every retailer when none is set).
      const jigsAdded = vault.recordJigs(parsed.profiles, { batch: name, site: siteMark, format: parsed.format, source: 'import', importId: id });
      return withSnap({ ok: true, id, count: parsed.profiles.length, format: parsed.format, warnings: parsed.warnings, jigsAdded });
    },
    'editor:jig': (importId, profileId) => {
      const rec = vault.getImport(importId);
      const p = rec && rec.profiles.find((x) => x.id === String(profileId));
      if (!p) return { ok: false, error: 'Profile not found.' };
      const taken = new Set(rec.profiles.filter((x) => x !== p).map((x) => editor.addrKey(x.address)));
      const r = editor.rejigProfile(p, taken, undefined, usedFn(rec.site));
      if (r.ok) vault.commit();
      return withSnap(r);
    },
    'editor:updateProfile': (importId, profileId, fields) => {
      const rec = vault.getImport(importId);
      const p = rec && rec.profiles.find((x) => x.id === String(profileId));
      if (!p) return { ok: false, error: 'Profile not found.' };
      const r = editor.updateProfile(p, fields);
      if (r.ok) vault.commit();
      return withSnap(r);
    },
    'editor:reset': (importId, profileId) => {
      const rec = vault.getImport(importId);
      const p = rec && rec.profiles.find((x) => x.id === String(profileId));
      if (!p) return { ok: false, error: 'Profile not found.' };
      p.address.line1 = p.orig.line1;
      p.address.line2 = p.orig.line2;
      vault.commit();
      return withSnap({ ok: true });
    },
    'editor:fix': (importId) => {
      const rec = vault.getImport(importId);
      if (!rec) return { ok: false, error: 'Imported file not found.' };
      const r = editor.fixDuplicateAddresses(rec.profiles, undefined, usedFn(rec.site));
      if (r.fixed) vault.commit();
      return withSnap({ ok: true, ...r });
    },
    'editor:deleteProfile': (importId, profileId) => {
      const rec = vault.getImport(importId);
      if (!rec) return { ok: false, error: 'Imported file not found.' };
      const n = rec.profiles.length;
      rec.profiles = rec.profiles.filter((x) => x.id !== String(profileId));
      if (rec.profiles.length === n) return { ok: false, error: 'Profile not found.' };
      vault.commit();
      return withSnap({ ok: true });
    },
    // Merge other Editor files and/or saved groups into this file, or into a new file when a name is given.
    // The files and groups that were picked are left as they are.
    'editor:merge': (targetId, sources, newName) => {
      const target = vault.getImport(targetId);
      if (!target) return { ok: false, error: 'Imported file not found.' };
      const picks = Array.isArray(sources) ? sources : [];
      if (!picks.length) return { ok: false, error: 'Pick at least one file or group to merge.' };
      const add = [];
      let skipped = 0;
      for (const s of picks) {
        if (s && s.type === 'import') {
          const r = vault.getImport(s.id);
          if (r && r.id !== target.id) r.profiles.forEach((p) => add.push(cloneProfile(p)));
        } else if (s && s.type === 'group') {
          const g = vault.getGroup(s.id);
          if (!g) continue;
          const cards = new Map(vault.getCards(g.profiles.map((p) => p.cardId)).map((c) => [c.id, c]));
          g.profiles.forEach((p) => { const c = cards.get(p.cardId); if (c) add.push(toEditorProfile(p, c)); else skipped++; });
        }
      }
      if (!add.length) return { ok: false, error: skipped ? `${skipped} profile${skipped === 1 ? '' : 's'} could not be merged because their cards are no longer in the vault.` : 'There was nothing to merge.' };
      const name = String(newName || '').trim().slice(0, 60);
      if (name) {
        const id = vault.addImport({ name, fileName: '', format: target.format, profiles: [...target.profiles.map(cloneProfile), ...add], site: target.site });
        return withSnap({ ok: true, id, added: add.length, skipped, count: target.profiles.length + add.length, newFile: true });
      }
      target.profiles.push(...add);
      vault.commit();
      return withSnap({ ok: true, id: target.id, added: add.length, skipped, count: target.profiles.length });
    },
    // Change which retailer an Editor file's profiles were used on (also updates the used jigs that came in with it).
    'editor:rename': (importId, name) => withSnap(vault.renameImport(importId, name)),
    'editor:setSite': (importId, site) => withSnap(vault.setImportSite(importId, IMPORT_SITES.includes(site) ? site : '')),
    'editor:delete': (importId) => withSnap(vault.deleteImport(importId)),
    'editor:export': async (importId, format) => {
      const rec = vault.getImport(importId);
      if (!rec) return { ok: false, error: 'Imported file not found.' };
      if (!['hayha', 'polar'].includes(format)) return { ok: false, error: 'Unknown export format.' };
      const ext = format === 'hayha' ? 'hayha' : 'json';
      const filePath = await showSave({ defaultPath: `${slugify(rec.name)}-edited.${ext}`, ext });
      if (!filePath) return { ok: false, canceled: true };
      try { writeFile(filePath, editor.exportProfiles(rec, format)); } catch (e) { return { ok: false, error: e.message }; }
      // what the file now contains (including re-jigged addresses) is used too
      const jigsAdded = vault.recordJigs(rec.profiles, { batch: rec.name, site: rec.site, format, source: 'editor' });
      return { ok: true, filePath, jigsAdded, snapshot: vault.snapshot() };
    },

    // After a restore or wipe: the batch that was generated points at cards that may no longer exist.
    'builder:reset': () => { draft = null; return { ok: true }; },

    'builder:generate': (opts) => {
      const r = buildDraft(vault, opts);
      if (!r.ok) { draft = null; return r; }
      draft = r.draft;
      return { ok: true, warnings: r.warnings, rows: previewRows(draft), count: draft.profiles.length };
    },

    // Send built profiles to the Editor tab. With a group id: that saved group (its cards are looked up in the vault
    // again, since a group only keeps the last 4 digits). Without one: the batch that was just generated.
    // Sending the same batch twice just reopens the copy that is already in the Editor.
    'builder:toEditor': (groupId) => {
      const sent = (rec, count) => withSnap({ ok: true, id: rec.id, count, existing: true });

      if (groupId) {
        const g = vault.getGroup(groupId);
        if (!g) return { ok: false, error: 'Group not found.' };
        const have = vault.getImportBuiltFrom(g.id);
        if (have && vault.getImport(have.id)) return sent(have, have.profiles.length);
        const cards = new Map(vault.getCards(g.profiles.map((p) => p.cardId)).map((c) => [c.id, c]));
        const gone = g.profiles.filter((p) => !cards.has(p.cardId)).length;
        if (gone) return { ok: false, error: `${gone} card${gone === 1 ? ' from this group is' : 's from this group are'} no longer in the vault, so the group cannot be opened in the Editor.` };
        const profiles = g.profiles.map((p) => toEditorProfile(p, cards.get(p.cardId)));
        const id = vault.addImport({ name: g.name, fileName: '', format: 'hayha', profiles, source: 'built', site: g.site, builtFrom: g.id });
        return withSnap({ ok: true, id, count: profiles.length });
      }

      if (!draft) return { ok: false, error: 'Generate profiles first.' };
      if (draft.groupId) return api['builder:toEditor'](draft.groupId); // already exported: use its saved group
      if (draft.editorImportId && vault.getImport(draft.editorImportId)) return sent(vault.getImport(draft.editorImportId), draft.profiles.length);
      const profiles = draft.profiles.map((p) => toEditorProfile(p, p.card));
      draft.editorImportId = vault.addImport({ name: draft.opts.groupName, fileName: '', format: 'hayha', profiles, source: 'built', site: draft.opts.site });
      return withSnap({ ok: true, id: draft.editorImportId, count: profiles.length });
    },

    'builder:export': async (format) => {
      if (!draft) return { ok: false, error: 'Generate profiles first.' };
      if (!['hayha', 'polar', 'csv'].includes(format)) return { ok: false, error: 'Unknown export format.' };
      const ext = format === 'hayha' ? 'hayha' : format === 'csv' ? 'csv' : 'json';
      const text = format === 'hayha' ? buildHayhaFile(draft.profiles)
        : format === 'csv' ? buildCsvFile(draft.profiles)
          : buildPolarFile(draft.profiles, draft.opts.groupName);
      const filePath = await showSave({ defaultPath: `${slugify(draft.opts.prefix)}-${format === 'csv' ? 'addresses' : 'profiles'}.${ext}`, ext });
      if (!filePath) return { ok: false, canceled: true };
      try {
        writeFile(filePath, text);
      } catch (e) {
        return { ok: false, error: e.message };
      }
      let marked = 0;
      let markedAccounts = 0;
      let markedJigs = 0;
      if (format !== 'csv' && draft.opts.markUsed && !draft.marked) { // the CSV holds no card data
        vault.markUsed(draft.cardIds, {
          batch: draft.opts.groupName,
          site: draft.opts.site,
          date: new Date().toISOString(),
          format,
        });
        // accounts whose emails were used on the profiles are marked too
        if (draft.accountIds && draft.accountIds.length) {
          vault.markAccountsUsed(draft.accountIds, { batch: draft.opts.groupName, site: draft.opts.site, date: new Date().toISOString(), format });
          markedAccounts = draft.accountIds.length;
        }
        draft.marked = true;
        marked = draft.cardIds.length;
      }
      // The address variations in this batch are now used: the Builder will not generate them again (all formats, once per batch).
      if (draft.opts.markUsed && !draft.jigsMarked) {
        markedJigs = vault.recordJigs(draft.profiles, { batch: draft.opts.groupName, site: draft.opts.site, date: new Date().toISOString(), format });
        draft.jigsMarked = true;
      }
      // Hayha / Polar exports save the batch as a group (once), and later formats are added to it.
      let saved = false;
      if (format !== 'csv') {
        if (!draft.groupId) {
          draft.groupId = vault.addGroup({ name: draft.opts.groupName, site: draft.opts.site, format, profiles: draft.profiles });
          saved = true;
          // if the batch was already sent to the Editor, link that copy to the new group so it is not sent twice
          const sentCopy = draft.editorImportId && vault.getImport(draft.editorImportId);
          if (sentCopy) { sentCopy.builtFrom = draft.groupId; vault.commit(); }
        } else {
          vault.addGroupFormat(draft.groupId, format);
        }
      }
      return { ok: true, filePath, marked, markedAccounts, markedJigs, saved, snapshot: vault.snapshot() };
    },
  };
  return api;
}

module.exports = { createApi };
