// Saved AI reports. Stored locally (always) and mirrored to the journal API when reachable.
// Entries carry entryType 'ai-report' so the trade journal can keep them out of trade lists.
export const SAVED_REPORTS_KEY = 'jpti.saved-reports.v1';
export const MAX_SAVED_REPORTS = 200;
const SYMBOL = /\b([A-Z0-9]{2,10})[\/-]?(USDT|USDC|USD|BTC|ETH)\b/;

export const slugify = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'report';

export function buildReportEntry({ title, markdown, source = 'ai-agent', now = new Date(), nonce = Math.random().toString(36).slice(2, 7) }) {
  const body = String(markdown ?? '').trim();
  if (!body) return { error: 'There is no report content to save.' };
  const createdAt = now.toISOString();
  const found = body.match(SYMBOL) || String(title ?? '').toUpperCase().match(SYMBOL);
  const symbol = found ? found[1] + '/' + found[2] : 'JPTI/REPORT';
  return {
    entry: {
      id: ('report-' + slugify(title) + '-' + now.getTime().toString(36) + nonce).slice(0, 100),
      entryType: 'ai-report', date: createdAt.slice(0, 10), createdAt, updatedAt: createdAt,
      symbol, title: String(title || 'AI report').slice(0, 160), source: String(source).slice(0, 60),
      markdown: body.slice(0, 60000), tags: ['ai-report']
    }
  };
}

export const isReportEntry = (entry) => entry?.entryType === 'ai-report';

export function parseSavedReports(raw) {
  try { const value = JSON.parse(raw || '[]'); return Array.isArray(value) ? value.filter((e) => isReportEntry(e) && e.id && e.markdown) : []; } catch { return []; }
}

export function mergeReports(...lists) {
  const map = new Map();
  for (const entry of lists.flat()) if (isReportEntry(entry) && entry.id) { const old = map.get(entry.id); if (!old || String(entry.updatedAt || '') >= String(old.updatedAt || '')) map.set(entry.id, entry); }
  return [...map.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, MAX_SAVED_REPORTS);
}

export function readSavedReports(storage) { try { return parseSavedReports(storage?.getItem(SAVED_REPORTS_KEY)); } catch { return []; } }
export function writeSavedReports(storage, reports) { try { storage?.setItem(SAVED_REPORTS_KEY, JSON.stringify(mergeReports(reports))); return true; } catch { return false; } }

// Saves locally first (never lost), then tries the cloud journal. Returns an honest status.
export async function saveReport({ entry, storage, post }) {
  const local = writeSavedReports(storage, [entry, ...readSavedReports(storage)]);
  if (!local) return { ok: false, local: false, remote: false, message: 'Could not save: device storage is full or unavailable.' };
  if (typeof post !== 'function') return { ok: true, local: true, remote: false, message: 'Saved on this device.' };
  try { await post(entry); return { ok: true, local: true, remote: true, message: 'Saved to the journal and synced to Cloudflare.' }; }
  catch (error) { return { ok: true, local: true, remote: false, message: 'Saved on this device. Cloud sync unavailable: ' + String(error?.message || 'unknown error').slice(0, 120) }; }
}

export function deleteReport(storage, id) { const next = readSavedReports(storage).filter((e) => e.id !== id); writeSavedReports(storage, next); return next; }
