#!/usr/bin/env node
const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
const options={strategyId:value('--strategy-id')||'trend',exchange:value('--exchange')||'bitget',marketType:value('--market-type')||'usdt-m',symbol:value('--symbol')||'BTC/USDT',timeframe:value('--timeframe')||'1m',submit:args.includes('--submit')};
const base=process.env.JPTI_VALIDATION_URL,token=process.env.JPTI_API_TOKEN;
if(!base||!token){console.error('Set JPTI_VALIDATION_URL and JPTI_API_TOKEN.');process.exit(2);}
const url=base.replace(/\/$/,'')+'/api/paper/validation';
const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-jpti-api-token':token},body:JSON.stringify(options)});
const body=await response.json().catch(()=>({error:'Invalid server response'}));
console.log(JSON.stringify(body,null,2));
if(!response.ok||body.verdict?.passed!==true)process.exit(1);
