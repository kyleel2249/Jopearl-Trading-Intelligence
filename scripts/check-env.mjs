import fs from 'node:fs';
import path from 'node:path';
const loaded = {};
for (const file of ['.env.local','.env.development','.env.development.local','.env.production','.env.production.local']) {
 const full=path.join(process.cwd(),file); if(!fs.existsSync(full)) continue;
 for(const line of fs.readFileSync(full,'utf8').split(/\r?\n/)){const m=line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);if(!m||line.trim().startsWith('#'))continue;loaded[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');}
}
for(const [k,v] of Object.entries(process.env)) if(k.startsWith('VITE_')||k==='JPTI_DEPLOY_TARGET') loaded[k]=v;
const errors=[],warnings=[];
for(const [key,value] of Object.entries(loaded)) if(/^VITE_.*(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|SERVICE_ACCOUNT|API_KEY)$/i.test(key)&&value)errors.push(key+' appears secret-bearing and would be exposed in client build.');
const api=loaded.VITE_API_BASE_URL||'', target=loaded.JPTI_DEPLOY_TARGET||'';
if(!api){warnings.push('VITE_API_BASE_URL is unset: Cloudflare Pages uses its same-origin /api/* Functions runtime. Native Android builds should set CLOUDFLARE_PAGES_URL as the public Pages origin.');}
else {try{const u=new URL(api),local=['localhost','127.0.0.1','[::1]'].includes(u.hostname);if(u.username||u.password||u.search||u.hash||u.pathname!=='/')errors.push('VITE_API_BASE_URL must be an origin only.');if(u.protocol!=='https:'&&!(local&&u.protocol==='http:'))errors.push('VITE_API_BASE_URL must use HTTPS.');}catch{errors.push('VITE_API_BASE_URL must be a valid absolute URL.');}}
const ws=loaded.VITE_WS_URL||'';if(ws&&!/^wss:\/\//i.test(ws)&&!/^ws:\/\/localhost(?::|$)/i.test(ws))errors.push('VITE_WS_URL must use WSS except local development.');
console.log('JPTI env check: inspected '+Object.keys(loaded).length+' frontend variable(s).');
warnings.forEach(x=>console.warn('WARN:',x));errors.forEach(x=>console.error('ERROR:',x));
if(errors.length)process.exit(1);console.log('Environment validation passed.');
