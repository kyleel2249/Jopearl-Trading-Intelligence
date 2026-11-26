// Output quality guard for AI agents. Detects replies that are raw JSON (or carry JSON noise
// inside prose), retries ONCE with an explicit rewrite instruction, and finally falls back to
// the deterministic formatter so an operator never sees raw JSON. Pure and runtime-agnostic:
// the model call is injected, so it is testable without Workers AI.
import { extractJson, humanizeAgentOutput } from './agent-report.js';

export const REPAIR_PROMPT = 'Your previous reply contained raw JSON, code or key names. Rewrite it as clear, plain-English prose a non-technical operator can read directly. Keep every fact, caveat and uncertainty. Use short paragraphs and "-" bullet points. Do not output JSON, braces, quotation-wrapped keys or code fences.';
export const STRUCTURED_REPAIR_PROMPT = 'Your previous reply was not valid JSON for the required schema. Reply again with ONLY one valid JSON object using exactly the requested keys, and write every string value as plain-English sentences (no nested JSON or key names inside strings).';

const KEY_NOISE = /"[A-Za-z_][\w-]{0,40}"\s*:/g;

// Prose is "readable" when it is not itself a JSON document and is not littered with JSON keys.
export function assessReadability(text) {
  const value = String(text ?? '').trim();
  if (!value) return { readable: false, reasons: ['empty'] };
  const parsed = extractJson(value);
  const stripped = value.replace(/^```(?:json)?\s*/i, '');
  if (parsed !== undefined) {
    if (stripped.startsWith('{') || stripped.startsWith('[')) return { readable: false, reasons: ['json-document'] };
    // JSON embedded in prose: unreadable only when the JSON dominates the reply.
    const jsonLength = JSON.stringify(parsed).length;
    if (jsonLength >= value.length * 0.5) return { readable: false, reasons: ['embedded-json'] };
  }
  if ((value.match(KEY_NOISE) || []).length >= 4) return { readable: false, reasons: ['key-noise'] };
  return { readable: true, reasons: [] };
}

// For schema-constrained agents: strings inside the parsed object must themselves be prose.
export function assessStructuredStrings(structured) {
  const reasons = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 6) return;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && extractJson(trimmed) !== undefined) reasons.add('nested-json');
    } else if (Array.isArray(value)) value.forEach((item) => visit(item, depth + 1));
    else if (value && typeof value === 'object') Object.values(value).forEach((item) => visit(item, depth + 1));
  };
  visit(structured);
  return { readable: reasons.size === 0, reasons: [...reasons] };
}

const textOf = (result) => (typeof result === 'string' ? result : result?.response ?? result?.result?.response ?? (result && typeof result === 'object' ? result : ''));

// generate(messages) -> raw model result. Returns { text, structured, attempts, repaired, fellBack, reasons }.
export async function guardedGeneration({ generate, messages, mode = 'prose', maxRetries = 1 }) {
  let conversation = messages;
  let attempts = 0;
  let lastText = '';
  let lastStructured = null;
  const reasons = [];
  for (let round = 0; round <= maxRetries; round += 1) {
    attempts += 1;
    const raw = textOf(await generate(conversation));
    lastText = typeof raw === 'string' ? raw : humanizeAgentOutput(raw);
    if (mode === 'structured') {
      const parsed = extractJson(lastText);
      lastStructured = parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? parsed : null;
      const verdict = lastStructured ? assessStructuredStrings(lastStructured) : { readable: false, reasons: ['invalid-json'] };
      if (verdict.readable) return { text: lastText, structured: lastStructured, attempts, repaired: attempts > 1, fellBack: false, reasons };
      reasons.push(...verdict.reasons);
      // Prose that merely is not JSON is acceptable for a structured agent after one retry.
      if (round < maxRetries) conversation = [...messages, { role: 'assistant', content: lastText.slice(0, 6000) }, { role: 'user', content: STRUCTURED_REPAIR_PROMPT }];
    } else {
      const verdict = assessReadability(lastText);
      if (verdict.readable) return { text: lastText, structured: null, attempts, repaired: attempts > 1, fellBack: false, reasons };
      reasons.push(...verdict.reasons);
      if (round < maxRetries) conversation = [...messages, { role: 'assistant', content: lastText.slice(0, 6000) }, { role: 'user', content: REPAIR_PROMPT }];
    }
  }
  return { text: lastText, structured: lastStructured, attempts, repaired: false, fellBack: true, reasons: [...new Set(reasons)] };
}

// Aggregates quality rows (one per guarded call) into per-agent reliability stats.
export function summarizeQuality(rows) {
  const byAgent = new Map();
  for (const row of rows || []) {
    const key = row.agentKey || 'unknown';
    const entry = byAgent.get(key) || { agentKey: key, calls: 0, clean: 0, repaired: 0, fellBack: 0 };
    entry.calls += 1;
    if (row.outcome === 'clean') entry.clean += 1; else if (row.outcome === 'repaired') entry.repaired += 1; else entry.fellBack += 1;
    byAgent.set(key, entry);
  }
  return [...byAgent.values()].map((e) => ({ ...e, cleanRate: e.calls ? Number((e.clean / e.calls).toFixed(3)) : 0 })).sort((a, b) => b.fellBack - a.fellBack || a.cleanRate - b.cleanRate);
}

export const outcomeOf = (result) => (result.fellBack ? 'fallback' : result.repaired ? 'repaired' : 'clean');
