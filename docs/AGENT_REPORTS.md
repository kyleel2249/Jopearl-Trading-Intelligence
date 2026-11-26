# Agent reports: readable output, guard, tools

AI agents answer in plain language. Raw JSON is never shown to operators.

## Pipeline
1. **Guard** (`src/lib/agent-output-guard.js`): every Workers AI call (foundation task runner, organisation missions and supervisor synthesis, journal mentor) goes through `guardedGeneration`. If the reply is a JSON document, JSON-dominated, or key-noisy, the model is asked **once** to rewrite it in plain English. If it still fails, the deterministic formatter converts it. Structured agents (schema JSON) get one retry for invalid JSON or JSON-inside-strings; structured data is still stored in `result.structured`.
2. **Formatter** (`src/lib/agent-report.js`): JSON, fenced JSON, or JSON embedded in prose becomes titled sections and bullets. No field is dropped.
3. **Renderer** (`src/AgentReport.jsx`, `src/lib/markdown-lite.js`): XSS-safe Markdown to React elements (no `dangerouslySetInnerHTML`; only http/https/mailto links).

## Operator tools on every report
- **Copy**, **Download .md / .txt**, **Print / PDF** (print-optimised document in a hidden iframe; choose "Save as PDF").
- **Save to journal**: saved on the device first, then mirrored to `/api/journal/entries` with `entryType: "ai-report"`. The status message says honestly whether cloud sync worked. Saved reports appear in the journal's **Saved AI reports** panel and never in the trade list.
- **Evidence badges**: lines starting `Verified fact:`, `Inference:`, `Unknown:`, `Recommendation:` get colour-coded badges; mission cards show source count, memory used, specialist and handoff counts, and whether the output was auto-repaired.
- **Run comparison**: tick two completed missions to see added, dropped and unchanged findings per section (fuzzy matching, so rewording is not a change).

## Handoff alerts
`HandoffAlerts` (Alerts Center) polls `GET /api/intelligence-foundation/agents` every 60 s and alerts on unread **high / urgent** handoffs once per browser (browser notification if permitted). **Mark read** calls `POST /api/intelligence-foundation/agents/messages/:id/read`. Like price alerts, it only runs while the page is open.

## Reliability metrics
Each guarded call writes one row to `jpti_agent_output_quality` (migration `0014`; the table is also created on demand). `GET /api/intelligence-foundation/agents/output-quality` returns totals and per-agent clean / repaired / fallback rates; the Autonomous Departments page shows them under **Agent output reliability**. Recording is best effort and never fails a task.

## Deploy note
Apply the migration: `npm run db:d1:apply`. All new endpoints use the existing private-token authentication.

## Tests
`src/lib/*.test.js` (guard, formatter, parser, diff, saved reports, alerts), `tests/agent-output-guard-api.test.js` (real task runner on real migrations via `node:sqlite`), `tests/agent-output-readability.test.js` (server-rendered components).

## Agent safety layer (`src/lib/content-safety.js`)
Risks assessed and the controls now in code (heuristics that reduce risk; prompts still treat retrieved text as data):

| Risk | Control |
|---|---|
| Prompt injection via news, memory or research | Retrieved headlines, shared memory and mentor research are sanitised before any prompt: instruction-like phrases removed, hidden/bidi characters stripped, non-http links dropped. Findings are reported as chips ("injection attempt neutralised"). |
| Poisoned shared memory | A model reply containing an injection is **quarantined**: stored with `evidence_status = quarantined`, confidence 0.1, never broadcast to other departments, and excluded from every later prompt. Quarantined rows stay visible for review. |
| Leaked secrets | Tokens, API keys, JWTs, private keys and `key=value` credentials are redacted from model output (text and structured data), memory, handoffs and the mentor review. |
| Stale data | News older than 72 h and memory older than 14 days are labelled (`fresh`, `partly-stale`, `stale`, `undated`); the model sees each item's age and stale entries lower the trust given to the result. |
| Hallucinated figures | Every number in a report is checked against the objective, retrieved headlines and memory. Figures not found there are listed honestly as "not found in sources" (they may be derived). Specialist output is deliberately **not** counted as evidence, so one agent's invention cannot validate the next. |
| Cascading errors | Handoffs and department broadcasts end with a provenance footer (origin, id, time, evidence level, "AI-generated, not independently verified"). Specialist findings forward which of their figures lacked support. |
| Runaway cost | `JPTI_AI_HOURLY_LIMIT` / `JPTI_AI_DAILY_LIMIT` (defaults 60 / 400). Tasks reserve 2 calls, missions 4, the mentor 2. Over the cap the work is blocked with HTTP 429 and a clear message; no model call is made. Soft cap; fails open (and says so) if usage cannot be read. `GET /api/intelligence-foundation/agents/ai-budget` shows live usage. |

Trust levels stored on results: `verified`, `partially-verified`, `inferred`, `unverified`, `quarantined`. A result with no source material is `unverified`, never `inferred`.

Not covered by code: independent human review of real-money decisions, source-diversity (agents on one model can still share blind spots), and semantic prompt injection that avoids known phrasing. Keep a human approval step on anything involving funds.
