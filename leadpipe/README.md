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
6. `import_smartlead` — requeue/import from storage; assert live membership (not just upload_count)
7. `build_suppression` — mark contacts `suppressed=true`
8. `backfill` — `gc.contacts` / `gc.companies` / `peterson_leads` → `lp.*`

### Requeue without burning context

The failure mode: every lead passes through chat twice (read file + tool call), so a 1,113-lead restore truncates mid-campaign and count checks only compare against what was *sent*, not what *should* have been sent.

```json
// 1. Upload the four _clean.json files to storage (lp-exports/imports/...)
// 2. lp_run — leads never enter the conversation
{
  "job_kind": "import_smartlead",
  "client_tag": "culture_fits",
  "params": {
    "ignore_global_block_list": true,
    "batch_size": 100,
    "campaigns": [
      { "campaign_id": "3781908", "storage_path": "imports/3781908_clean.json",
        "expected_upload": 195, "expected_final_count": 4616 },
      { "campaign_id": "3781909", "storage_path": "imports/3781909_clean.json",
        "expected_upload": 302, "expected_final_count": 1250 },
      { "campaign_id": "3781911", "storage_path": "imports/3781911_clean.json",
        "expected_upload": 251, "expected_final_count": 1293 },
      { "campaign_id": "3781913", "storage_path": "imports/3781913_clean.json",
        "expected_upload": 365, "expected_final_count": 1144 }
    ]
  }
}
// 3. lp_status → per-campaign live_count vs expected_final_count, block_total, verified_ok
```

Resumable per batch. Refuses to start if clean-file length ≠ `expected_upload`.

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

### 5. Railway (remote MCP URL for Claude)

Deployed project serves Streamable HTTP MCP at `/mcp`.

**Claude custom connector URL:**
```
https://leadpipe-production-0df5.up.railway.app/mcp
```

Auth: set header `Authorization: Bearer <LEADPIPE_MCP_TOKEN>`  
(or append `?token=<LEADPIPE_MCP_TOKEN>` if the client only supports URL auth).

Health check: `GET https://leadpipe-production-0df5.up.railway.app/health`

```bash
cd leadpipe
railway up
# Set env vars in Railway dashboard (same as .env.example)
```

Dockerfile + `railway.toml` included.

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
