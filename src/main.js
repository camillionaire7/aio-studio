'use strict';
const { app, BrowserWindow, ipcMain, dialog, safeStorage, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { convert } = require('./converter');
const { VaultStore } = require('./vaultStore');
const { createApi } = require('./api');
const { History } = require('./history');
const { createLauncher } = require('./launcher');
const { createBackupService, FILE_EXT } = require('./backup');

// The converted output stays in the main process; the window only ever sees a
// masked preview, and Save writes this stored copy.
let lastResult = null;
let history = null;
let editorImport = null; // the Editor's import handler, so Recently converted can open a saved file in it
let vault = null;
let launcher = null;
let resetBuilderDraft = null; // clears the Builder's generated batch (after a restore or wipe)

function createWindow() {
  // Open large: up to 1440x960, but never bigger than the screen's usable area.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1440, area.width - 40),
    height: Math.min(960, area.height - 40),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#090a16',
    title: 'PokeSluts AIO Studio',
    icon: path.join(__dirname, 'assets', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('convert', (_evt, { text, groupName }) => {
  try {
    const r = convert(String(text), { groupName });
    lastResult = r;
    return {
      ok: true,
      fromLabel: r.fromLabel,
      toLabel: r.toLabel,
      needsGroupName: r.needsGroupName,
      count: r.count,
      warnings: r.warnings,
      fileName: r.fileName,
      preview: r.preview,
    };
  } catch (e) {
    lastResult = null;
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('save', async (evt) => {
  if (!lastResult) return { ok: false, error: 'Nothing to save yet.' };
  const win = BrowserWindow.fromWebContents(evt.sender);
  const ext = path.extname(lastResult.fileName).slice(1);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: lastResult.fileName,
    filters: [{ name: ext === 'hayha' ? 'Hayha file' : 'JSON file', extensions: [ext] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, lastResult.outputText, 'utf8');
    if (history) {
      history.add({ fileName: path.basename(filePath), fromLabel: lastResult.fromLabel, toLabel: lastResult.toLabel, count: lastResult.count, filePath });
    }
    return { ok: true, filePath, history: history ? history.list() : [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function registerVaultApi() {
  vault = new VaultStore(path.join(app.getPath('userData'), 'vault.json'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  });
  const handlers = createApi({
    vault,
    showSave: async ({ defaultPath, ext }) => {
      const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
        defaultPath,
        filters: [{ name: ext === 'hayha' ? 'Hayha file' : ext === 'csv' ? 'CSV file' : ext === FILE_EXT ? 'AIO Studio backup' : 'JSON file', extensions: [ext] }],
      });
      return canceled ? null : filePath;
    },
    writeFile: (p, text) => fs.writeFileSync(p, text, 'utf8'),
  });
  editorImport = handlers['editor:import'];
  resetBuilderDraft = handlers['builder:reset'];
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_evt, ...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        return { ok: false, error: e.message || 'Something went wrong.' };
      }
    });
  }
}

function registerSystemApi() {
  const dir = app.getPath('userData');
  history = new History(path.join(dir, 'history.json'));
  launcher = createLauncher({
    settingsFile: path.join(dir, 'apps.json'),
    openPath: (p) => shell.openPath(p), // resolves to '' on success, or an error message
    pickFile: async ({ title }) => {
      const win = BrowserWindow.getFocusedWindow();
      const mac = process.platform === 'darwin';
      const r = await dialog.showOpenDialog(win, {
        title,
        properties: mac ? ['openFile', 'openDirectory'] : ['openFile'],
        filters: process.platform === 'win32' ? [{ name: 'Application or shortcut', extensions: ['exe', 'lnk'] }, { name: 'All files', extensions: ['*'] }] : undefined,
      });
      return r.canceled ? null : r.filePaths[0];
    },
  });
  const handlers = {
    'history:get': () => ({ ok: true, history: history.list() }),
    'history:clear': () => { history.clear(); return { ok: true, history: [] }; },
    'history:show': (id) => {
      const item = history.get(id);
      if (!item || !item.filePath) return { ok: false, error: 'That entry has no file location.' };
      if (!fs.existsSync(item.filePath)) return { ok: false, error: 'That file has been moved or deleted.' };
      shell.showItemInFolder(item.filePath);
      return { ok: true };
    },
    // Load a converted file straight into the Editor (the file is read here, in the main process).
    'history:editor': (id) => {
      const item = history.get(id);
      if (!item || !item.filePath) return { ok: false, error: 'That entry has no file location.' };
      if (!fs.existsSync(item.filePath)) return { ok: false, error: 'That file has been moved or deleted.' };
      if (!editorImport) return { ok: false, error: 'The Editor is not ready yet. Try again in a moment.' };
      return editorImport(fs.readFileSync(item.filePath, 'utf8'), path.basename(item.filePath));
    },
    'apps:status': () => ({ ok: true, status: launcher.status() }),
    'apps:launch': (key) => launcher.launch(key),
    'apps:choose': (key) => launcher.choose(key),
    'apps:clear': (key) => launcher.clear(key),
  };
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_evt, ...args) => {
      try { return await fn(...args); } catch (e) { return { ok: false, error: e.message || 'Something went wrong.' }; }
    });
  }
}

// Settings > Data & Backup. Needs the vault, history and launcher, so it is registered after both of them exist.
function registerDataApi() {
  const service = createBackupService({
    vault, history, launcher,
    showSave: async ({ defaultPath, ext }) => {
      const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
        title: 'Save backup', defaultPath, filters: [{ name: 'AIO Studio backup', extensions: [ext] }],
      });
      return canceled ? null : filePath;
    },
    showOpen: async ({ ext }) => {
      const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
        title: 'Choose a backup file', properties: ['openFile'],
        filters: [{ name: 'AIO Studio backup', extensions: [ext] }, { name: 'All files', extensions: ['*'] }],
      });
      return r.canceled ? null : r.filePaths[0];
    },
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, text) => fs.writeFileSync(p, text, { encoding: 'utf8', mode: 0o600 }),
    onChange: () => { lastResult = null; if (resetBuilderDraft) resetBuilderDraft(); }, // also drop a converted file waiting to be saved
  });
  for (const [channel, fn] of Object.entries(service)) {
    ipcMain.handle(channel, async (_evt, ...args) => {
      try { return await fn(...args); } catch (e) { return { ok: false, error: e.message || 'Something went wrong.' }; }
    });
  }
}

app.whenReady().then(() => {
  registerSystemApi();
  registerVaultApi();
  registerDataApi();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
