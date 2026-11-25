import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownLeft, ArrowUpRight, BrainCircuit, Building2, CheckCircle2, CircleAlert, Clock3, Database, MessageSquare, Play, RefreshCw, Search, Send, ShieldCheck, Sparkles, Target, Users } from 'lucide-react';
import { apiFetch } from './lib/api.js';
import './AutonomousDepartments.css';

const LABELS = { research: 'Research & Intelligence', 'trading-social': 'Trading Social Intelligence', 'general-marketing': 'General Marketing Intelligence' };
const shortDate = value => value ? new Date(value).toLocaleString() : '—';
const pct = value => Math.round(Number(value || 0) * 100) + '%';
const initialMission = { departmentId: 'research', title: '', objective: '', priority: 'normal' };

export default function AutonomousDepartments() {
  const [data, setData] = useState(null);
  const [department, setDepartment] = useState('research');
  const [mission, setMission] = useState(initialMission);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [pulseBusy, setPulseBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pulseAttempted = useRef(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await apiFetch('/api/org/overview', { cache: 'no-store' });
      const payload = await result.json();
      if (!result.ok) throw new Error(payload.error || 'Could not load JPTI department intelligence.');
      setData(payload);
    } catch (cause) { setError(cause.message || 'Department intelligence is unavailable.'); }
  }, []);

  const runPulse = useCallback(async () => {
    setPulseBusy(true); setError(''); setNotice('');
    try {
      const result = await apiFetch('/api/org/autonomy/pulse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const payload = await result.json();
      if (!result.ok) throw new Error(payload.error || 'Autonomous daily pulse could not complete.');
      setNotice(payload.alreadyRan ? 'Today’s autonomous pulse has already been recorded.' : 'Daily missions completed and department reviews recorded.');
      await load();
    } catch (cause) { setError(cause.message || 'Autonomous pulse failed.'); }
    finally { setPulseBusy(false); }
  }, [load]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!data || pulseAttempted.current) return;
    pulseAttempted.current = true;
    if (data.reviews?.some(item => item.date === new Date().toISOString().slice(0, 10))) return;
    const timer = window.setTimeout(() => runPulse(), 1200);
    return () => window.clearTimeout(timer);
  }, [data, runPulse]);
  useEffect(() => {
    const timer = window.setInterval(() => { load(); }, 60000);
    return () => window.clearInterval(timer);
  }, [load]);

  const runReview = async () => {
    setReviewBusy(true); setError('');
    try {
      const result = await apiFetch('/api/org/reviews/daily', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ departmentId: department }) });
      const payload = await result.json();
      if (!result.ok) throw new Error(payload.error || 'Daily review failed.');
      setNotice('Daily KPI review updated for ' + LABELS[department] + '.');
      await load();
    } catch (cause) { setError(cause.message || 'Daily review failed.'); }
    finally { setReviewBusy(false); }
  };

  const createMission = async event => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const result = await apiFetch('/api/org/missions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...mission, execute: true }) });
      const payload = await result.json();
      if (!result.ok) throw new Error(payload.error || 'Mission could not be created.');
      setNotice(payload.mission?.status === 'completed' ? 'Mission completed. Its findings were saved to shared memory and distributed.' : 'Mission queued for autonomous execution.');
      setMission(old => ({ ...old, title: '', objective: '' }));
      await load();
    } catch (cause) { setError(cause.message || 'Mission execution failed.'); }
    finally { setBusy(false); }
  };

  const runQueued = async item => {
    setBusy(true); setError('');
    try {
      const result = await apiFetch('/api/org/missions/' + encodeURIComponent(item.id) + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const payload = await result.json();
      if (!result.ok) throw new Error(payload.error || 'Queued mission could not run.');
      setNotice('Mission executed and findings distributed to shared memory.');
      await load();
    } catch (cause) { setError(cause.message || 'Mission could not run.'); }
    finally { setBusy(false); }
  };

  const filteredMemory = useMemo(() => (data?.memory || []).filter(item => !query || (item.title + ' ' + item.content + ' ' + item.tags.join(' ')).toLowerCase().includes(query.toLowerCase())), [data, query]);
  const selected = data?.departments?.find(item => item.id === department);
  const team = (data?.agents || []).filter(item => item.departmentId === department);
  const missions = (data?.missions || []).filter(item => item.departmentId === department);
  const review = (data?.reviews || []).find(item => item.departmentId === department && item.date === new Date().toISOString().slice(0, 10));
  const goals = (data?.goals || []).find(item => item.departmentId === department)?.goals || selected?.goals || [];
  const todayMetrics = review?.metrics?.actual || { missions: 0, memory: 0, messages: 0 };
  const messages = (data?.messages || []).filter(item => item.to === department || item.from === department).slice(0, 12);

  return <section className="org-workspace">
    <div className="org-hero glass-panel">
      <div><span className="eyebrow">JPTI AUTONOMOUS ORGANISATION</span><h2>AI Department Headquarters</h2><p>Three autonomous workforces, one shared institutional memory, measurable goals and daily accountability.</p></div>
      <div className="org-hero-actions"><span className="org-live"><i/> SHARED MEMORY ONLINE</span><button className="refresh-button" onClick={runPulse} disabled={pulseBusy}><RefreshCw size={14} className={pulseBusy ? 'org-spin' : ''}/>{pulseBusy ? 'Running daily pulse…' : 'Run autonomous daily pulse'}</button></div>
    </div>
    {error && <div className="org-alert"><CircleAlert size={15}/>{error}</div>}
    {notice && <div className="org-notice"><CheckCircle2 size={15}/>{notice}</div>}
    <div className="org-department-grid">
      {(data?.departments || []).map(item => {
        const agents = (data?.agents || []).filter(agent => agent.departmentId === item.id);
        const done = (data?.missions || []).filter(m => m.departmentId === item.id && m.status === 'completed').length;
        const unread = (data?.messages || []).filter(m => m.to === item.id && m.status === 'unread').length;
        const score = (data?.reviews || []).find(r => r.departmentId === item.id && r.date === new Date().toISOString().slice(0, 10))?.score;
        return <button type="button" key={item.id} className={'org-department-card ' + (department === item.id ? 'active' : '')} onClick={() => { setDepartment(item.id); setMission(old => ({ ...old, departmentId: item.id })); }}>
          <span>{item.name}</span><strong>{agents.length} agents</strong><small>{done} completed missions · {unread} unread handoffs</small><b>{score == null ? 'Daily review pending' : 'Daily KPI score ' + score + '%'}</b>
        </button>;
      })}
    </div>
    <div className="org-toolbar">
      <div><span className="eyebrow">{selected?.short || 'DEPARTMENT'}</span><h3>{selected?.name || 'Department workspace'}</h3><p>{selected?.mission}</p></div>
      <div className="org-toolbar-actions"><button className="small-refresh" onClick={load}><RefreshCw size={13}/> Refresh intelligence</button><button className="small-refresh" onClick={runReview} disabled={reviewBusy}>{reviewBusy ? 'Reviewing…' : 'Run daily review'}</button></div>
    </div>
    <div className="org-kpi-grid">
      <article><small>AGENT WORKFORCE</small><strong>{team.length}</strong><span>Registered specialists</span></article>
      <article><small>MISSIONS COMPLETED TODAY</small><strong>{todayMetrics.missions}</strong><span>Target: {goals.find(g => g.key === 'missions')?.target || 0}</span></article>
      <article><small>SHARED MEMORY TODAY</small><strong>{todayMetrics.memory}</strong><span>Target: {goals.find(g => g.key === 'memory')?.target || 0}</span></article>
      <article><small>DEPARTMENT KPI SCORE</small><strong>{review ? review.score + '%' : '—'}</strong><span>{review?.metrics?.status || 'Awaiting daily review'}</span></article>
    </div>
    <div className="org-main-grid">
      <div className="org-main-column">
        <section className="glass-panel org-panel">
          <div className="org-panel-head"><div><span className="eyebrow">AUTONOMOUS TASKING</span><h4>Create a department mission</h4></div><Sparkles size={18}/></div>
          <form className="org-mission-form" onSubmit={createMission}>
            <label>Assigned department<select value={mission.departmentId} onChange={event => setMission(old => ({ ...old, departmentId: event.target.value }))}>{(data?.departments || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>Mission title<input value={mission.title} onChange={event => setMission(old => ({ ...old, title: event.target.value }))} maxLength={180} required placeholder="e.g. Research emerging African e-commerce demand"/></label>
            <label>Objective<textarea value={mission.objective} onChange={event => setMission(old => ({ ...old, objective: event.target.value }))} maxLength={2000} required rows={3} placeholder="Describe the research, campaign or intelligence outcome required…"/></label>
            <div className="org-form-foot"><label>Priority<select value={mission.priority} onChange={event => setMission(old => ({ ...old, priority: event.target.value }))}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><button type="submit" disabled={busy}>{busy ? 'Executing…' : <><Play size={13}/> Assign & execute mission</>}</button></div>
          </form>
        </section>
        <section className="glass-panel org-panel">
          <div className="org-panel-head"><div><span className="eyebrow">MISSION CONTROL</span><h4>Department mission history</h4></div><Activity size={17}/></div>
          <div className="org-mission-list">{missions.slice(0, 12).map(item => <article key={item.id}>
            <div><b>{item.title}</b><span className={'org-status org-' + item.status}>{item.status}</span></div><p>{item.objective}</p>
            {item.result?.output && <details><summary>Read completed intelligence</summary><pre>{item.result.output}</pre></details>}
            {item.status !== 'completed' && <button className="small-refresh" disabled={busy} onClick={() => runQueued(item)}>Run / retry mission</button>}
            <small>{shortDate(item.createdAt)} · {item.assignedAgents.length} assigned agents</small>
          </article>)}{!missions.length && <p className="subtle-note">No missions recorded for this department yet.</p>}</div>
        </section>
      </div>
      <div className="org-side-column">
        <section className="glass-panel org-panel">
          <div className="org-panel-head"><div><span className="eyebrow">GOALS & ACCOUNTABILITY</span><h4>Daily KPI scorecard</h4></div><Target size={17}/></div>
          {goals.map(goal => {
            const actual = todayMetrics[goal.key] || 0, percent = Math.min(100, Math.round(actual / goal.target * 100));
            return <div className="org-goal" key={goal.key}><div><b>{goal.label}</b><span>{actual} / {goal.target} {goal.unit}</span></div><i><em style={{ width: percent + '%' }}/></i></div>;
          })}
          <p className="subtle-note">KPI score measures recorded output against targets; it is not a measure of commercial success or research truth.</p>
        </section>
        <section className="glass-panel org-panel">
          <div className="org-panel-head"><div><span className="eyebrow">SPECIALIST WORKFORCE</span><h4>Agent roster</h4></div><Users size={17}/></div>
          <div className="org-agent-list">{team.map(agent => <div key={agent.id}><span><b>{agent.name}</b><small>{agent.role}</small><small>{agent.goal}</small><small>KPI today: {agent.todayMetrics?.completedMissions || 0}/{agent.kpis?.dailyMissionTarget || 1} missions · {agent.todayMetrics?.evidenceLinked || 0}/{agent.kpis?.evidenceLinkedTarget || 1} evidence-linked</small></span><i>{agent.status}</i></div>)}</div>
        </section>
        <section className="glass-panel org-panel">
          <div className="org-panel-head"><div><span className="eyebrow">INTERDEPARTMENTAL EXCHANGE</span><h4>Messages & handoffs</h4></div><MessageSquare size={17}/></div>
          <div className="org-message-list">{messages.map(item => <article key={item.id}><div><b>{item.from === department ? 'Sent to ' + LABELS[item.to] : 'From ' + LABELS[item.from]}</b><span>{item.priority}</span></div><strong>{item.subject}</strong><p>{item.body.slice(0, 380)}{item.body.length > 380 ? '…' : ''}</p><small>{shortDate(item.createdAt)}</small></article>)}{!messages.length && <p className="subtle-note">Department handoffs will appear here as missions complete.</p>}</div>
        </section>
      </div>
    </div>
    <section className="glass-panel org-panel org-shared-memory">
      <div className="org-panel-head"><div><span className="eyebrow">COLLECTIVE INTELLIGENCE MEMORY</span><h4>Shared knowledge repository</h4><p>Memory is shared across all three departments, with origin, timestamps and evidence confidence retained.</p></div><Database size={18}/></div>
      <div className="org-memory-search"><Search size={14}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search shared research, campaign findings and handoffs…"/></div>
      <div className="org-memory-grid">{filteredMemory.slice(0, 18).map(item => <article key={item.id}><div><span>{LABELS[item.departmentId]}</span><b>{pct(item.confidence)} confidence</b></div><h5>{item.title}</h5><p>{item.content.slice(0, 520)}{item.content.length > 520 ? '…' : ''}</p><small>{item.kind} · {shortDate(item.createdAt)}</small>{item.source && <a href={item.source} target="_blank" rel="noreferrer">Source / research feed ↗</a>}</article>)}{!filteredMemory.length && <p className="subtle-note">Shared memory is empty. Complete the first mission to populate institutional knowledge.</p>}</div>
    </section>
    <section className="glass-panel org-panel">
      <div className="org-panel-head"><div><span className="eyebrow">PLATFORM INTEGRATION READINESS</span><h4>Social channel connections</h4><p>Content creation and mission intelligence are active. Public posting and account engagement require each platform’s OAuth application and approved scopes.</p></div><ShieldCheck size={18}/></div>
      <div className="org-channel-grid">{['Instagram','Facebook','TikTok','YouTube','X','LinkedIn','Telegram','Reddit'].map(name => <div key={name}><b>{name}</b><span>Connection required</span></div>)}</div>
    </section>
    <div className="org-footer"><span><Database size={13}/> Persistent Cloudflare D1 shared memory</span><span><Clock3 size={13}/> Last loaded {shortDate(data?.generatedAt)}</span><span><ShieldCheck size={13}/> Private API · no exchange-order permissions</span></div>
  </section>;
}
