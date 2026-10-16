import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDecisionMakerTitle, isRoofRelevantTitle } from "../src/lib/dm.js";
import { validateBackfillParams } from "../src/lib/backfill_params.js";
import { gateCost } from "../src/lib/cost.js";
import { stripHtmlFields } from "../src/vendors/index.js";
import { hashParams } from "../src/db/client.js";
import { JOB_KINDS } from "../src/config.js";
import {
  assertBatchImport,
  chunkLeads,
  verifyCampaignTotals,
} from "../src/lib/smartlead_import.js";
import { validateIngestSerpParams } from "../src/lib/ingest_serp_params.js";
import { validateIngestCsvParams } from "../src/lib/ingest_csv_params.js";
import {
  assertClientTag,
  normalizeClientTag,
} from "../src/lib/client_tag.js";
import {
  mapRawRow,
  resolveColumnMap,
  rowPassesFilters,
} from "../src/lib/csv_headers.js";
import {
  escapeCsvField,
  parseSimpleFilterSql,
  resolveExportWhere,
  toCsv,
} from "../src/lib/csv_format.js";
import { parseCsv, parseTabularFile } from "../src/lib/csv_download.js";
import {
  companyMatches,
  extractSerpPeople,
  titleMatches,
} from "../src/lib/serp_match.js";

const SERVICE_TITLES = [
  "Service Director",
  "Fixed Operations Director",
  "Service Manager",
  "Assistant Service Manager",
  "Warranty Administrator",
  "Parts and Service Director",
];

describe("job kinds are pass-through only", () => {
  it("has no paid enrichment kinds", () => {
    assert.ok(!JOB_KINDS.includes("find_dms_by_title" as never));
    assert.ok(!JOB_KINDS.includes("enrich_contacts" as never));
    assert.ok(!JOB_KINDS.includes("verify_emails" as never));
    assert.ok(JOB_KINDS.includes("ingest_serp"));
    assert.ok(JOB_KINDS.includes("ingest_csv"));
    assert.ok(JOB_KINDS.includes("backfill"));
  });
});

describe("isDecisionMakerTitle", () => {
  it("accepts owner/ceo/vp titles", () => {
    assert.equal(isDecisionMakerTitle("Owner"), true);
    assert.equal(isDecisionMakerTitle("CEO"), true);
    assert.equal(isDecisionMakerTitle("VP of Operations"), true);
  });

  it("rejects assistants and empties", () => {
    assert.equal(isDecisionMakerTitle("Assistant to the CEO"), false);
    assert.equal(isDecisionMakerTitle(""), false);
  });
});

describe("roof title filter", () => {
  it("keeps property/facilities roles", () => {
    assert.equal(isRoofRelevantTitle("Property Manager"), true);
    assert.equal(isRoofRelevantTitle("Director of Facilities"), true);
  });
  it("drops CFO/HR/legal", () => {
    assert.equal(isRoofRelevantTitle("CFO"), false);
    assert.equal(isRoofRelevantTitle("HR Manager"), false);
  });
});

describe("backfill param validation", () => {
  it("rejects unknown keys with expected list", () => {
    const v = validateBackfillParams({ source: "gc", foo: 1 });
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.error, /Unknown backfill params: foo/);
  });
  it("accepts source=gc as companies+contacts", () => {
    const v = validateBackfillParams({ source: "gc" });
    assert.equal(v.ok, true);
    if (v.ok) assert.deepEqual(v.tasks, ["gc_companies", "gc_contacts"]);
  });
  it("accepts basco → client_basco.leads", () => {
    const v = validateBackfillParams({ source: "basco", icp_only: true });
    assert.equal(v.ok, true);
    if (v.ok) assert.deepEqual(v.tasks, ["client_leads:client_basco"]);
  });
  it("accepts arbitrary client tag as source", () => {
    const v = validateBackfillParams({ source: "acme_roofing" });
    assert.equal(v.ok, true);
    if (v.ok) assert.deepEqual(v.tasks, ["client_leads:client_acme_roofing"]);
  });
  it("rejects empty params", () => {
    const v = validateBackfillParams({});
    assert.equal(v.ok, false);
  });
});

describe("cost gating", () => {
  it("gates above ceiling", () => {
    const g = gateCost(25, 20, 50);
    assert.equal(g.ok, false);
    assert.match(g.reason!, /exceeds approved ceiling/);
  });

  it("allows under approve_cost_usd", () => {
    assert.equal(gateCost(19.5, 20, 50).ok, true);
  });
});

describe("stripHtmlFields", () => {
  it("strips email bodies and html", () => {
    const cleaned = stripHtmlFields({
      email: "a@b.com",
      email_body: "<html><body>huge</body></html>",
      status: "bounced",
    });
    assert.equal(cleaned.email, "a@b.com");
    assert.equal(cleaned.email_body, "[stripped]");
    assert.equal(cleaned.status, "bounced");
  });
});

describe("hashParams idempotency", () => {
  it("is order-independent", () => {
    assert.equal(
      hashParams({ a: 1, b: { z: 2, y: 3 } }),
      hashParams({ b: { y: 3, z: 2 }, a: 1 }),
    );
  });
});

describe("ingest_serp params", () => {
  it("rejects unknown keys", () => {
    const v = validateIngestSerpParams({
      apify_run_ids: ["abc"],
      target_titles: "Service Manager",
      persona: "service_side",
      foo: 1,
    });
    assert.equal(v.ok, false);
  });

  it("accepts storage_paths", () => {
    const v = validateIngestSerpParams({
      storage_paths: ["serp/basco/a.json"],
      target_titles: "Service Manager",
      persona: "service_side",
    });
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.deepEqual(v.params.entity_keys, ["storage:serp/basco/a.json"]);
    }
  });
});

describe("serp company/title filters", () => {
  it("rejects OEM-only company overlap", () => {
    assert.equal(
      companyMatches("Nissan of Norwich", "Middletown Nissan"),
      false,
    );
    assert.equal(
      companyMatches("Devan Acura Of Norwalk", "Devan Acura of Norwalk"),
      true,
    );
  });

  it("matches contiguous service titles only", () => {
    assert.equal(titleMatches("Service Manager", SERVICE_TITLES), true);
    assert.equal(
      titleMatches("Customer Service Manager", SERVICE_TITLES),
      false,
    );
  });

  it("extracts matched SERP people and drops noise", () => {
    const people = extractSerpPeople(
      [
        {
          searchQuery: {
            term:
              'site:linkedin.com/in "Devan Acura Of Norwalk" ("Service Manager")',
          },
          organicResults: [
            {
              title: "Douglas Dente - Service Manager - Devan Acura Of Norwalk",
              url: "https://www.linkedin.com/in/douglas-dente",
              personalInfo: {
                jobTitle: "Service Manager",
                companyName: "Devan Acura Of Norwalk",
              },
            },
            {
              title: "Robert Clement - Service Manager - Nissan of Norwich",
              url: "https://www.linkedin.com/in/robert-clement",
              personalInfo: {
                jobTitle: "Service Manager",
                companyName: "Nissan of Norwich",
              },
            },
          ],
        },
      ],
      { targetTitles: SERVICE_TITLES, requireCompanyMatch: true },
    );
    assert.equal(people.length, 1);
    assert.equal(people[0]!.first_name, "Douglas");
  });
});

describe("smartlead import assertions", () => {
  it("rejects upload_count mismatch vs sent", () => {
    const r = assertBatchImport({
      upload_count: 150,
      block_count: 0,
      sent: 151,
    });
    assert.equal(r.ok, false);
  });

  it("passes when live membership matches target", () => {
    const r = verifyCampaignTotals({
      campaign_id: "3781912",
      expected_upload: 151,
      uploaded_total: 151,
      block_total: 0,
      expected_final_count: 3384,
      live_count: 3384,
      emails_checked: 151,
      emails_missing: 0,
    });
    assert.equal(r.ok, true);
  });

  it("chunks leads for resumable batches", () => {
    assert.equal(chunkLeads(Array(251).fill(0), 100).length, 3);
  });
});

describe("client_tag", () => {
  it("normalizes and accepts new tags", () => {
    assert.equal(normalizeClientTag("Acme Roofing"), "acme_roofing");
    assert.equal(assertClientTag("acme_roofing"), "acme_roofing");
  });
  it("rejects reserved tags", () => {
    assert.throws(() => assertClientTag("lp"), /reserved/);
    assert.throws(() => assertClientTag("public"), /reserved/);
  });
});

describe("ingest_csv params", () => {
  it("requires urls and source_label", () => {
    const v = validateIngestCsvParams({});
    assert.equal(v.ok, false);
  });

  it("rejects unknown keys", () => {
    const v = validateIngestCsvParams({
      urls: ["https://example.com/a.csv"],
      source_label: "test",
      foo: 1,
    });
    assert.equal(v.ok, false);
  });

  it("accepts getleads-shaped params", () => {
    const v = validateIngestCsvParams({
      urls: ["https://example.com/a.csv"],
      source_label: "getleads_crowdstrike_20260814",
      dedupe_key: "email",
      exclude_name_patterns: ["MSP", "Reseller"],
      exclude_domain_list: ["https://WWW.Spam.com/path"],
    });
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.params.exclude_domain_list[0], "spam.com");
      assert.deepEqual(v.params.exclude_name_patterns, ["msp", "reseller"]);
    }
  });
});

describe("csv header dialects", () => {
  it("auto-detects getleads headers", () => {
    const r = resolveColumnMap([
      "First Name",
      "Last Name",
      "Email",
      "Current Job Title",
      "Company Name",
      "Company Domain",
      "Email Verification Status",
    ]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.dialect, "getleads");
      assert.equal(r.map.email, "Email");
      assert.equal(r.map.company_domain, "Company Domain");
      assert.equal(r.map.title, "Current Job Title");
      // Bare getleads slice without geo/firmographics → surface unresolved
      assert.deepEqual(r.unresolved_optional, [
        "city",
        "state",
        "industry",
        "employee_range",
      ]);
    }
  });

  it("maps getleads firmographic + geo headers (not bare Industry/State)", () => {
    // Real getleads export headers (from lp.raw_payloads on Parlay ingest)
    const r = resolveColumnMap([
      "First Name",
      "Last Name",
      "Email",
      "Current Job Title",
      "Company Name",
      "Company Domain",
      "Contact City",
      "Contact State",
      "Work State",
      "Company Industry (LinkedIn)",
      "Employee Count Range",
      "Email Verification Status",
    ]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.dialect, "getleads");
      assert.equal(r.map.city, "Contact City");
      assert.equal(r.map.state, "Contact State");
      assert.equal(r.map.industry, "Company Industry (LinkedIn)");
      assert.equal(r.map.employee_range, "Employee Count Range");
      assert.deepEqual(r.unresolved_optional, []);

      const row = mapRawRow(
        {
          Email: "a@acme.com",
          "Company Domain": "acme.com",
          "Contact City": "Austin",
          "Contact State": "TX",
          "Work State": "CA",
          "Company Industry (LinkedIn)": "Computer Software",
          "Employee Count Range": "51-200",
        },
        r.map,
      );
      assert.equal(row.city, "Austin");
      assert.equal(row.state, "TX");
      assert.equal(row.industry, "Computer Software");
      assert.equal(row.employee_range, "51-200");
    }
  });

  it("maps Contact City / Contact State from minimal getleads headers", () => {
    const r = resolveColumnMap([
      "Email",
      "Contact City",
      "Contact State",
      "Company Domain",
    ]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.map.city, "Contact City");
      assert.equal(r.map.state, "Contact State");
      const row = mapRawRow(
        {
          Email: "x@y.com",
          "Company Domain": "y.com",
          "Contact City": "Denver",
          "Contact State": "CO",
        },
        r.map,
      );
      assert.equal(row.city, "Denver");
      assert.equal(row.state, "CO");
    }
  });

  it("fails clearly when email/domain missing", () => {
    const r = resolveColumnMap(["First Name", "Company Name"]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /Cannot resolve required fields/);
      assert.match(r.error, /Headers found/);
    }
  });

  it("applies exclude filters", () => {
    const row = mapRawRow(
      {
        Email: "a@b.com",
        "Company Domain": "acme.com",
        "Company Name": "Acme MSP Services",
      },
      {
        first_name: null,
        last_name: null,
        email: "Email",
        title: null,
        company_name: "Company Name",
        company_domain: "Company Domain",
        city: null,
        state: null,
        industry: null,
        employee_range: null,
      },
    );
    assert.equal(rowPassesFilters(row, ["msp"], []), false);
    assert.equal(rowPassesFilters(row, [], ["acme.com"]), false);
    assert.equal(rowPassesFilters(row, ["reseller"], ["other.com"]), true);
  });
});

describe("csv parse", () => {
  it("parses quoted commas", () => {
    const rows = parseCsv('a,b\n"1,2",3\n');
    assert.deepEqual(rows[0], ["a", "b"]);
    assert.deepEqual(rows[1], ["1,2", "3"]);
  });

  it("parses buffer as csv", () => {
    const buf = Buffer.from("Email,Company Domain\na@b.com,acme.com\n", "utf8");
    const p = parseTabularFile(buf, { filename_hint: "x.csv" });
    assert.equal(p.ok, true);
    if (p.ok) {
      assert.equal(p.format, "csv");
      assert.equal(p.rows.length, 1);
      assert.equal(p.rows[0]!.Email, "a@b.com");
    }
  });
});

describe("csv export format", () => {
  it("quotes commas and round-trips company names", () => {
    const csv = toCsv(
      [{ email: "a@b.com", company_name: "Acme, Inc.", city: "Austin" }],
      ["email", "company_name", "city"],
    );
    assert.equal(
      csv,
      'email,company_name,city\na@b.com,"Acme, Inc.",Austin',
    );
    assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
    assert.deepEqual(parseSimpleFilterSql("ev_status = 'sendable'"), {
      ev_status: "sendable",
    });
    assert.deepEqual(parseSimpleFilterSql("band = 'A' AND mail_class = '1'"), {
      band: "A",
      mail_class: "1",
    });
    const w = resolveExportWhere({ segment: "owner" }, "ev_status = 'sendable'");
    assert.equal(w.ok, true);
    if (w.ok) {
      assert.deepEqual(w.preds, { segment: "owner", ev_status: "sendable" });
    }
  });

  it("exports exactly requested columns in order", () => {
    const csv = toCsv(
      [{ email: "a@b.com", city: "Austin", state: "TX", extra: "drop" }],
      ["email", "city"],
    );
    assert.equal(csv, "email,city\na@b.com,Austin");
  });

  it("rejects unsafe filter_sql", () => {
    assert.equal(parseSimpleFilterSql("ev_status = sendable; drop table"), null);
    const w = resolveExportWhere(undefined, "1=1");
    assert.equal(w.ok, false);
  });
});
