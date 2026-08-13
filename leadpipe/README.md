# LeadPipe

Context pass-through. The LLM orchestrates with counts and job IDs; data stays in Supabase.

```
Claude (chat) ──job requests──▶ LeadPipe worker (Railway)
       ▲                              │
       └── counts + job_id ───────────┤
                                      ▼
                         Supabase (lp.*) / Smartlead / Apify datasets
```

**Not an enrichment engine.** No LeadMagic, GetLeads, AI Ark, FullEnrich, or DM lookup strategy.

## MCP tools

| Tool | Returns |
|------|---------|
| `lp_plan` | Map a goal to a pass-through job kind ($0) |
| `lp_run` | `{ job_id, status }` |
| `lp_status` | progress + `useful_output_count` |
| `lp_inventory` | counts only |
| `lp_sample` | ≤10 rows |
| `lp_export` | `{ signed_url, row_count }` |

## Job kinds

1. `backfill` — source tables → `lp.*`
2. `ingest_serp` — Apify SERP JSON → contacts (`persona`)
3. `import_smartlead` / `sync_smartlead` / `build_suppression`

## Non-negotiables

- No tool returns more than **10 rows** (`lp_sample` only).
- Long jobs are resumable per row (`lp.job_rows`).
- Success = useful output, not rows touched.
- **No People Data Labs.**
