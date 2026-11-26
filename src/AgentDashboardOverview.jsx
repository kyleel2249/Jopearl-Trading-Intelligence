import React, { useCallback, useEffect, useState } from 'react';
import { Activity, BrainCircuit, Building2, Database, RefreshCw, ShieldCheck, Target } from 'lucide-react';
import { apiFetch } from './lib/api.js';
import './AgentDashboardOverview.css';

const DEPARTMENT_NAMES = {
  research: 'Research & Intelligence',
  'trading-social': 'Trading Social Intelligence',
  'general-marketing': 'General Marketing Intelligence'
};
const count = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const stamp = value => value ? new Date(value).toLocaleString() : 'No review recorded';

async function readJson(path) {
  const response = await apiFetch(path, { cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Request failed (HTTP ' + response.status + ')');
    error.status = response.status;
    throw error;
  }
  return payload;
}

export default function AgentDashboardOverview({ activeNav }) {
  const [state, setState] = useState({ catalog: null, overview: null, paper: null, loading: true, error: '', authRequired: false, updatedAt: null });
  const load = useCallback(async () => {
    const [catalogResult, overviewResult, paperResult] = await Promise.allSettled([
      readJson('/api/agents/catalog'),
      readJson('/api/org/overview'),
      readJson('/api/paper/overview')
    ]);
    const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : null;
    const overview = overviewResult.status === 'fulfilled' ? overviewResult.value : null;
    const paper = paperResult.status === 'fulfilled' ? paperResult.value : null;
    const failures = [overviewResult, paperResult, catalogResult].filter(result => result.status === 'rejected');
    const failure = failures[0]?.reason || null;
    setState({
      catalog, overview, paper, loading: false,
      error: failure?.message || '',
      authRequired: failure?.status === 401 || /authori[sz]ation|token/i.test(failure?.message || ''),
      updatedAt: new Date().toISOString()
    });
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, [load]);

  const agents = state.overview?.agents || [];
  const departments = state.overview?.departments || [];
  const missions = state.overview?.missions || [];
  const memory = state.overview?.memory || [];
  const messages = state.overview?.messages || [];
  const reviews = state.overview?.reviews || [];
  const completed = missions.filter(item => item.status === 'completed').length;
  const latestReview = [...reviews].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
  const roster = state.catalog?.agents || [];
  const paperAgents = state.paper?.agents || [];
  const paperOpenTrades = state.paper?.openTrades || [];
  const paperLiveReady = paperAgents.filter(agent => agent.tier === 'LIVE_READY').length;
  const connected = Boolean(state.overview && state.paper);

  return <section className="glass-panel agent-overview-panel">
    <header className="agent-overview-head">
      <div><span className="eyebrow">AUTONOMOUS INTELLIGENCE · DASHBOARD FEED</span><h3>AI agents & department operations</h3><p>Live summary from the Cloudflare-backed agent registry, department missions, shared memory and KPI reviews.</p></div>
      <div className="agent-overview-actions">
        <span className={'agent-overview-status ' + (connected ? 'ready' : state.authRequired ? 'locked' : 'waiting')}><i/>{connected ? 'D1 CONNECTED' : state.authRequired ? 'ACCESS TOKEN REQUIRED' : state.loading ? 'SYNCING' : 'PARTIAL / OFFLINE'}</span>
        <button type="button" onClick={load} disabled={state.loading}><RefreshCw size={13}/>{state.loading ? 'Syncing…' : 'Refresh'}</button>
      </div>
    </header>

    <div className="agent-overview-kpis">
      <article><BrainCircuit/><span>REGISTERED SPECIALISTS</span><b>{state.catalog ? roster.length : '—'}</b><small>Explainable research roles</small></article>
      <article><Building2/><span>DEPARTMENTS</span><b>{state.overview ? departments.length : '—'}</b><small>Research · Trading Social · Marketing</small></article>
      <article><Target/><span>MISSIONS COMPLETED</span><b>{connected ? completed : '—'}</b><small>{connected ? missions.length + ' total recorded missions' : 'Awaiting private department access'}</small></article>
      <article><Database/><span>SHARED MEMORY</span><b>{state.overview ? memory.length : '—'}</b><small>{state.overview ? messages.length + ' interdepartment messages' : 'D1 records are not exposed without access'}</small></article>
      <article><Activity/><span>PAPER AGENT FLEET</span><b>{state.paper ? paperAgents.length : '—'}</b><small>{state.paper ? paperOpenTrades.length + ' open positions · ' + paperLiveReady + ' LIVE_READY (paper-qualified only)' : 'Awaiting private paper-fleet access'}</small></article>
    </div>

    {state.error && <div className="agent-overview-notice" role="status">
      <ShieldCheck size={15}/><span>{state.error}{state.authRequired ? ' Enter the existing JPTI_JOURNAL_TOKEN in Connection Settings and choose Verify access token, then refresh this panel.' : ''}</span>
      {state.authRequired && <button type="button" onClick={() => activeNav('Connection Settings')}>Open settings</button>}
    </div>}

    <div className="agent-overview-departments">
      {departments.map(department => {
        const members = agents.filter(agent => agent.departmentId === department.id);
        const departmentMissions = missions.filter(mission => mission.departmentId === department.id);
        const latest = reviews.filter(review => review.departmentId === department.id).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
        return <article key={department.id}>
          <div><span>{department.short || department.id.toUpperCase()}</span><b>{members.length} agents</b></div>
          <h4>{DEPARTMENT_NAMES[department.id] || department.name}</h4>
          <p>{department.mission}</p>
          <footer><span>{departmentMissions.filter(item => item.status === 'completed').length}/{departmentMissions.length} missions complete</span><strong>{latest ? count(latest.score) + '% KPI' : 'No KPI review'}</strong></footer>
        </article>;
      })}
      {!departments.length && !state.loading && <p className="agent-overview-empty">Department records are unavailable. Check the access token and D1 connection.</p>}
    </div>

    <div className="agent-overview-bottom">
      <span><Activity size={13}/> {state.overview ? agents.filter(agent => agent.status === 'ready').length + ' department agents ready' : roster.length ? roster.length + ' specialist definitions available; private status pending' : 'Agent registry pending'}</span>
      <span>{state.paper ? 'Paper fleet: ' + paperAgents.length + ' agents · ' + paperOpenTrades.length + ' open positions · live orders disabled' : 'Paper fleet status pending'}</span>
      <span>{latestReview ? 'Latest KPI review: ' + latestReview.date : 'No daily KPI review yet'}</span>
      <span>{state.updatedAt ? 'Synced ' + stamp(state.updatedAt) : 'Not synced'}</span>
    </div>
    <nav className="agent-overview-links" aria-label="Agent workspaces">
      <button type="button" onClick={() => activeNav('AI Agent Command Center')}>Specialist Agent Command Center ↗</button>
      <button type="button" onClick={() => activeNav('Autonomous Departments')}>Autonomous Departments ↗</button>
      <button type="button" onClick={() => activeNav('Opportunity Radar')}>Opportunity Radar ↗</button>
      <button type="button" onClick={() => activeNav('Trading Bots')}>Paper Agent Fleet ↗</button>
    </nav>
  </section>;
}
