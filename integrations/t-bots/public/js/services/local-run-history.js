// Local run history for the integrated T-Bots workspace.
// Uses bounded localStorage persistence; no external database or hosting service.
export class LocalRunHistory {
  constructor(storage = globalThis.localStorage, key = 'jpti.tbots.run-history.v1', limit = 50) {
    this.storage = storage;
    this.key = key;
    this.limit = Math.max(1, Math.min(200, Number(limit) || 50));
    this.enabled = Boolean(storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function');
  }
  async saveRun(run) {
    if (!this.enabled) throw new Error('Local run history is unavailable in this browser.');
    if (!run || typeof run !== 'object' || !run.runId) throw new Error('A valid runId is required.');
    let history = [];
    try { const parsed = JSON.parse(this.storage.getItem(this.key) || '[]'); if (Array.isArray(parsed)) history = parsed; } catch { history = []; }
    const next = [{ ...run, savedAt: new Date().toISOString() }, ...history.filter(item => item?.runId !== run.runId)].slice(0, this.limit);
    this.storage.setItem(this.key, JSON.stringify(next));
    return { saved: true, count: next.length, storage: 'local' };
  }
  async listRuns() {
    if (!this.enabled) return [];
    try { const parsed = JSON.parse(this.storage.getItem(this.key) || '[]'); return Array.isArray(parsed) ? parsed.slice(0, this.limit) : []; } catch { return []; }
  }
}
