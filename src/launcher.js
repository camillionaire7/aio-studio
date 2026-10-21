'use strict';
// Launch the Hayha and Polar desktop apps from this app.
// Finds them automatically (Start Menu / Desktop shortcuts, then install folders), or uses a path the user picked.
// Electron-free: the file system, environment, openPath and file picker are injected so it can be tested.

const nodeFs = require('fs');
const nodePath = require('path');

const APPS = {
  hayha: { label: 'Hayha', match: /hayha/i },
  polar: { label: 'Polar', match: /polar/i },
};
const BAD_EXE = /uninstall|update|squirrel|crash|setup|installer|helper/i;

function listDir(fs, dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
}

// Shortcuts (.lnk) whose name matches, searched two folders deep.
function findShortcut(fs, roots, re) {
  const walk = (dir, depth) => {
    for (const e of listDir(fs, dir)) {
      const full = nodePath.join(dir, e.name);
      if (e.isFile() && /\.lnk$/i.test(e.name) && re.test(e.name) && !BAD_EXE.test(e.name)) return full;
      if (e.isDirectory() && depth < 2) { const r = walk(full, depth + 1); if (r) return r; }
    }
    return null;
  };
  for (const r of roots) { const f = walk(r, 0); if (f) return f; }
  return null;
}

// An install folder whose name matches, holding a launchable .exe (one level down).
function findInstalled(fs, roots, re, key) {
  for (const root of roots) {
    for (const d of listDir(fs, root)) {
      if (!d.isDirectory() || !re.test(d.name)) continue;
      const dir = nodePath.join(root, d.name);
      const exes = listDir(fs, dir).filter((e) => e.isFile() && /\.exe$/i.test(e.name) && !BAD_EXE.test(e.name));
      if (!exes.length) continue;
      const best = exes.find((e) => e.name.toLowerCase().includes(key)) || exes[0];
      return nodePath.join(dir, best.name);
    }
  }
  return null;
}

function autoFind(key, { fs = nodeFs, env = process.env, platform = process.platform } = {}) {
  const app = APPS[key];
  if (!app) return null;
  const join = nodePath.join;
  if (platform === 'win32') {
    const roots = [
      env.APPDATA && join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      env.ProgramData && join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      env.USERPROFILE && join(env.USERPROFILE, 'Desktop'),
      env.PUBLIC && join(env.PUBLIC, 'Desktop'),
    ].filter(Boolean);
    const lnk = findShortcut(fs, roots, app.match);
    if (lnk) return lnk;
    const installs = [
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'),
      env.LOCALAPPDATA,
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
    ].filter(Boolean);
    return findInstalled(fs, installs, app.match, key);
  }
  if (platform === 'darwin') {
    const hit = listDir(fs, '/Applications').find((e) => /\.app$/i.test(e.name) && app.match.test(e.name));
    return hit ? join('/Applications', hit.name) : null;
  }
  return null;
}

function createLauncher({ settingsFile, fs = nodeFs, env, platform, openPath, pickFile }) {
  let paths = {};
  try {
    const d = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (d && d.paths && typeof d.paths === 'object') paths = d.paths;
  } catch (e) { /* first run */ }

  const save = () => {
    try {
      fs.mkdirSync(nodePath.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify({ paths }), 'utf8');
    } catch (e) { /* ignore */ }
  };

  function resolve(key) {
    if (paths[key] && fs.existsSync(paths[key])) return { path: paths[key], source: 'chosen' };
    const found = autoFind(key, { fs, env, platform });
    return found ? { path: found, source: 'found' } : { path: null, source: null };
  }

  const status = () => {
    const out = {};
    for (const [k, a] of Object.entries(APPS)) out[k] = { label: a.label, ...resolve(k) };
    return out;
  };
  const bad = (key) => (APPS[key] ? null : { ok: false, error: 'Unknown app.' });

  return {
    status,
    // Backup / restore / wipe: the app paths the user picked by hand (automatic ones are found again on their own).
    exportPaths: () => ({ ...paths }),
    importPaths(p) {
      paths = {};
      if (p && typeof p === 'object') for (const k of Object.keys(APPS)) if (typeof p[k] === 'string' && p[k]) paths[k] = p[k];
      save();
    },
    clearAll() { paths = {}; save(); },
    async launch(key) {
      const e = bad(key); if (e) return e;
      const r = resolve(key);
      if (!r.path) return { ok: false, needsPath: true, error: `${APPS[key].label} was not found. Choose where it is installed.` };
      const err = await openPath(r.path);
      if (err) return { ok: false, error: `Could not open ${APPS[key].label}: ${err}` };
      return { ok: true };
    },
    async choose(key) {
      const e = bad(key); if (e) return e;
      const picked = await pickFile({ title: `Choose the ${APPS[key].label} app (or its shortcut)` });
      if (!picked) return { ok: false, canceled: true, status: status() };
      if (!fs.existsSync(picked)) return { ok: false, error: 'That file does not exist.', status: status() };
      paths[key] = picked;
      save();
      return { ok: true, status: status() };
    },
    clear(key) {
      const e = bad(key); if (e) return e;
      delete paths[key];
      save();
      return { ok: true, status: status() };
    },
  };
}

module.exports = { createLauncher, autoFind, APPS };
