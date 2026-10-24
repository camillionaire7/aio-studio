'use strict';
// Development convenience: when you replace files in the app folder, the app picks the change up by itself.
//   - window files (index.html, ui.js, renderer.js, privacy.js, theme.js, preload.js, assets/...) -> the window reloads
//   - anything else (main.js, api.js, vaultStore.js, editor.js, jig.js, ...) -> the app restarts
// Only runs from source (not in a packaged build). Electron-free: watching, timers and actions are injected for testing.
const nodeFs = require('fs');
const nodePath = require('path');

const WINDOW_FILES = new Set(['index.html', 'ui.js', 'renderer.js', 'privacy.js', 'theme.js', 'preload.js']);
const IGNORE = /(^|[\\/])(\.|~)|\.(tmp|swp|part|crdownload|bak|aiobak|json)$|~$/i; // editor temp files, data and settings files

// -> 'window' | 'app' | null (ignore)
function classify(rel) {
  const name = String(rel || '').replace(/\\/g, '/');
  if (!name || IGNORE.test(name)) return null;
  if (name.startsWith('assets/')) return 'window';
  if (WINDOW_FILES.has(name)) return 'window';
  if (/\.(js|html|css)$/i.test(name)) return 'app';
  return null;
}

function startHotReload({ dir, onWindow, onApp, delay = 600, fs = nodeFs, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
  let pending = null; // 'window' | 'app'
  let timer = null;
  const watchers = [];
  const fire = () => {
    timer = null;
    const what = pending;
    pending = null;
    log(`hot reload: ${what}`);
    try { (what === 'app' ? onApp : onWindow)(); } catch (e) { log(`hot reload failed: ${e.message}`); }
  };
  const note = (base) => (evt, file) => {
    if (!file) return;
    const kind = classify(nodePath.join(base, String(file)).slice(dir.length + 1));
    if (!kind) return;
    if (pending !== 'app') pending = kind; // a restart covers a window reload
    if (timer) clearTimer(timer);
    timer = setTimer(fire, delay); // wait for the whole batch of replaced files
  };
  for (const sub of ['', 'assets']) {
    const base = nodePath.join(dir, sub);
    try { if (fs.existsSync(base)) watchers.push(fs.watch(base, note(base))); } catch (e) { log(`cannot watch ${base}: ${e.message}`); }
  }
  return { stop() { watchers.forEach((w) => { try { w.close(); } catch (e) { /* ignore */ } }); if (timer) clearTimer(timer); } };
}

module.exports = { startHotReload, classify };
