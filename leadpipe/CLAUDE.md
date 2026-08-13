# LeadPipe — use this instead of moving lead data through chat

When working on leads, campaigns, enrichment, Smartlead imports, or anything that touches contact/company rows:

**Prefer LeadPipe MCP tools.** Do not pull full lists into context. Do not page vendor APIs in chat. Do not paste CSVs or `_clean.json` contents into messages.

## Tools (counts / IDs only)

| Need | Tool |
|------|------|
| How many / what will it cost? | `lp_plan` |
| Start work | `lp_run` → get `job_id` |
| Progress | `lp_status` |
| Client snapshot | `lp_inventory` |
| Eyeball quality | `lp_sample` (≤10 rows) |
| Download for humans | `lp_export` → signed URL |

## Rules

1. Never call vendor tools that return lead rows into this conversation when a LeadPipe job exists.
2. Pass `client_tag` every time (`peterson`, `basco`, `culture_fits`, `parlay`, `msrs`, `bcp`).
3. For paid work, call `lp_plan` first, then `lp_run` with `approve_cost_usd`.
4. For Smartlead requeue: upload `_clean.json` to storage, then `import_smartlead` with `expected_upload` + `expected_final_count`. Do not import lead-by-lead in chat.
5. Success = `useful_output_count` / verified live membership — not rows processed.
6. If LeadPipe MCP is unavailable, say so and stop — do not fall back to dumping data into context.

## SERP ingest (Basco / franchise LinkedIn people)

When Apify `google-search-scraper` runs already exist, **do not** download datasets into chat and **do not** use paid `find_dms_by_title`.

```
lp_run(
  job_kind="ingest_serp",
  client_tag="basco",
  approve_cost_usd=0,
  params={
    "apify_run_ids": ["runId1", "runId2", …],
    "target_titles": "Service Director,Fixed Operations Director,Service Manager,Assistant Service Manager,Warranty Administrator,Parts and Service Director",
    "persona": "service_side"
  }
)
```

Then `lp_status`. Requires `APIFY_TOKEN` on the LeadPipe service. Filters company match + titles server-side; writes `lp.contacts` and `client_<tag>.contacts` with `persona`.

## Backfill (required before find_dms)

Two Supabase projects — do not mix them:

| Source | Project | Params |
|--------|---------|--------|
| `gc.companies` + `gc.contacts` | `azpapwtnrbzywlnxxecz` | `{ "source": "gc" }` |
| `client_<tag>.leads` (Basco / Peterson maps) | `azpapwtnrbzywlnxxecz` | `{ "source": "basco" }` or `{ "source_schema": "client_basco", "source_table": "leads", "icp_only": true }` |
| `permit_parcel.operators` (domains only) | `kemvxzhcxvynmoutwdrh` | `{ "source": "permit_parcel.operators", "owner_segments": ["private","religious_nonprofit"] }` |

`public.basco_leads` / `public.peterson_leads` were dropped — use `client_basco.leads` / `client_peterson.leads`. Unknown param keys rejected. Zero source rows → job **failed**.

## Example prompts Claude should turn into tools

- "Inventory Peterson" → `lp_inventory`
- "Backfill Peterson from gc" → `lp_run(backfill, params={source:"gc"})`
- "Ingest these Apify SERP run IDs for Basco service personas" → `lp_run(ingest_serp, …)` (never curl Apify in chat)
- "Find roof DMs for Peterson, cap $20" → `lp_plan` then `lp_run(find_dms_by_title, …)` — paid; scope tightly
- "Enrich Peterson DMs missing email, stop at LeadMagic, cap $20" → `lp_plan` then `lp_run(enrich_contacts, …)`
- "Requeue the four remaining Culture Fits campaigns from storage" → `lp_run(import_smartlead, …)`
- "How's job &lt;id&gt;?" → `lp_status`
