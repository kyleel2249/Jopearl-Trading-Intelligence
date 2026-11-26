# JPTI Agent & Bot Safety Supervisor

## Purpose

The safety supervisor is the common pre-entry control layer for the autonomous paper fleet. Specialist agents can research and propose a trade, but no specialist can override the fleet controls. The supervisor does not promise profitable trading and never grants live order permissions.

## Entry decision chain

1. Market data must be present and within the configured freshness limit.
2. The agent must be active, have an acceptable heartbeat/health score, and meet the trust floor.
3. Session eligibility, drawdown, daily loss and consecutive-loss limits are checked.
4. The global kill switch, fleet circuit breaker, agent quarantine and strategy suspension are checked.
5. All agent intents for the symbol are arbitrated before entries: opposite directions veto the entire symbol; duplicate same-direction intents are reduced to one highest-confidence candidate for the cycle.
6. The existing portfolio exposure, spread, position sizing and pre-trade risk gates still run after the supervisor.
7. Only a simulated paper fill may be created. Existing positions continue to be managed even when new entries are blocked.

## Safety outcomes

- **HEALTHY**: every required pre-entry condition passes.
- **BLOCKED**: one or more entry conditions fail. The agent may continue research and position management.
- **QUARANTINED**: critical security/policy anomaly, severe health degradation, or an explicit quarantine request. New entries are prohibited until the quarantine expires or an authorised operator resolves the incident.
- **SUSPENDED**: strategy-level suspension; fresh validation is required before research promotion.

Health scoring uses heartbeat state, heartbeat age, latency, error rate, market-data freshness and recorded risk violations. Trust is kept separate from health: a responsive agent can still have weak decision evidence.

## Persistent D1 state

Migration 0018_agent_safety_supervisor.sql adds:

- jpti_agent_safety_state: latest health, trust, block reasons and quarantine expiry.
- jpti_agent_safety_incidents: append-only incident evidence.
- jpti_fleet_circuit_breakers: global operator kill switch and circuit-breaker state.

Apply the normal D1 migration chain before deploying the updated Pages application. The application keeps its existing local risk gates if a development database has not yet applied migration 0018; production deployment must apply migrations before enabling the scheduler.

## Private operator endpoints

All endpoints require the configured JPTI private API token.

- GET /api/paper/safety — global breaker state and agent safety records.
- POST /api/paper/safety/kill-switch with JSON enabled=true and a reason — trip the global kill switch and fleet breaker.
- POST /api/paper/safety/kill-switch with JSON enabled=false, acknowledge=true and a reason — clear the operator kill switch. A separately tripped circuit breaker remains active.
- POST /api/paper/safety/resume with JSON acknowledge=true and a reason — explicit operator reset of the global breaker after investigation.

The server rejects a reset without an explicit acknowledgement and a reason. The response always reports liveExecutionAuthorized=false.

## Verification checklist

- Unit tests cover stale data, missing data, global kill switch, circuit breaker, quarantine, health degradation, security anomalies and conflicting intents.
- The strategy replay and validation suite must pass before promotion evidence can be considered.
- D1 migrations must apply in order, including 0016_strategy_validation, 0017_market_stream_recovery, and 0018_agent_safety_supervisor.
- Cloudflare Worker bundles, Pages build and runtime smoke checks must pass.
- A green CI run is necessary but not sufficient for live readiness; production credentials and live-order authorization remain disabled.
