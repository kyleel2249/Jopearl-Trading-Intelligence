// JPTI bridge: durable paper-event delivery plus fail-closed shared intelligence.
export class JptiBridge {
  constructor(options = {}) {
    this.token = '';
    this.now = options.now || (() => Date.now());
    this.fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
    this.storage = options.storage ?? this._browserStorage();
    this.queueKey = 'jpti.tbots.outbox.v1';
    this.maxQueue = Math.max(50, Math.min(5000, Number(options.maxQueue) || 500));
    this.queue = this._readQueue();
    this.sequence = this.queue.reduce((max, item) => Math.max(max, Number(item.payload?.metadata?.sequence) || 0), 0);
    this.flushing = false;
    this.lastAcknowledgedAt = null;
    this.lastDeliveryError = null;
    this.lastContextAt = 0; this.context = null; this.lastMemory = null;
    this.risk = null; this.lastRiskAt = 0; this.assetEvidence = new Map(); this.lastAssetEvidenceAt = 0;
    this.cexMarkets = null; this.lastCexMarketsAt = 0; this.macro = null; this.lastMacroAt = 0;
    this.dexWatchlist = null; this.lastDexWatchlistAt = 0;
  }
  _browserStorage() { try { return globalThis.localStorage || null; } catch { return null; } }
  _readQueue() {
    try {
      const value = this.storage?.getItem(this.queueKey);
      const parsed = value ? JSON.parse(value) : [];
      return Array.isArray(parsed) ? parsed.filter(item => item?.payload?.externalId && item?.payload?.eventType) : [];
    } catch { return []; }
  }
  _persistQueue() {
    try { this.storage?.setItem(this.queueKey, JSON.stringify(this.queue)); return true; }
    catch (error) { this.lastDeliveryError = 'Local event queue persistence failed: ' + (error.message || error); return false; }
  }
  setToken(value) { this.token = String(value || '').trim(); }
  get enabled() { return Boolean(this.token); }
  deliveryStatus() {
    return { queued: this.queue.length, oldestQueuedAt: this.queue[0]?.payload?.occurredAt || null,
      lastAcknowledgedAt: this.lastAcknowledgedAt, lastError: this.lastDeliveryError,
      persistence: this.storage ? 'browser-local-storage' : 'memory-only' };
  }
  async _request(path, options = {}) {
    if (!this.enabled) return null;
    if (typeof this.fetchImpl !== 'function') throw new Error('Fetch is unavailable for the JPTI bridge.');
    const url = path.startsWith('/') ? '/api' + path : '/api/integrations/tbots/' + path;
    const response = await this.fetchImpl(url, {
      ...options, headers: { 'content-type': 'application/json', 'x-jpti-api-token': this.token, ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'JPTI bridge request failed (' + response.status + ')');
    return body;
  }
  async flushEvents(force = false) {
    if (!this.enabled || this.flushing || !this.queue.length) return this.deliveryStatus();
    this.flushing = true;
    try {
      while (this.queue.length) {
        const item = this.queue[0];
        if (!force && Number(item.nextAttemptAt || 0) > this.now()) break;
        try {
          await this._request('events', { method: 'POST', body: JSON.stringify(item.payload) });
          this.queue.shift();
          this.lastAcknowledgedAt = new Date(this.now()).toISOString();
          this.lastDeliveryError = null;
          this._persistQueue();
        } catch (error) {
          item.attempts = (Number(item.attempts) || 0) + 1;
          item.nextAttemptAt = this.now() + Math.min(30000, 1000 * (2 ** Math.min(5, item.attempts - 1)));
          item.lastError = String(error.message || error).slice(0, 240);
          this.lastDeliveryError = item.lastError;
          this._persistQueue();
          break;
        }
      }
    } finally { this.flushing = false; }
    return this.deliveryStatus();
  }
  async refreshContext(force = false) {
    if (!this.enabled || this.now() - this.lastContextAt < 60000 && !force) return this.context;
    this.lastContextAt = this.now();
    try { this.context = await this._request('/universal/market/binance/BTC%2FUSDT%3AUSDT?timeframe=1h'); }
    catch (error) {
      try { this.context = await this._request('context?exchange=binance&symbol=BTC%2FUSDT'); }
      catch (fallbackError) { this.context = null; this.lastError = fallbackError.message || error.message; }
    }
    return this.context;
  }
  async refreshMacro(force = false) {
    if (!this.enabled || this.now() - this.lastMacroAt < 300000 && !force) return this.macro;
    this.lastMacroAt = this.now();
    try { this.macro = await this._request('/universal/macro'); }
    catch (error) { this.macro = null; this.lastError = error.message; }
    return this.macro;
  }
  async refreshRisk(force = false) {
    if (!this.enabled) return null;
    await this.flushEvents();
    if (this.now() - this.lastRiskAt < 30000 && !force) return this.risk;
    this.lastRiskAt = this.now();
    try {
      const risk = await this._request('/universal/risk');
      const generatedAt = Date.parse(risk?.generatedAt || '');
      const age = this.now() - generatedAt;
      if (!Number.isFinite(generatedAt) || age > 45000 || age < -30000) {
        this.risk = { ...(risk || {}), newEntriesAllowed: false,
          pauseReasons: ['JPTI shared risk state is missing or stale; new entries fail closed.'],
          error: 'Stale or invalid shared risk timestamp.', exitsRemainEnabled: true };
      } else this.risk = risk;
    } catch (error) {
      this.risk = { newEntriesAllowed: false, pauseReasons: ['JPTI shared risk state unavailable'], error: error.message, exitsRemainEnabled: true };
      this.lastError = error.message;
    }
    return this.risk;
  }
  async preflightEntry({ token, profileId = 'meme_new_pair', securityPassed = false } = {}) {
    if (!this.enabled) return { allowed:false, reasons:['JPTI bridge is not configured'] };
    // Always consult the authoritative JPTI gate for every new entry.
    // Cached approvals could outlive a newly engaged kill switch or risk pause.
    const relativeVolume=Number(token?.volume5mAvgUsd)>0?Number(token.volume5mUsd)/Number(token.volume5mAvgUsd):null;
    const assetClass=String(token?.assetClass||token?.marketType||'unknown').toLowerCase();
    const payload={
      profileId,assetClass,observedAt:token?.fetchedAt||null,
      securityStatus:securityPassed?'passed':'not-verified',
      maxEvidenceAgeSeconds:90,
      evidence:{
        momentumPct:token?.change1hPct,
        relativeVolume:Number.isFinite(relativeVolume)?relativeVolume:null,
        timeframeAlignment:token?.timeframeAlignment,
        rsi14:token?.rsi14,
        orderBookImbalance:token?.orderBookImbalance,
        fundingRate:token?.fundingRate,
        liquidityUsd:token?.liquidityUsd
      }
    };
    try {
      const result=await this._request('/universal/entry-preflight',{method:'POST',body:JSON.stringify(payload)});
      return result;
    } catch(error) {
      this.lastError=error.message;
      return {allowed:false,reasons:['JPTI entry preflight unavailable; fail-closed',error.message]};
    }
  }
  async refreshDexWatchlist(force = false) {
    if (!this.enabled || this.now() - this.lastDexWatchlistAt < 15000 && !force) return this.dexWatchlist;
    this.lastDexWatchlistAt = this.now();
    try { this.dexWatchlist = await this._request('/universal/dex-watchlist'); }
    catch (error) { this.dexWatchlist = { pairs:[], status:'unavailable', error:error.message }; this.lastError = error.message; }
    return this.dexWatchlist;
  }
  async refreshCexMarkets(force = false) {
    if (!this.enabled || this.now() - this.lastCexMarketsAt < 12000 && !force) return this.cexMarkets;
    this.lastCexMarketsAt = this.now();
    try { this.cexMarkets = await this._request('/universal/cex-watchlist'); }
    catch (error) { this.cexMarkets = { markets: [], status:'unavailable', error:error.message }; this.lastError = error.message; }
    return this.cexMarkets;
  }
  async refreshAssetEvidence(tokens = [], force = false) {
    if (!this.enabled || this.now() - this.lastAssetEvidenceAt < 30000 && !force) return this.assetEvidence;
    const assets = tokens.filter(t => t?.tokenAddress && t?.chain).slice(0, 80).map(t => ({
      id:t.id, chain:t.chain, address:t.tokenAddress, symbol:t.symbol,
      liquidityUsd:t.liquidityUsd, volume24hUsd:t.volume24hUsd, volume1hUsd:t.volume1hUsd,
      change1hPct:t.change1hPct, ageMin:t.ageMin, buys:t.buys1h, sells:t.sells1h,
      quoteAddress:t.quoteAddress, quoteSymbol:t.quoteSymbol, rsi14:t.rsi14
    }));
    if (!assets.length) return this.assetEvidence;
    this.lastAssetEvidenceAt = this.now();
    try {
      const result = await this._request('/universal/asset-evidence', { method:'POST', body:JSON.stringify({assets}) });
      this.assetEvidence = new Map((result.evidence || []).map(item => [item.id, item]));
      this.lastAssetEvidenceError = null;
    } catch (error) { this.lastAssetEvidenceError = error.message; }
    return this.assetEvidence;
  }
  async searchUniverse(query) {
    if (!this.enabled || String(query || '').trim().length < 2) return null;
    return this._request('universe?q=' + encodeURIComponent(String(query).trim()));
  }
  async loadMemory() {
    if (!this.enabled) return null;
    try { this.lastMemory = await this._request('memory?limit=50'); return this.lastMemory; }
    catch (error) { this.lastError = error.message; return null; }
  }
  publish(eventType, runId, symbol, metadata = {}, quantity = 0) {
    if (!this.enabled) return Promise.resolve(false);
    if (this.queue.length >= this.maxQueue) {
      this.lastDeliveryError = 'JPTI event queue is full; event was not silently discarded.';
      return Promise.resolve(false);
    }
    const sequence = ++this.sequence;
    const safeRunId = String(runId || 'run').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'run';
    const externalId = 'tbots:' + safeRunId + ':' + sequence + ':' + eventType;
    const payload = { eventType, externalId, runId:safeRunId, symbol, quantity,
      occurredAt:new Date(this.now()).toISOString(), metadata:{ ...metadata, sequence, runId:safeRunId } };
    this.queue.push({ payload, attempts:0, nextAttemptAt:0 });
    this._persistQueue();
    return this.flushEvents();
  }
  attach(orchestrator, runId) {
    if (!this.enabled) return;
    const bus = orchestrator.bus;
    const tags = event => {
      const token = event.tokenId ? orchestrator.feed.get(event.tokenId) : null;
      const equity = Number(orchestrator.equity?.balance);
      const equityPeak = Number(orchestrator.peak);
      return { strategyProfile: orchestrator.cfg.scanner.assetProfile || 'meme_new_pair',
        strategyId: orchestrator.cfg.scanner.assetProfile || 'meme_new_pair',
        assetClass: token?.assetClass || (token?.marketType === 'cex' ? 'crypto_spot' : 'dex_token'),
        chain: token?.chain || null, venue: token?.exchange || token?.dex || null, runId,
        ...(Number.isFinite(equity) ? { equity } : {}),
        ...(Number.isFinite(equityPeak) ? { equityPeak } : {}) };
    };
    bus.on('trade:enter', event => this.publish('bot_trade', runId, event.symbol, { ...tags(event), action:'paper_enter', reason:event.reason, sizePct:event.sizePct, price:event.price }));
    bus.on('trade:exit', event => this.publish('bot_trade', runId, event.symbol, { ...tags(event), action:'paper_exit', reason:event.reason, pnl:event.pnl, price:event.price, partial:event.partial }));
    bus.on('trade:closed', event => this.publish('bot_trade', runId, event.symbol, { ...tags(event), action:'paper_closed',
      pnl:event.pnl, cost:event.cost, proceeds:event.proceeds, reason:event.reason,
      slippagePct:event.slippagePct, entryPrice:event.entryPrice, exitPrice:event.exitPrice,
      holdDurationMin:event.holdDurationMin }));
    bus.on('trade:filtered', event => this.publish('bot_filter', runId, event.symbol, { ...tags(event), reason:event.reason }));
    bus.on('sys', event => this.publish('bot_decision', runId, 'SYSTEM', { ...tags(event), reason:event.reason }));
    bus.on('session:end', recap => this.publish('bot_session', runId, 'SESSION', { action:'paper_session_closed',
      strategyProfile:orchestrator.cfg.scanner.assetProfile || 'meme_new_pair',
      strategyId:orchestrator.cfg.scanner.assetProfile || 'meme_new_pair',
      trades:recap.trades, wins:recap.wins, losses:recap.losses, returnPct:recap.returnPct,
      start:recap.start, end:recap.end, equity:recap.end, equityPeak:orchestrator.peak }));
  }
}
