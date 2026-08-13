# LeadPipe — context pass-through

**This app does not enrich, find DMs, or plan spend.** It moves lead data server-side so chat never carries payloads. Counts and job IDs only.

## Tools

| Need | Tool |
|------|------|
| Counts | `lp_inventory` |
| Start a job | `lp_run` → `job_id` |
| Progress | `lp_status` |
| Eyeball ≤10 rows | `lp_sample` |
| Download for humans | `lp_export` |

## Job kinds (all $0)

| Kind | What it does |
|------|----------------|
| `backfill` | Copy source tables into `lp.*` |
| `ingest_serp` | Load staged Apify SERP JSON → contacts |
| `import_smartlead` | Import from storage into Smartlead |
| `sync_smartlead` | Campaign stats (bodies stripped) |
| `build_suppression` | Suppression list |

There is **no** `find_dms_by_title`, `enrich_contacts`, or `verify_emails`. Do not invent paid plans.

## Rules

1. Never pull lead lists into chat when a LeadPipe job exists.
2. Always pass `client_tag`.
3. Success = `useful_output_count` / verified membership — not rows processed.
4. If MCP is down, stop — do not dump data into context.
