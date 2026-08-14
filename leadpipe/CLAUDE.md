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
| `ingest_csv` | Download CSV/XLSX URLs → `{client_tag}_ingested_leads` |
| `import_smartlead` | Import from storage into Smartlead |
| `sync_smartlead` | Campaign stats (bodies stripped) |
| `build_suppression` | Suppression list |

There is **no** `find_dms_by_title`, `enrich_contacts`, or `verify_emails`. Do not invent paid plans.

### `ingest_csv` params

- `urls` (required): downloadable https links
- `source_label` (required): stamped on every row
- `column_map` (optional): map headers → canonical fields
- `dedupe_key`: `email` (default) or `company_domain`
- `exclude_name_patterns` / `exclude_domain_list`: optional server-side strips

Inspect with `lp_sample(table="ingested_leads")`, export with `lp_export(table="ingested_leads")`.

## Rules

1. Never pull lead lists into chat when a LeadPipe job exists.
2. Always pass `client_tag`.
3. Success = `useful_output_count` / verified membership — not rows processed.
4. If MCP is down, stop — do not dump data into context.
