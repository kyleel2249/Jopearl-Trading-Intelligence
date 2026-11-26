import test from 'node:test';
import assert from 'node:assert/strict';
import {createDirectProvider} from '../src/lib/browser-direct.js';
const contract=(symbol,quoteCoin,marginCoin)=>({symbol,baseCoin:'BTC',quoteCoin,supportMarginCoins:[marginCoin],symbolStatus:'normal',symbolType:'perpetual',pricePlace:'1',volumePlace:'3',minTradeNum:'0.001',maxLever:'100'});
test('Bitget market catalog falls back from unavailable v3 instruments to current v2 public catalog endpoints',async()=>{
 const calls=[];
 const fetchImpl=async(url)=>{
  const u=new URL(url);calls.push(u.pathname+u.search);
  if(u.pathname==='/api/v3/market/instruments')return new Response(JSON.stringify({code:'404',msg:'route unavailable'}),{status:404,headers:{'content-type':'application/json'}});
  let data=[];
  if(u.pathname==='/api/v2/spot/public/symbols')data=[{symbol:'BTCUSDT',baseCoin:'BTC',quoteCoin:'USDT',status:'online',pricePrecision:'2',quantityPrecision:'6'}];
  else if(u.pathname==='/api/v2/margin/currencies')data=[{symbol:'BTCUSDT',baseCoin:'BTC',quoteCoin:'USDT',status:'1',pricePrecision:'2',quantityPrecision:'6'}];
  else if(u.pathname==='/api/v2/mix/market/contracts'){
   const product=u.searchParams.get('productType');
   data=product==='COIN-FUTURES'?[contract('BTCUSD','USD','BTC')]:product==='USDC-FUTURES'?[contract('BTCUSDC','USDC','USDC')]:[contract('BTCUSDT','USDT','USDT')];
  }
  return new Response(JSON.stringify({code:'00000',msg:'success',data}),{status:200,headers:{'content-type':'application/json'}});
 };
 const provider=createDirectProvider({fetchImpl});
 for(const type of ['spot','margin','usdt-futures','coin-futures','usdc-futures']){
  const result=await provider.request('/api/exchanges/bitget/markets?type='+type+'&search=BTC');
  assert.equal(result.status,200,type);
  assert.equal(result.body.count,1,type);
  assert.equal(result.body.markets[0].catalogueApiVersion,'v2',type);
 }
 assert.ok(calls.includes('/api/v2/spot/public/symbols'));
 assert.ok(calls.includes('/api/v2/margin/currencies'));
 for(const product of ['USDT-FUTURES','COIN-FUTURES','USDC-FUTURES'])assert.ok(calls.includes('/api/v2/mix/market/contracts?productType='+product));
});

test('Bitget catalog retries 404 through the documented legacy capi domain',async()=>{
 const hosts=[];
 const provider=createDirectProvider({fetchImpl:async url=>{
  const u=new URL(url);hosts.push(u.hostname);
  if(u.hostname==='capi.bitget.com'&&u.pathname==='/api/v2/spot/public/symbols')
   return new Response(JSON.stringify({code:'00000',data:[{symbol:'BTCUSDT',baseCoin:'BTC',quoteCoin:'USDT',status:'online'}]}),{status:200,headers:{'content-type':'application/json'}});
  return new Response(JSON.stringify({code:'404',msg:'route unavailable'}),{status:404,headers:{'content-type':'application/json'}});
 }});
 const result=await provider.request('/api/exchanges/bitget/markets?type=spot&search=BTC');
 assert.equal(result.status,200);
 assert.equal(result.body.count,1);
 assert.ok(hosts.includes('capi.bitget.com'));
});
