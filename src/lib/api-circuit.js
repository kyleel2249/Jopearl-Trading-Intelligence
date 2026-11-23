// Small circuit breaker for the JPTI API client.
//
// After `failureThreshold` consecutive failures the circuit opens and callers skip the (dead) API for
// `cooldownMs`, using the browser-direct fallback instead. When the cooldown ends exactly one caller is
// allowed through as a probe ("half-open"); a success closes the circuit, a failure re-opens it with a
// longer cooldown (exponential, capped). All time is injected so the logic is deterministic in tests.

export function createCircuit({ failureThreshold = 2, cooldownMs = 30000, maxCooldownMs = 5 * 60000, now = () => Date.now() } = {}) {
  let failures = 0;
  let openUntil = 0;
  let probing = false;
  let trips = 0;

  const isOpen = () => openUntil > now();

  return {
    // True when a request should be sent to the API.
    shouldTryApi() {
      if (failures < failureThreshold) return true;
      if (isOpen()) return false;
      if (probing) return false; // someone else is already probing
      probing = true;
      return true;
    },
    success() {
      failures = 0;
      openUntil = 0;
      probing = false;
      trips = 0;
    },
    failure() {
      failures += 1;
      probing = false;
      if (failures >= failureThreshold) {
        trips += 1;
        const wait = Math.min(maxCooldownMs, cooldownMs * 2 ** Math.max(0, trips - 1));
        openUntil = now() + wait;
      }
    },
    reset() { failures = 0; openUntil = 0; probing = false; trips = 0; },
    snapshot() {
      return { state: failures < failureThreshold ? 'closed' : isOpen() ? 'open' : 'half-open', failures, retryAt: openUntil || null, trips };
    }
  };
}
