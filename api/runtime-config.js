import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

// Runtime configuration is stored separately from every .env file. The encrypted
// payload and its machine-local key live under data/ and are never web-served.
dotenv.config({ path: '.env.local', override: false });
dotenv.config({ path: '.env', override: false });

const CONFIG_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_FILE = path.join(CONFIG_DIR, 'jpti-runtime-config.enc');
const KEY_FILE = path.join(CONFIG_DIR, 'jpti-runtime-config.key');
const ALLOWED_KEY = /^(JPTI_[A-Z0-9_]+|DATABASE_URL|PORT)$/;
const BLOCKED_KEYS = new Set(['JPTI_CONFIG_ENCRYPTION_KEY']);

let activeKeys = [];
let lastLoadedAt = null;

function safeKeys(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw Object.assign(new Error('Configuration variables must be an object.'), { status: 400 });
  }
  const entries = Object.entries(values);
  if (entries.length > 500) throw Object.assign(new Error('A maximum of 500 configuration variables is allowed.'), { status: 400 });
  const clean = {};
  for (const [key, raw] of entries) {
    if (!ALLOWED_KEY.test(key) || BLOCKED_KEYS.has(key)) {
      throw Object.assign(new Error('Unsupported server configuration variable: ' + key), { status: 400 });
    }
    if (raw !== null && typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      throw Object.assign(new Error('Configuration values must be strings, numbers, booleans or null.'), { status: 400 });
    }
    const value = raw == null ? '' : String(raw);
    if (value.length > 12000) throw Object.assign(new Error('Configuration value is too long: ' + key), { status: 400 });
    clean[key] = value;
  }
  return clean;
}

async function getMachineKey() {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    const key = await fs.readFile(KEY_FILE);
    if (key.length !== 32) throw new Error('JPTI runtime configuration key has an invalid length.');
    return key;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const key = crypto.randomBytes(32);
    await fs.writeFile(KEY_FILE, key, { mode: 0o600, flag: 'wx' }).catch(async writeError => {
      if (writeError.code !== 'EEXIST') throw writeError;
    });
    const stored = await fs.readFile(KEY_FILE);
    if (stored.length !== 32) throw new Error('Could not initialize JPTI runtime configuration key.');
    return stored;
  }
}

async function decryptFile() {
  const raw = await fs.readFile(CONFIG_FILE, 'utf8');
  const payload = JSON.parse(raw);
  if (payload.version !== 1 || payload.cipher !== 'aes-256-gcm') throw new Error('Unsupported JPTI runtime configuration format.');
  const key = await getMachineKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
  return safeKeys(JSON.parse(plain.toString('utf8')));
}

export async function loadRuntimeConfig() {
  try {
    const values = await decryptFile();
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    activeKeys = Object.keys(values);
    lastLoadedAt = new Date().toISOString();
    console.info('[JPTI config] Loaded encrypted runtime settings:', activeKeys.length, 'variables.');
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[JPTI config] Runtime settings could not be loaded:', error.message);
  }
}

export function getRuntimeConfigStatus() {
  return {
    storage: 'encrypted-local-runtime-config',
    configured: activeKeys.length > 0,
    variableCount: activeKeys.length,
    variableNames: [...activeKeys].sort(),
    loadedAt: lastLoadedAt,
    restartRequiredAfterSave: true,
    envFilesModified: false
  };
}

export function verifyConfigAdminToken(provided) {
  const expected = String(process.env.JPTI_API_TOKEN || '');
  const actual = String(provided || '');
  if (!expected || expected === 'replace-with-a-long-random-secret' || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function saveRuntimeConfig(input) {
  const incoming = safeKeys(input);
  let existing = {};
  try { existing = await decryptFile(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const values = safeKeys({ ...existing, ...incoming });
  const key = await getMachineKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
  const payload = {
    version: 1,
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
    updatedAt: new Date().toISOString()
  };
  const temp = CONFIG_FILE + '.tmp';
  await fs.writeFile(temp, JSON.stringify(payload), { mode: 0o600 });
  await fs.rename(temp, CONFIG_FILE);
  for (const [keyName, value] of Object.entries(values)) process.env[keyName] = value;
  activeKeys = Object.keys(values);
  return getRuntimeConfigStatus();
}

await loadRuntimeConfig();
