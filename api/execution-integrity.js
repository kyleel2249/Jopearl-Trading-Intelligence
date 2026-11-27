import { createHash } from 'node:crypto';

const STATES = new Set(['created','submitted','acknowledged','partially_filled','filled','cancel_pending','cancelled','rejected','unknown','reconciliation_required']);
const TRANSITIONS = Object.freeze({
  created:['submitted','rejected'], submitted:['acknowledged','partially_filled','filled','cancel_pending','cancelled','rejected','unknown','reconciliation_required'],
  acknowledged:['partially_filled','filled','cancel_pending','cancelled','rejected','unknown','reconciliation_required'],
  partially_filled:['partially_filled','filled','cancel_pending','cancelled','unknown','reconciliation_required'],
  cancel_pending:['cancelled','partially_filled','filled','unknown','reconciliation_required'],
  unknown:['acknowledged','partially_filled','filled','cancelled','rejected','reconciliation_required'],
  reconciliation_required:['acknowledged','partially_filled','filled','cancelled','rejected','unknown'],
  filled:[],cancelled:[],rejected:[]
});
const canonical = value => {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Non-finite values cannot be fingerprinted.');
  return JSON.stringify(value);
};
export function createOrderIdempotencyKey(order={}) {
  const required=['accountId','venue','symbol','side','type','quantity'];
  for(const key of required) if(order[key]===undefined||order[key]===null||String(order[key]).trim()==='') throw new TypeError('Missing idempotency field: '+key);
  const decimal=value=>{const n=Number(value);if(!Number.isFinite(n)||n<=0)throw new TypeError('Order quantity and prices must be positive finite numbers.');return String(n);};
  const normalized={accountId:String(order.accountId),venue:String(order.venue).toLowerCase(),symbol:String(order.symbol).toUpperCase(),side:String(order.side).toLowerCase(),type:String(order.type).toLowerCase(),quantity:decimal(order.quantity),price:order.price==null?null:decimal(order.price),stopPrice:order.stopPrice==null?null:decimal(order.stopPrice),clientIntentId:String(order.clientIntentId||'')};
  return 'jpti_'+createHash('sha256').update(canonical(normalized)).digest('hex');
}
export function transitionExecutionState(current,next) {
  if(!STATES.has(current)||!STATES.has(next)) return {accepted:false,state:current||'unknown',reason:'invalid_state'};
  if(current===next) return {accepted:true,state:current,idempotent:true};
  if(!TRANSITIONS[current].includes(next)) return {accepted:false,state:current,reason:'illegal_transition'};
  return {accepted:true,state:next,idempotent:false};
}
export function assessExecutionRecovery({localOrder={},exchangeOrder=null,lookupCompleted=false,now=Date.now(),submittedAt=null,retryAfterMs=30000}={}) {
  const localState=STATES.has(localOrder.status)?localOrder.status:'unknown';
  if(exchangeOrder) {
    const remote=String(exchangeOrder.status||'').toLowerCase();
    const mapped=({open:'acknowledged',new:'acknowledged',pending:'acknowledged',partially_filled:'partially_filled',closed:'filled',filled:'filled',canceled:'cancelled',cancelled:'cancelled',rejected:'rejected'})[remote];
    if(!mapped) return {action:'manual_review',state:'reconciliation_required',reason:'unrecognized_exchange_state',resubmit:false};
    const transition=transitionExecutionState(localState,mapped);
    return {action:transition.accepted?'adopt_exchange_state':'manual_review',state:transition.accepted?mapped:'reconciliation_required',resubmit:false,exchangeOrderId:exchangeOrder.id??null,filled:Number(exchangeOrder.filled)||0,remaining:Number(exchangeOrder.remaining)||0};
  }
  if(!lookupCompleted) return {action:'lookup_required',state:'unknown',resubmit:false,reason:'exchange_absence_not_proven'};
  if(['filled','cancelled','rejected'].includes(localState)) return {action:'terminal_noop',state:localState,resubmit:false};
  const submitted=Date.parse(submittedAt||localOrder.submittedAt||'');
  if(!Number.isFinite(submitted)||now-submitted<retryAfterMs) return {action:'wait_and_reconcile',state:'unknown',resubmit:false,reason:'submission_grace_period'};
  if(!String(localOrder.clientOrderId||'').trim()) return {action:'manual_review',state:'reconciliation_required',resubmit:false,reason:'stable_client_order_id_missing'};
  return {action:'safe_to_recreate_with_same_client_id',state:'reconciliation_required',resubmit:true,clientOrderId:localOrder.clientOrderId,reason:'authoritative_lookup_confirmed_absent'};
}
export function enforceExecutionRisk({riskAssessment={},marketData={},killSwitch=false,duplicateIntent=false,liveTradingEnabled=false,operatorAuthorized=false}={}) {
  const failures=[];
  if(killSwitch) failures.push('kill_switch_active');
  if(duplicateIntent) failures.push('duplicate_intent');
  if(riskAssessment.decision!=='paper_intent_eligible') failures.push('pretrade_risk_not_eligible');
  if(riskAssessment.failedChecks?.length) failures.push('pretrade_checks_failed');
  if(marketData.fresh!==true||marketData.sequenceValid!==true) failures.push('market_data_not_trusted');
  if(!liveTradingEnabled) failures.push('live_trading_disabled');
  if(!operatorAuthorized) failures.push('operator_authorization_missing');
  return {allowed:failures.length===0,failures,executionMode:failures.length?'blocked':'authorized_by_external_policy',ordersCreated:0,statement:'This guard evaluates policy inputs only; it never submits an order or grants exchange permissions.'};
}
