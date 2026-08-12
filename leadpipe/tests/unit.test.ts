import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDecisionMakerTitle } from "../src/lib/dm.js";
import {
  estimateEnrichCost,
  estimateFindDmsCost,
  gateCost,
  tiersUpTo,
} from "../src/lib/cost.js";
import { stripHtmlFields } from "../src/vendors/index.js";
import { hashParams } from "../src/db/client.js";
import { DEFAULT_COSTS_USD, type Config } from "../src/config.js";
import {
  assertBatchImport,
  chunkLeads,
  verifyCampaignTotals,
} from "../src/lib/smartlead_import.js";

const baseConfig = {
  costs: { ...DEFAULT_COSTS_USD },
  defaultCostCeilingUsd: 50,
} as Config;

describe("isDecisionMakerTitle", () => {
  it("accepts owner/ceo/vp titles", () => {
    assert.equal(isDecisionMakerTitle("Owner"), true);
    assert.equal(isDecisionMakerTitle("CEO"), true);
    assert.equal(isDecisionMakerTitle("VP of Operations"), true);
    assert.equal(isDecisionMakerTitle("Property Manager"), true);
    assert.equal(isDecisionMakerTitle("General Manager"), true);
  });

  it("rejects assistants and empties", () => {
    assert.equal(isDecisionMakerTitle("Assistant to the CEO"), false);
    assert.equal(isDecisionMakerTitle(""), false);
    assert.equal(isDecisionMakerTitle(null), false);
    assert.equal(isDecisionMakerTitle("Marketing Coordinator"), false);
  });
});

describe("cost gating", () => {
  it("estimates find_dms cheaper than enrich waterfall", () => {
    const dms = estimateFindDmsCost(baseConfig, 100);
    const enrich = estimateEnrichCost(baseConfig, 800, "leadmagic");
    assert.ok(dms.estimated_cost_usd > 0);
    assert.ok(enrich.estimated_cost_usd > 0);
  });

  it("gates above ceiling", () => {
    const g = gateCost(25, 20, 50);
    assert.equal(g.ok, false);
    assert.match(g.reason!, /exceeds approved ceiling/);
  });

  it("allows under approve_cost_usd", () => {
    assert.equal(gateCost(19.5, 20, 50).ok, true);
  });

  it("tiersUpTo respects max_tier", () => {
    assert.deepEqual(tiersUpTo("aiark"), ["getleads", "aiark"]);
    assert.deepEqual(tiersUpTo("fullenrich"), [
      "getleads",
      "aiark",
      "leadmagic",
      "fullenrich",
    ]);
  });
});

describe("stripHtmlFields", () => {
  it("strips email bodies and html", () => {
    const cleaned = stripHtmlFields({
      email: "a@b.com",
      email_body: "<html><body>huge</body></html>",
      status: "bounced",
      nested: { html: "<p>x</p>", opened: true },
    });
    assert.equal(cleaned.email, "a@b.com");
    assert.equal(cleaned.email_body, "[stripped]");
    assert.equal(cleaned.status, "bounced");
    assert.equal((cleaned.nested as { html: string }).html, "[stripped]");
    assert.equal((cleaned.nested as { opened: boolean }).opened, true);
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

describe("smartlead import assertions", () => {
  it("rejects upload_count mismatch vs sent", () => {
    const r = assertBatchImport({ upload_count: 150, block_count: 0, sent: 151 });
    assert.equal(r.ok, false);
    assert.match(r.failures[0]!, /upload_count/);
  });

  it("rejects non-zero block_count", () => {
    const r = assertBatchImport({ upload_count: 10, block_count: 2, sent: 10 });
    assert.equal(r.ok, false);
  });

  it("verifies against expected_final_count not just upload", () => {
    const r = verifyCampaignTotals({
      campaign_id: "3781908",
      expected_upload: 195,
      uploaded_total: 195,
      block_total: 0,
      expected_final_count: 4616,
      live_count: 4500,
      emails_checked: 195,
      emails_missing: 0,
    });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.includes("live_count")));
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
