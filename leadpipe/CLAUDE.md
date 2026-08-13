# LeadPipe — use this instead of moving lead data through chat

When working on leads, campaigns, Smartlead imports, or contact/company rows:

**Prefer LeadPipe MCP tools.** Do not pull full lists into context. Do not page vendor APIs in chat. Do not paste CSVs or `_clean.json` contents into messages.

## Default is FREE — no $400 plans

LeadPipe’s normal jobs cost **$0**:

| Job | Cost |
|-----|------|
| `backfill` | $0 |
| `ingest_serp` | $0 |
| `import_smartlead` / `sync_smartlead` / `build_suppression` | $0 |

**Do not** call `lp_plan` / `find_dms_by_title` / `enrich_contacts` / `verify_emails` unless the user **explicitly** asks to spend vendor credits.

Paid kinds are hard-blocked unless `params.confirm_paid_vendor=true` **and** `approve_cost_usd` is set. Gaps like “companies missing DM email” are **not** a signal to run LeadMagic.

The ~$400 figure Claude invents is `find_dms_by_title` × ~4k companies via LeadMagic. That is opt-in only. For Basco / franchise / LinkedIn SERP people → **`ingest_serp` only**.

## Tools (counts / IDs only)

| Need | Tool |
|------|------|
| Client snapshot | `lp_inventory` |
| Start free work | `lp_run` → get `job_id` |
| Progress | `lp_status` |
| Eyeball quality | `lp_sample` (≤10 rows) |
| Download for humans | `lp_export` → signed URL |
| Paid estimate (rare) | `lp_plan` only when user asks to spend |

## Rules

1. Never call vendor tools that return lead rows into this conversation when a LeadPipe job exists.
2. Pass `client_tag` every time (`peterson`, `basco`, `culture_fits`, `parlay`, `msrs`, `bcp`).
3. Default: free jobs only. Never propose a paid plan unprompted.
4. For Smartlead requeue: upload `_clean.json` to storage, then `import_smartlead` with `expected_upload` + `expected_final_count`.
5. Success = `useful_output_count` / verified live membership — not rows processed.
6. If LeadPipe MCP is unavailable, say so and stop — do not fall back to dumping data into context.

## SERP ingest (Basco / franchise LinkedIn people)

```
lp_run(
  job_kind="ingest_serp",
  client_tag="basco",
  approve_cost_usd=0,
  params={
    "storage_paths": ["serp/basco/<runId>.json", …],
    # OR "apify_run_ids": ["…"] if APIFY_TOKEN can read runs
    "target_titles": "Service Director,Fixed Operations Director,Service Manager,Assistant Service Manager,Warranty Administrator,Parts and Service Director",
    "persona": "service_side"
  }
)
```

Then `lp_status`. Company + title filter server-side; writes `lp.contacts` and `client_<tag>.contacts` with `persona`.

## Backfill

| Source | Params |
|--------|--------|
| `gc.companies` + `gc.contacts` | `{ "source": "gc" }` |
| `client_<tag>.leads` | `{ "source": "basco" }` / `{ "source": "peterson" }` |
| `permit_parcel.operators` | `{ "source": "permit_parcel.operators", "owner_segments": ["private","religious_nonprofit"] }` |

Unknown param keys rejected. Zero source rows → job **failed**.

## Example prompts → tools

- "Inventory Basco" → `lp_inventory`
- "Backfill Basco" → `lp_run(backfill, params={source:"basco"})`
- "Ingest these Apify SERP runs for Basco service personas" → `lp_run(ingest_serp, …)` — **$0**
- "How's job &lt;id&gt;?" → `lp_status`
- "Spend LeadMagic to find DMs" (user must say spend) → `lp_plan` then `lp_run(find_dms_by_title, params={confirm_paid_vendor:true}, approve_cost_usd=…)`
