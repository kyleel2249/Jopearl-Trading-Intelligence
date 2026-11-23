// scripts/build-env.mjs - writes public/env.js from safe browser configuration.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trim().startsWith('#') && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}
const env = { llmProxyUrl: process.env.LLM_PROXY_URL || '' };
writeFileSync('public/env.js', `window.GROKBOT_ENV = ${JSON.stringify(env, null, 2)};\n`);
console.log(`public/env.js written (Cloudflare LLM proxy: ${env.llmProxyUrl ? 'on' : 'off'})`);
