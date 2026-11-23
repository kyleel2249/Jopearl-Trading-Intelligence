# JPTI Cloudflare D1 and KV setup

The root `wrangler.toml` declares the Pages Functions bindings:

- D1 resource: `jopearl-trading-intelligence-db`; binding: `JPTI_DB`.
- KV resource: `jopearl-trading-intelligence-kv`; binding: `JPTI_KV`.

The resource IDs supplied by the project owner are configured in `wrangler.toml`. They are identifiers, not credentials.

## Migration separation

The original `migrations/*.sql` files are legacy PostgreSQL/Supabase migrations. Do not apply them to D1. Cloudflare D1 uses the SQLite-compatible migrations under `migrations/d1/`, selected explicitly through `migrations_dir`. Legacy files are retained; they are not deleted.

## Apply D1 migrations from the project root

```powershell
npm install
npx wrangler login
npm run db:d1:list
npm run db:d1:apply
```

Review the migration list before applying. The apply command changes the remote D1 database. It creates the JPTI event store, migration tracker, synchronization cursors, scheduler lease table and transactional outbox.

## Verify KV access

Use a temporary key and remove it immediately. The namespace ID below is the one configured in `wrangler.toml`.

```powershell
npx wrangler kv key put --namespace-id df173421174345f9a065b312082ba43d jpti:setup:verification ok
npx wrangler kv key get --namespace-id df173421174345f9a065b312082ba43d jpti:setup:verification
npx wrangler kv key delete --namespace-id df173421174345f9a065b312082ba43d jpti:setup:verification
```

## Pages deployment

- Build command: `npm run build:pages`
- Output directory: `dist`
- Root directory: `/`
- Production branch: `main`

After changing Wrangler bindings, redeploy Pages. Production and Preview are separate runtime environments; confirm the correct resources are attached to each environment you use.

## Current scope

This setup declares the bindings and provides a D1-compatible durable schema. It does not, by itself, port all legacy Express/Node services or private exchange execution into Pages Functions. Each service must be explicitly migrated to use `env.JPTI_DB`, `env.JPTI_KV`, and Cloudflare-compatible runtime APIs. Never report a feature as operational until its deployed endpoint has passed integration tests.
