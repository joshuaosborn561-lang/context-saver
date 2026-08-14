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
| `lp_run` | `{ job_id, status }` (auto-ensures client) |
| `lp_status` | progress + `useful_output_count` |
| `lp_inventory` | counts only |
| `lp_sample` | ≤10 rows |
| `lp_export` | `{ signed_url, row_count }` |
| `lp_ensure_client` | provision `client_<tag>` schema (idempotent) |
| `lp_list_clients` | registered tags |

New clients: any snake_case `client_tag`. `lp_ensure_client` or just `lp_run` — schema is created automatically.

## Job kinds

1. `backfill` — source tables → `lp.*`
2. `ingest_serp` — Apify SERP JSON → contacts (`persona`)
3. `ingest_csv` — CSV/XLSX URLs → `lp.{client_tag}_ingested_leads` (counts only)
4. `import_smartlead` / `sync_smartlead` / `build_suppression`

`ingest_csv` params: `urls[]`, `source_label`, optional `column_map`, `dedupe_key`, `exclude_name_patterns`, `exclude_domain_list`. Sample/export with `table: "ingested_leads"`. Inventory `by_source_tier.ingested` counts those rows.

## Non-negotiables

- No tool returns more than **10 rows** (`lp_sample` only).
- Long jobs are resumable per row (`lp.job_rows`).
- Success = useful output, not rows touched.
- **No People Data Labs.**
