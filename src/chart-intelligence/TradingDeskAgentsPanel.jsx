import React from 'react';
import { ShieldCheck, Target, Activity } from 'lucide-react';

const fmt = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined,{maximumFractionDigits:8}) : '—';
const label = value => String(value || 'unknown').replaceAll('-',' ').toUpperCase();

export default function TradingDeskAgentsPanel({ analysis }) {
  if (!analysis?.profiles?.length) return null;
  return <section className="market-context-panel jpti-trading-desk-agents">
    <div className="market-context-heading"><b>SCALPING & DAY-TRADING AGENT DESKS</b><span>{analysis.version} · {analysis.authority}</span></div>
    <div className="jpti-desk-profile-grid">
      {analysis.profiles.map(profile => <article className="jpti-desk-profile" key={profile.id}>
        <header><div><b>{profile.label}</b><small>{profile.preferredTimeframes.join(' · ')}</small></div><strong className={'jpti-desk-status '+profile.status}>{label(profile.status)}</strong></header>
        <div className="jpti-desk-score"><span>CONSENSUS</span><b>{profile.consensus}/100</b><small>{profile.direction} · minimum {profile.minConsensus}</small></div>
        <div className="jpti-desk-agent-list">{profile.agents.map(agent => <div key={agent.id}><span>{agent.name}</span><b>{agent.score == null ? 'ABSTAIN' : agent.score+'/100'}</b><small>{agent.reason}</small></div>)}</div>
        {profile.blockers.length > 0 && <div className="jpti-desk-blockers"><b><ShieldCheck size={12}/> HARD GATES</b>{profile.blockers.map(item => <small key={item}>{item}</small>)}</div>}
        <footer><Target size={12}/><span>Risk cap {profile.riskPolicy.maxRiskPercent}% · Daily stop {profile.riskPolicy.maxDailyLossPercent}% · Max leverage {profile.riskPolicy.maxLeverage}x</span></footer>
        <p>{profile.rationale}</p>
      </article>)}
    </div>
    <div className="jpti-desk-authority"><Activity size={13}/> GainzAlpha remains the sole signal authority. These specialist desks only qualify paper-review candidates; they cannot place orders or relax risk limits.</div>
  </section>;
}
