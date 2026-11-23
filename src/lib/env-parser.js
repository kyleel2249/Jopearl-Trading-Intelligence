// Local-only environment file parsing for the JPTI Connection Manager.
// Uploaded files are read in the browser; nothing here performs network I/O.

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGN = /^\s*(?:export\s+)?([^=\s#][^=\s]*)\s*=\s?(.*)$/;
const SECRET_NAME = /(API_?KEY|SECRET|PASSWORD|PASSPHRASE|TOKEN|PRIVATE|CREDENTIAL|DATABASE_URL|SERVICE_ACCOUNT|_KEY$|^KEY$)/i;

export const MAX_ENV_FILE_BYTES = 1024 * 1024;

export function isSensitiveKey(name) {
  return SECRET_NAME.test(String(name || ''));
}

function unescapeDouble(text) {
  return text.replace(/\\(n|r|t|"|\\)/g, (_m, c) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' }[c]));
}

// Finds the closing quote of a quoted value that starts at lines[index]. Quoted
// values may span lines (private keys, certificates).
function readQuoted(lines, index, rest) {
  const quote = rest[0];
  let buffer = rest.slice(1);
  let line = index;
  for (;;) {
    let i = 0;
    while (i < buffer.length) {
      if (quote === '"' && buffer[i] === '\\') { i += 2; continue; }
      if (buffer[i] === quote) {
        const raw = buffer.slice(0, i);
        const tail = buffer.slice(i + 1).trim();
        return { raw, tail, endLine: line, closed: true, quote };
      }
      i += 1;
    }
    if (line + 1 >= lines.length) return { raw: buffer, tail: '', endLine: line, closed: false, quote };
    line += 1;
    buffer += '\n' + lines[line];
  }
}

export function parseEnv(source) {
  const text = String(source ?? '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const entries = [];
  const issues = [];
  const seen = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const original = lines[index];
    const trimmed = original.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = ASSIGN.exec(original);
    if (!match) {
      issues.push({ line: index + 1, code: 'unparseable', message: 'Line is not in KEY=value form and was skipped.' });
      continue;
    }
    const key = match[1];
    if (!KEY.test(key)) {
      issues.push({ line: index + 1, key, code: 'invalid-name', message: '"' + key + '" is not a valid environment variable name and was skipped.' });
      continue;
    }
    let rest = match[2].replace(/^\s+/, '');
    let value;
    let endLine = index;
    if (rest[0] === '"' || rest[0] === "'" || rest[0] === '`') {
      const quoted = readQuoted(lines, index, rest);
      value = quoted.quote === '"' ? unescapeDouble(quoted.raw) : quoted.raw;
      endLine = quoted.endLine;
      if (!quoted.closed) issues.push({ line: index + 1, key, code: 'unterminated-quote', message: 'Quoted value for ' + key + ' is missing its closing quote; the rest of the file was consumed.' });
      else if (quoted.tail && !quoted.tail.startsWith('#')) issues.push({ line: index + 1, key, code: 'trailing-text', message: 'Unexpected text after the closing quote of ' + key + ' was ignored.' });
    } else {
      value = rest.replace(/\s+#.*$/, '').trim();
    }
    entries.push({ key, value, line: index + 1 });
    const lineList = seen.get(key) || [];
    lineList.push(index + 1);
    seen.set(key, lineList);
    index = endLine;
  }

  const values = {};
  for (const entry of entries) values[entry.key] = entry.value; // last definition wins
  const duplicates = {};
  for (const [key, lineList] of seen) if (lineList.length > 1) duplicates[key] = lineList;
  return { values, entries, duplicates, issues, count: Object.keys(values).length };
}

export function serializeEnv(values) {
  return Object.entries(values || {}).map(([key, raw]) => {
    const value = raw == null ? '' : String(raw);
    if (value === '') return key + '=';
    if (/[\s#"'`\\\n\r]/.test(value) || /^\s|\s$/.test(value)) {
      return key + '="' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
    }
    return key + '=' + value;
  }).join('\n') + '\n';
}

// Rejects oversized or binary uploads before any parsing.
export function inspectUpload({ name = '', size = 0, text = '' } = {}) {
  if (size > MAX_ENV_FILE_BYTES || text.length > MAX_ENV_FILE_BYTES) return { ok: false, error: 'Configuration files must be smaller than 1 MB.' };
  if (text.includes('\u0000')) return { ok: false, error: name + ' looks like a binary file, not a text configuration file.' };
  return { ok: true };
}

export const maskSecret = (value) => (value ? '\u2022'.repeat(8) : '');

// Removes known secret values from free text (error messages, logs, reports).
export function redactText(text, secrets = []) {
  let output = String(text ?? '');
  for (const secret of secrets) {
    const s = String(secret ?? '');
    if (s.length >= 6) output = output.split(s).join('[redacted]');
  }
  return output.replace(/((?:api[_-]?key|apikey|token|access_token|secret)=)[^&\s"']+/gi, '$1[redacted]');
}

// Compares two variable maps without exposing values: returns key names only.
export function diffVariables(before = {}, after = {}) {
  const added = [], removed = [], changed = [];
  for (const key of Object.keys(after)) {
    if (!(key in before)) added.push(key);
    else if (before[key] !== after[key]) changed.push(key);
  }
  for (const key of Object.keys(before)) if (!(key in after)) removed.push(key);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}
