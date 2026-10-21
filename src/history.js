'use strict';
// Recently converted files: a small JSON list (newest first). Stores file names and counts only, never file contents.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class History {
  constructor(file, max = 15) {
    this.file = file;
    this.max = max;
    this.items = [];
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(d.items)) this.items = d.items.filter((i) => i && i.id && i.fileName).slice(0, max);
    } catch (e) { /* no history yet */ }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ items: this.items }), 'utf8');
    } catch (e) { /* history is best-effort */ }
  }

  add({ fileName, fromLabel, toLabel, count, filePath }) {
    this.items.unshift({
      id: crypto.randomUUID(), at: new Date().toISOString(),
      fileName: String(fileName), fromLabel: String(fromLabel || ''), toLabel: String(toLabel || ''),
      count: Number(count) || 0, filePath: String(filePath || ''),
    });
    this.items = this.items.slice(0, this.max);
    this._save();
  }

  // Used by Restore: swap the whole list.
  replace(items) {
    this.items = (Array.isArray(items) ? items : []).filter((i) => i && i.id && i.fileName).slice(0, this.max).map((i) => ({ ...i }));
    this._save();
  }

  list() { return this.items.map((i) => ({ ...i })); }
  get(id) { return this.items.find((i) => i.id === String(id)) || null; }
  clear() { this.items = []; this._save(); }
}

module.exports = { History };
