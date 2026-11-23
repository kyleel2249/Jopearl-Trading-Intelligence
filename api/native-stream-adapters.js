const finite=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
export function buildNativeStreamConfig(exchangeId,market){
 const id=String(market?.id||'').trim();if(!id||market?.spot!==true)return null;
 if(exchangeId==='binance')return{exchange:exchangeId,url:'wss://stream.binance.com:9443/ws/'+id.toLowerCase()+'@ticker',subscribe:null,heartbeat:null};
 if(exchangeId==='bybit')return{exchange:exchangeId,url:'wss://stream.bybit.com/v5/public/spot',subscribe:{op:'subscribe',args:['tickers.'+id]},heartbeat:{op:'ping'}};
 if(exchangeId==='okx')return{exchange:exchangeId,url:'wss://ws.okx.com:8443/ws/v5/public',subscribe:{op:'subscribe',args:[{channel:'tickers',instId:id}]},heartbeat:'ping'};
 if(exchangeId==='bitget')return{exchange:exchangeId,url:'wss://ws.bitget.com/v2/ws/public',subscribe:{op:'subscribe',args:[{instType:'SPOT',channel:'ticker',instId:id}]},heartbeat:'ping'};
 return null;
}
export function parseNativeTicker(exchangeId,raw,symbol,receivedAt=Date.now()){
 let message;try{message=typeof raw==='string'?JSON.parse(raw):raw;}catch{return null;}
 if(!message||typeof message!=='object')return null;
 let row=null,timestamp=null,last=null,bid=null,ask=null,baseVolume=null,quoteVolume=null,changePct=null;
 if(exchangeId==='binance'&&message.e==='24hrTicker'){
  row=message;timestamp=finite(message.E);last=finite(message.c);bid=finite(message.b);ask=finite(message.a);baseVolume=finite(message.v);quoteVolume=finite(message.q);changePct=finite(message.P);
 }else if(exchangeId==='bybit'&&String(message.topic||'').startsWith('tickers.')){
  row=Array.isArray(message.data)?message.data[0]:message.data;if(!row)return null;timestamp=finite(message.ts);last=finite(row.lastPrice);bid=finite(row.bid1Price);ask=finite(row.ask1Price);baseVolume=finite(row.volume24h);quoteVolume=finite(row.turnover24h);changePct=finite(row.price24hPcnt);if(changePct!==null)changePct*=100;
 }else if(exchangeId==='okx'&&message.arg?.channel==='tickers'){
  row=Array.isArray(message.data)?message.data[0]:null;if(!row)return null;timestamp=finite(row.ts);last=finite(row.last);bid=finite(row.bidPx);ask=finite(row.askPx);baseVolume=finite(row.vol24h);quoteVolume=finite(row.volCcy24h);
 }else if(exchangeId==='bitget'&&message.arg?.channel==='ticker'){
  row=Array.isArray(message.data)?message.data[0]:null;if(!row)return null;timestamp=finite(row.ts);last=finite(row.lastPr);bid=finite(row.bidPr);ask=finite(row.askPr);baseVolume=finite(row.baseVolume);quoteVolume=finite(row.quoteVolume);changePct=finite(row.change24h);if(changePct!==null)changePct*=100;
 }else return null;
 if(!(last>0))return null;
 const observedAt=timestamp!==null?new Date(timestamp).toISOString():null;
 return{exchange:exchangeId,symbol,last,bid,ask,baseVolume,quoteVolume,changePct,observedAt,
  receivedAt:new Date(receivedAt).toISOString(),stale:timestamp===null||receivedAt-timestamp>30000,transport:'native-websocket'};
}
