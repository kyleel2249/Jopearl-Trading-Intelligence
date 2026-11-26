// Turns structured AI-agent output (JSON objects, JSON strings, fenced JSON blocks) into
// plain, human-readable text. Pure and dependency-free so it runs in the browser, in
// Cloudflare Pages Functions and in Node tests. Nothing is discarded: every populated
// field is rendered, and callers keep the original structured data for programmatic use.

const MAX_DEPTH = 6;
const ACRONYMS = new Set(['id', 'ids', 'url', 'urls', 'api', 'ai', 'usd', 'usdt', 'pnl', 'roi', 'rsi', 'atr', 'ema', 'sma', 'smc', 'ohlcv', 'kpi', 'kpis', 'utc', 'btc', 'eth']);

export function labelFromKey(key) {
  const words = String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '';
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

function formatScalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
  }
  return String(value).trim();
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isEmpty = (value) => value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.keys(value).length === 0);

function renderValue(value, indent, depth) {
  const pad = '  '.repeat(indent);
  if (depth > MAX_DEPTH) return [pad + '(further detail omitted)'];
  if (Array.isArray(value)) {
    const lines = [];
    for (const item of value) {
      if (isEmpty(item)) continue;
      if (isPlainObject(item)) {
        const entries = Object.entries(item).filter(([, v]) => !isEmpty(v));
        if (!entries.length) continue;
        const [firstKey, firstValue] = entries[0];
        const firstIsScalar = !isPlainObject(firstValue) && !Array.isArray(firstValue);
        lines.push(pad + '• ' + (firstIsScalar ? labelFromKey(firstKey) + ': ' + formatScalar(firstValue) : labelFromKey(firstKey) + ':'));
        if (!firstIsScalar) lines.push(...renderValue(firstValue, indent + 2, depth + 1));
        for (const [key, entry] of entries.slice(1)) lines.push(...renderEntry(key, entry, indent + 1, depth + 1));
      } else if (Array.isArray(item)) {
        lines.push(pad + '•');
        lines.push(...renderValue(item, indent + 1, depth + 1));
      } else {
        lines.push(pad + '• ' + formatScalar(item));
      }
    }
    return lines;
  }
  if (isPlainObject(value)) {
    const lines = [];
    for (const [key, entry] of Object.entries(value)) {
      if (!isEmpty(entry)) lines.push(...renderEntry(key, entry, indent, depth));
    }
    return lines;
  }
  return [pad + formatScalar(value)];
}

function renderEntry(key, value, indent, depth) {
  const pad = '  '.repeat(indent);
  if (isPlainObject(value) || Array.isArray(value)) {
    return [pad + labelFromKey(key) + ':', ...renderValue(value, indent + 1, depth + 1)];
  }
  return [pad + labelFromKey(key) + ': ' + formatScalar(value)];
}

// Extracts the first balanced JSON object/array from text that may be wrapped in
// Markdown code fences or surrounded by explanatory prose. Returns undefined if none parses.
export function extractJson(input) {
  if (typeof input !== 'string') return undefined;
  const text = input.trim();
  if (!text) return undefined;
  const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  const candidates = [fenced ? fenced[1].trim() : null, text].filter(Boolean);
  for (const candidate of candidates) {
    const direct = tryParse(candidate);
    if (direct !== undefined) return direct;
    for (const open of ['{', '[']) {
      const close = open === '{' ? '}' : ']';
      const start = candidate.indexOf(open);
      if (start < 0) continue;
      let depth = 0; let inString = false; let escaped = false;
      for (let i = start; i < candidate.length; i += 1) {
        const ch = candidate[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === open) depth += 1;
        else if (ch === close) {
          depth -= 1;
          if (depth === 0) {
            const parsed = tryParse(candidate.slice(start, i + 1));
            if (parsed !== undefined) return parsed;
            break;
          }
        }
      }
    }
  }
  return undefined;
}

function tryParse(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

const SECTION_TITLES = [
  ['summary', 'Summary'],
  ['findings', 'Key findings'],
  ['evidence', 'Evidence'],
  ['risks', 'Risks'],
  ['nextActions', 'Recommended next steps'],
  ['handoffs', 'Handoffs to other departments']
];

// Renders the JPTI specialist-agent schema (summary, findings, evidence, risks, nextActions,
// handoffs) as titled sections; any additional keys are appended rather than dropped.
export function formatAgentReport(report) {
  if (!isPlainObject(report)) return humanizeAgentOutput(report);
  const known = new Set(SECTION_TITLES.map(([key]) => key));
  const blocks = [];
  for (const [key, title] of SECTION_TITLES) {
    const value = report[key];
    if (isEmpty(value)) continue;
    const body = isPlainObject(value) || Array.isArray(value) ? renderValue(value, 0, 0).join('\n') : formatScalar(value);
    if (body) blocks.push(title + '\n' + body);
  }
  const extras = Object.entries(report).filter(([key, value]) => !known.has(key) && !isEmpty(value));
  if (extras.length) blocks.push(extras.flatMap(([key, value]) => renderEntry(key, value, 0, 0)).join('\n'));
  return blocks.join('\n\n');
}

// Universal entry point. Strings that are plain prose pass through unchanged; strings that
// contain JSON and raw objects/arrays become readable text.
export function humanizeAgentOutput(input) {
  if (input === null || input === undefined) return '';
  let value = input;
  if (typeof input === 'string') {
    const parsed = extractJson(input);
    if (parsed === undefined) return input.trim();
    const stripped = input.trim();
    const wholeIsJson = stripped.startsWith('{') || stripped.startsWith('[') || /^```/.test(stripped);
    if (!wholeIsJson) {
      // Prose that merely embeds JSON: keep the prose, render the embedded block readably.
      const start = Math.min(...['{', '['].map((c) => stripped.indexOf(c)).filter((i) => i >= 0));
      return (stripped.slice(0, start).trim() + '\n\n' + humanizeAgentOutput(parsed)).trim();
    }
    value = parsed;
  }
  if (isPlainObject(value) && SECTION_TITLES.some(([key]) => key in value) && ('summary' in value || 'findings' in value)) {
    return formatAgentReport(value);
  }
  if (isPlainObject(value) || Array.isArray(value)) return renderValue(value, 0, 0).join('\n');
  return formatScalar(value);
}

// One-line variant for compact UI rows (parameters, anomalies, tags).
export function summarizeInline(value, limit = 160) {
  const text = humanizeAgentOutput(value).split('\n').map((line) => line.replace(/^\s*•\s*/, '').trim()).filter(Boolean).join(' · ');
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

// Markdown form of an agent report for rich rendering, copying and export. Section titles
// become headings and bullets use Markdown syntax; prose that is already Markdown (for
// example the mentor review) is returned unchanged.
export function agentReportToMarkdown(input) {
  const text = humanizeAgentOutput(input);
  const titles = new Set(SECTION_TITLES.map(([, title]) => title));
  return text.split('\n').map((line) => {
    if (titles.has(line.trim())) return '## ' + line.trim();
    return line.replace(/^(\s*)•\s?/, '$1- ');
  }).join('\n');
}
