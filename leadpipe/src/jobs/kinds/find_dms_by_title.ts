import type { JobHandler } from "../runner.js";
import { seedEntityKeys, storeRawPayload } from "../runner.js";
import {
  isRoofRelevantTitle,
  isDecisionMakerTitle,
  isUsPerson,
} from "../../lib/dm.js";

/**
 * find_dms_by_title — biggest immediate win.
 * Bulk employee_finder → title filter in-process (free) → work_email_finder on survivors only.
 *
 * Default title mode is "roof" (property/facilities ICP). Pass params.title_mode="exec"
 * for broad owner/CEO/VP matching.
 */
export const runFindDmsByTitle: JobHandler = {
  async seed(ctx) {
    const params = ctx.job.params as {
      domains?: string[];
      only_missing_dm?: boolean;
    };

    let domains = params.domains ?? [];
    if (domains.length === 0) {
      const { data, error } = await ctx.db
        .from("companies")
        .select("domain")
        .eq("client_tag", ctx.job.client_tag)
        .not("domain", "is", null);
      if (error) throw new Error(error.message);
      domains = (data ?? []).map((r) => r.domain as string).filter(Boolean);

      // Default: skip companies that already have a DM-grade contact with email
      if (params.only_missing_dm !== false) {
        const { data: haveDm } = await ctx.db
          .from("contacts")
          .select("domain")
          .eq("client_tag", ctx.job.client_tag)
          .eq("is_dm", true)
          .not("email", "is", null);
        const have = new Set(
          (haveDm ?? []).map((r) => String(r.domain ?? "").toLowerCase()),
        );
        domains = domains.filter((d) => !have.has(d.toLowerCase()));
      }
    }

    const unique = [...new Set(domains.map((d) => d.toLowerCase().trim()))];
    if (unique.length === 0) {
      throw new Error(
        "find_dms_by_title: zero companies to process (lp.companies empty or all already have DM emails). Run backfill first.",
      );
    }
    await seedEntityKeys(ctx.db, ctx.job.id, unique);
    return { rows_total: unique.length };
  },

  async processRow(ctx, domain) {
    const params = ctx.job.params as { title_mode?: string };
    const titleMode = params.title_mode === "exec" ? "exec" : "roof";
    const titleFn =
      titleMode === "exec" ? isDecisionMakerTitle : isRoofRelevantTitle;

    // LeadMagic economics: ~0.05 credits/employee returned; 1 credit/email hit.
    // Config USD estimates stay under getleads_* keys for plan compatibility.
    const unitFinder = ctx.config.costs.getleads_employee_finder ?? 0.005;
    const unitEmail = ctx.config.costs.getleads_work_email_finder ?? 0.05;
    let cost = 0;
    let useful = false;
    let employeesFound = 0;
    let dms = 0;
    let emails = 0;

    const employees = await ctx.vendors.leadmagicEmployeeFinder(domain, {
      limit: 10,
    });
    cost += employees.length * unitFinder;
    employeesFound = employees.length;

    await storeRawPayload(ctx.db, {
      job_id: ctx.job.id,
      vendor: "leadmagic",
      entity_key: `employee_finder:${domain}`,
      payload: employees,
    });

    const dmCandidates = employees.filter(
      (e) => titleFn(e.job_title) && isUsPerson(e),
    );
    dms = dmCandidates.length;

    for (const person of dmCandidates) {
      const first = person.first_name ?? "";
      const last = person.last_name ?? "";
      let email = person.email?.trim() || null;
      let emailStatus: string | null = email ? "provided" : null;

      if (!email && (first || last)) {
        try {
          const found = await ctx.vendors.leadmagicWorkEmailFinder({
            domain,
            first_name: first,
            last_name: last,
          });
          cost += unitEmail;
          await storeRawPayload(ctx.db, {
            job_id: ctx.job.id,
            vendor: "leadmagic",
            entity_key: `work_email:${domain}:${first}:${last}`,
            payload: found,
          });
          email = found.email?.trim() || null;
          emailStatus = found.status ?? (email ? "found" : "not_found");
        } catch (err) {
          emailStatus = err instanceof Error ? err.message.slice(0, 200) : "error";
        }
      }

      if (email) {
        emails += 1;
        useful = true;
        await ctx.db.from("contacts").upsert(
          {
            client_tag: ctx.job.client_tag,
            domain,
            first_name: first || null,
            last_name: last || null,
            job_title: person.job_title ?? null,
            email,
            email_status: emailStatus,
            linkedin_url: person.linkedin_url ?? null,
            source_tool: "leadmagic",
            source_tier: "leadmagic",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "client_tag,domain,email" },
        );
      } else {
        // No email yet — insert as provisional (unique allows multiple null emails in PG)
        const { data: existing } = await ctx.db
          .from("contacts")
          .select("id")
          .eq("client_tag", ctx.job.client_tag)
          .eq("domain", domain)
          .eq("first_name", first)
          .eq("last_name", last)
          .is("email", null)
          .limit(1);
        if (!existing?.length) {
          await ctx.db.from("contacts").insert({
            client_tag: ctx.job.client_tag,
            domain,
            first_name: first || null,
            last_name: last || null,
            job_title: person.job_title ?? null,
            email: null,
            email_status: emailStatus,
            linkedin_url: person.linkedin_url ?? null,
            source_tool: "leadmagic",
            source_tier: "leadmagic",
            metadata: { from_job: ctx.job.id },
          });
        }
      }
    }

    return {
      useful,
      cost_usd: +cost.toFixed(4),
      summary: {
        employees_found: employeesFound,
        dms_by_title: dms,
        emails_found: emails,
      },
    };
  },

  async summarize(ctx) {
    const { data: rowStats } = await ctx.db
      .from("job_rows")
      .select("result_summary")
      .eq("job_id", ctx.job.id)
      .eq("status", "done");

    let employees = 0;
    let dms = 0;
    let emails = 0;
    for (const r of rowStats ?? []) {
      const s = (r.result_summary ?? {}) as Record<string, number>;
      employees += s.employees_found ?? 0;
      dms += s.dms_by_title ?? 0;
      emails += s.emails_found ?? 0;
    }

    return {
      useful_output_count: emails,
      employees_found: employees,
      dms_by_title: dms,
      emails_found: emails,
    };
  },
};
