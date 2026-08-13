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
