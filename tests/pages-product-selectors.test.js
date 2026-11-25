import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
const root=fileURLToPath(new URL('..',import.meta.url));
test('market product selectors remain stable in charts and the futures workspace',()=>{
 const dir=join(root,'node_modules','.cache','jpti-tests');mkdirSync(dir,{recursive:true});
 const bundle=join(dir,'product-sync-harness.mjs');
 buildSync({entryPoints:[join(root,'tests/fixtures/product-sync-harness.jsx')],outfile:bundle,bundle:true,format:'esm',platform:'node',packages:'external',loader:{'.css':'empty','.jsx':'jsx'},jsx:'automatic',logLevel:'error'});
 const run=spawnSync(process.execPath,[join(root,'tests/fixtures/product-sync-runner.mjs'),bundle],{cwd:root,encoding:'utf8',timeout:120000});rmSync(bundle,{force:true});
 assert.equal(run.status,0,'selector harness failed: '+(run.stderr||'').slice(0,700)+(run.error?String(run.error):''));
 const payload=JSON.parse(run.stdout.split('RESULT:')[1]);assert.equal(payload.results.length,3);
 for(const scenario of payload.results){assert.ok(scenario.picks.length>=5,scenario.name+' did not exercise all market types');for(const [requested,selected] of scenario.picks)assert.equal(selected,requested,scenario.name+' lost '+requested);}
 assert.equal(payload.notices.filter(x=>/Maximum update depth exceeded/.test(x)).length,0,'React render loop detected');
});
