import { getSessionSnapshot } from '../session-intelligence.js';

/**
 * New entries are permitted only on UTC weekdays and during a recognised
 * Sydney, Tokyo, London or New York session. Position management continues
 * outside these windows; this gate only controls opening additional risk.
 */
export function evaluateTradingWindow(timestamp = Date.now()) {
  const now = Number(timestamp);
  if (!Number.isFinite(now)) throw new TypeError('A valid trading-window timestamp is required.');
  const date = new Date(now);
  const weekday = date.getUTCDay();
  const weekdayAllowed = weekday >= 1 && weekday <= 5;
  const snapshot = getSessionSnapshot(now);
  const activeSessions = snapshot.sessions.filter(session => session.active);
  const sessionAllowed = activeSessions.length > 0;
  const eligible = weekdayAllowed && sessionAllowed;
  return {
    eligible,
    weekdayAllowed,
    sessionAllowed,
    weekdayUtc: date.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' }),
    activeSessions: activeSessions.map(session => session.name),
    sessionIds: activeSessions.map(session => session.id),
    reason: !weekdayAllowed
      ? 'Weekend protection: new entries are disabled from Saturday through Sunday UTC.'
      : !sessionAllowed
        ? 'No recognised major trading session is active; new entries are paused.'
        : 'Weekday session is active; market-quality and capital-protection gates still apply.',
    checkedAt: date.toISOString(),
    policy: 'WEEKDAYS_ONLY_FAVOURABLE_SESSIONS'
  };
}
