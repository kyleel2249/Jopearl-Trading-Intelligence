// Observational outcome reporting for the agent fleet. Shared by Node and Cloudflare Pages.
// It reads recorded evaluations and operator feedback; it never changes agent weights,
// strategies or permissions, and it never creates orders.
const finite = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, digits = 4) => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const TAKEN = new Set(['win', 'loss', 'breakeven']);
export const MIN_RELIABLE_SAMPLE = 30;

export function sampleQuality(n) {
  return n >= MIN_RELIABLE_SAMPLE ? 'adequate' : n >= 10 ? 'limited' : 'insufficient';
}
const directionOfStance = stance => /bullish/.test(String(stance)) ? 1 : /bearish/.test(String(stance)) ? -1 : 0;

function summarizeOutcomes(rows) {
  const counts = { win: 0, loss: 0, breakeven: 0, invalidated: 0, not_taken: 0 };
  const rs = [];
  for (const row of rows) {
    if (row.outcome in counts) counts[row.outcome] += 1;
    if (TAKEN.has(row.outcome) && row.realizedR !== null) rs.push(row.realizedR);
  }
  const taken = counts.win + counts.loss + counts.breakeven;
  const wins = rs.filter(r => r > 0), losses = rs.filter(r => r < 0);
  const grossWin = wins.reduce((s, r) => s + r, 0), grossLoss = Math.abs(losses.reduce((s, r) => s + r, 0));
  return {
    feedbackCount: rows.length, counts, takenTrades: taken,
    winRate: taken ? round(counts.win / taken) : null,
    expectancyR: rs.length ? round(rs.reduce((s, r) => s + r, 0) / rs.length) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    realizedRSamples: rs.length,
    sampleQuality: sampleQuality(taken)
  };
}

/**
 * @param {object[]} evaluations stored agent evaluation payloads
 * @param {object[]} feedbackRows stored feedback payloads (several per evaluation allowed; latest wins)
 */
export function summarizeAgentPerformance(evaluations = [], feedbackRows = []) {
  const byId = new Map();
  for (const evaluation of Array.isArray(evaluations) ? evaluations : []) if (evaluation?.id) byId.set(String(evaluation.id), evaluation);
  const latest = new Map();
  for (const raw of Array.isArray(feedbackRows) ? feedbackRows : []) {
    if (!raw?.evaluationId || !byId.has(String(raw.evaluationId))) continue;
    const row = { ...raw, outcome: String(raw.outcome || '').toLowerCase(), realizedR: finite(raw.realizedR) };
    const previous = latest.get(row.evaluationId);
    if (!previous || String(row.recordedAt || '') >= String(previous.recordedAt || '')) latest.set(row.evaluationId, row);
  }
  const joined = [...latest.values()].map(feedback => ({ feedback, evaluation: byId.get(String(feedback.evaluationId)) }));

  const group = keyOf => {
    const buckets = new Map();
    for (const item of joined) {
      const key = keyOf(item.evaluation) || 'unspecified';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(item.feedback);
    }
    return [...buckets.entries()].map(([key, rows]) => ({ key, ...summarizeOutcomes(rows) })).sort((a, b) => b.feedbackCount - a.feedbackCount);
  };

  // Per-specialist concordance: among evaluations that led to a decided trade (win/loss) with a
  // directional consensus, did the specialist's vote side with the eventual winning direction?
  const specialists = new Map();
  for (const { feedback, evaluation } of joined) {
    if (feedback.outcome !== 'win' && feedback.outcome !== 'loss') continue;
    const direction = directionOfStance(evaluation.consensus?.stance);
    if (!direction) continue;
    const winningDirection = feedback.outcome === 'win' ? direction : -direction;
    for (const agent of Array.isArray(evaluation.agents) ? evaluation.agents : []) {
      if (agent.kind === 'risk' || agent.status !== 'evaluated' || !Number.isFinite(agent.score) || Math.abs(agent.score) <= .15) continue;
      const entry = specialists.get(agent.id) || { id: agent.id, decided: 0, correct: 0 };
      entry.decided += 1;
      if (Math.sign(agent.score) === winningDirection) entry.correct += 1;
      specialists.set(agent.id, entry);
    }
  }
  const specialistConcordance = [...specialists.values()].map(entry => ({
    id: entry.id, decidedVotes: entry.decided, correctVotes: entry.correct,
    concordance: entry.decided ? round(entry.correct / entry.decided) : null, sampleQuality: sampleQuality(entry.decided)
  })).sort((a, b) => b.decidedVotes - a.decidedVotes);

  const blockedEvaluations = (Array.isArray(evaluations) ? evaluations : []).filter(e => e?.risk?.blocked === true).length;
  return {
    generatedAt: new Date().toISOString(), mode: 'observational_only',
    evaluations: byId.size, evaluationsWithFeedback: joined.length, blockedEvaluations,
    overall: summarizeOutcomes(joined.map(item => item.feedback)),
    byStance: group(e => e.consensus?.stance), byRecommendedAction: group(e => e.recommendedAction), bySymbol: group(e => e.symbol),
    specialistConcordance,
    limitations: [
      'Outcomes are operator-recorded; they are not verified against exchange fills.',
      `Statistics below ${MIN_RELIABLE_SAMPLE} decided samples are not reliable and are labelled accordingly.`,
      'Concordance assumes the trade followed the consensus direction; it does not change agent weights or authorize execution.'
    ]
  };
}
