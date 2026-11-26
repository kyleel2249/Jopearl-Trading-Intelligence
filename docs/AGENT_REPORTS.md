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
