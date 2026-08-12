# LeadPipe

Context-free lead pipeline. The LLM orchestrates and decides; it never carries payload.

```
Claude (chat) ──job requests──▶ LeadPipe worker (Railway)
       ▲                              │
       └── counts + job_id ───────────┤
                                      ▼
                         Supabase (lp.*) ◀──▶ Vendor APIs
```

## Non-negotiables

- No tool returns more than **10 rows**, ever (`lp_sample` is the only row tool).
- Every paid job estimates first and respects a cost ceiling.
- Every long job is **resumable per row** (`lp.job_rows`) and survives restarts.
- Success = **useful output** (emails found, domains resolved), not rows touched.
- `lp.raw_payloads` keeps vendor JSON so re-filtering never re-buys data.
- **No People Data Labs**, directly or via wrapper.

## MCP tools

| Tool | Returns |
|------|---------|
| `lp_plan` | `{ candidate_count, estimated_cost_usd, breakdown }` |
| `lp_run` | `{ job_id, status, estimated_cost_usd }` |
| `lp_status` | progress + `useful_output_count` + cost |
| `lp_inventory` | counts only (`by_source_tier`, `gaps`) |
| `lp_sample` | ≤10 rows |
| `lp_export` | `{ signed_url, row_count }` |

## Job kinds

1. `find_dms_by_title` — employee_finder → title filter → email on survivors only
2. `enrich_contacts` — getleads → AI Ark → LeadMagic → FullEnrich (`max_tier`)
3. `verify_emails` — MillionVerifier → No2Bounce on ambiguous
4. `resolve_companies` — SERP-first (Maps-only disabled)
5. `sync_smartlead` — campaign stats with HTML bodies stripped server-side
6. `build_suppression` — mark contacts `suppressed=true`
7. `backfill` — `gc.contacts` / `gc.companies` / `peterson_leads` → `lp.*`

## Example

> Enrich the 396 unresolved Peterson property managers, stop at LeadMagic, cap at $20

```json
// lp_plan
{ "client_tag": "peterson", "goal": "enrich DMs missing email", "max_tier": "leadmagic",
  "filters": { "is_dm": true, "missing_email": true } }

// lp_run
{ "job_kind": "enrich_contacts", "client_tag": "peterson",
  "params": { "max_tier": "leadmagic", "is_dm": true, "missing_email_only": true },
  "approve_cost_usd": 20 }

// lp_status → { "job_id": "...", "useful_output_count": 47, "cost_actual_usd": 12.40 }
```

## Setup

### 1. Supabase (campaignintelligence)

Schema migration lives in `supabase/migrations/`. Already applied to project `azpapwtnrbzywlnxxecz`.

**Required:** Dashboard → Project Settings → API → **Exposed schemas** → add `lp`.

Storage bucket `lp-exports` is created for signed URL exports.

### 2. Env

```bash
cp .env.example .env
# SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (campaignintelligence)
# Vendor keys as needed
```

### 3. Run locally

```bash
npm install
npm run mcp      # stdio MCP for Cursor
npm run worker  # HTTP :8080 + job poller
```

### 4. Cursor MCP config

```json
{
  "mcpServers": {
    "leadpipe": {
      "command": "node",
      "args": ["/path/to/leadpipe/dist/index.js", "--mode", "mcp"],
      "env": {
        "SUPABASE_URL": "...",
        "SUPABASE_SERVICE_ROLE_KEY": "..."
      }
    }
  }
}
```

### 5. Railway

```bash
cd leadpipe
railway up
# Set env vars in Railway dashboard (same as .env.example)
```

Dockerfile + `railway.toml` included. Health check: `GET /health`.

## Client tags

`peterson` · `basco` · `culture_fits` · `parlay` · `msrs` · `bcp`

Every table and job is scoped by `client_tag`. Two chats on different clients never share job queues incorrectly — jobs are claimed FIFO but filtered/owned per tag in data.

## Repo layout

```
leadpipe/
  src/
    mcp/server.ts      # MCP tool surface
    jobs/kinds/        # one file per job kind
    vendors/           # server-to-server only
    services.ts        # plan/run/status/inventory/sample/export
    worker.ts          # Railway HTTP + poller
  supabase/migrations/
```
