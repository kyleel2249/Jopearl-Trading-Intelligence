const WORKSPACES = ['Overview','Spot & Markets','Futures','AI Intelligence','Market Scanner','Financial & On-chain','Portfolio & Ledger','Risk Management','Trading Bots','Universal Engine','Backtesting Lab','Forecast & Strategy','Walk-Forward Lab','News & Events','Connection Settings'];
export function parseTerminalCommand(input, workspaces = WORKSPACES) {
  const raw=String(input||'').trim();
  if(!raw)return {error:'Enter a command. Type HELP for available commands.'};
  const match=raw.match(/^([a-z]+)(?:\s+(.+))?$/i);
  if(!match)return {error:'Invalid command syntax. Type HELP.'};
  const action=match[1].toLowerCase(),value=(match[2]||'').trim();
  if(['help','status','refresh','risk'].includes(action))return value?{error:action.toUpperCase()+' does not accept arguments.'}:{action};
  if(!['open','symbol','watch','unwatch'].includes(action))return {error:'Unknown command "'+action+'". Type HELP.'};
  if(!value)return {error:action.toUpperCase()+' requires an argument.'};
  if(action==='open'){
    const normalized=value.replace(/^["']|["']$/g,'').toLowerCase();
    const found=workspaces.find(name=>name.toLowerCase()===normalized);
    return found?{action,value:found}:{error:'Workspace not found: '+value};
  }
  const symbol=value.toUpperCase().replace('-','/');
  if(!/^[A-Z0-9._]{2,20}\/[A-Z0-9._]{2,20}$/.test(symbol))return {error:'Invalid market. Use BASE/QUOTE, for example BTC/USDT.'};
  return {action,value:symbol};
}
