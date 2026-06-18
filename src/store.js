'use strict';

const fs = require('fs');
const path = require('path');

/**
 * A tiny JSON file store for ReqLab's persisted data: collections,
 * environments, and request history. Everything lives in a single
 * `store.json` so it's trivial to back up or move.
 */
class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'store.json');
    this.defaults = { collections: [], environments: [], history: [] };
    this.data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        collections: Array.isArray(parsed.collections) ? parsed.collections : [],
        environments: Array.isArray(parsed.environments) ? parsed.environments : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
      };
    } catch (_err) {
      return JSON.parse(JSON.stringify(this.defaults));
    }
  }

  _persist() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // Persistence problems should never crash the API.
      console.error('[store] failed to persist:', err.message);
    }
  }

  /** Return the full store. */
  getAll() {
    return this.data;
  }

  /**
   * Merge a partial update ({ collections?, environments?, history? }) and
   * persist. Only the provided keys are replaced.
   */
  update(partial) {
    if (!partial || typeof partial !== 'object') return this.data;
    for (const key of ['collections', 'environments', 'history']) {
      if (Array.isArray(partial[key])) this.data[key] = partial[key];
    }
    // Keep history bounded.
    if (this.data.history.length > 200) {
      this.data.history = this.data.history.slice(0, 200);
    }
    this._persist();
    return this.data;
  }
}

module.exports = { Store };
