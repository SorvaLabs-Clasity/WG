import { Router, Request, Response } from "express";

import { createOctokit } from "../github/client";
import { sanitizeError } from "../utils/errorSanitizer";
import { sendIfRateLimited } from "../utils/rateLimit";
import {
  buildInventory, matchResources, consoleUrl, type Inventory, type Resource,
} from "../services/awsInventoryService";
import { defaultProviders, relationshipsTo, resolveProviderRegion } from "../services/awsProviders";
import { assessBlastRadius } from "../services/blastRadiusService";
import { findSourceRefs, searcherFor, clearSourceSearchCache } from "../services/sourceSearchService";
import { expertsForResource } from "../services/resourceExpertsService";
import { parseSecurityGroups, driftForSecurityGroup } from "../services/iacParseService";
import type { SourceRef } from "../services/blastRadiusService";

const router = Router();
const org = () => process.env.GITHUB_ORG || "";

/**
 * Looking up an AWS resource, and what depends on it.
 *
 * Everything here reads with the **operator's own AWS credentials** — the
 * default chain, which in the desktop process is whoever signed in. There is no
 * assume-role and no new grant: the person asking whether a queue is safe to
 * delete is the person who can already see it.
 *
 * ## Why the inventory is held between requests
 *
 * A lookup needs the whole account listed, because "which Lambda consumes this
 * queue" cannot be answered without the Lambdas. Listing is free but not
 * instant — a few hundred milliseconds per service — and a person searching
 * types more than once. Held for a minute, so a search-as-you-type costs one
 * listing rather than one per keystroke, and a resource created moments ago
 * still appears within the minute.
 */
const INVENTORY_CACHE_MS = 60_000;
let cached: { at: number; inventory: Inventory } | null = null;
let inFlight: Promise<Inventory> | null = null;

async function inventory(force = false): Promise<Inventory> {
  if (!force && cached && Date.now() - cached.at < INVENTORY_CACHE_MS) return cached.inventory;
  // Shared, so several requests arriving together list the account once rather
  // than once each.
  if (!force && inFlight) return inFlight;

  inFlight = (async () => {
    // Before anything is listed: console links have to name a region, and the
    // region only comes from the SDK when it lives in a profile rather than the
    // environment.
    await resolveProviderRegion();
    const built = await buildInventory(defaultProviders());
    cached = { at: Date.now(), inventory: built };
    return built;
  })();
  try {
    return await inFlight;
  } finally {
    // Cleared whether it resolved or threw: a rejected promise left here would
    // be handed to every later caller, so one failed listing would keep failing
    // for the life of the process.
    inFlight = null;
  }
}

/**
 * What is in this account, and what could not be read.
 *
 * The unreadable list is returned on success rather than as an error. A person
 * with no `lambda:ListFunctions` should still get their S3 buckets, and should
 * be told exactly what is missing rather than shown a shorter list.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    // One way to refresh, not two.
    //
    // This began as a separate `POST /refresh`, which `repro-undo` rejected for
    // naming no authorization guard — correctly, since its rule is structural
    // and does not care that the body of that route only dropped a cache. The
    // route was redundant with this parameter anyway, so it is gone rather than
    // exempted: a guard weakened once is a guard weakened.
    const force = req.query.refresh === "true";
    if (force) clearSourceSearchCache();
    const inv = await inventory(force);
    const q = String(req.query.q ?? "");
    const matches = q ? matchResources(inv, q) : inv.all;

    res.json({
      total: inv.all.length,
      matched: matches.length,
      // Capped: a search box does not need four thousand rows, and the count
      // above says how many there were.
      resources: matches.slice(0, 200).map(r => ({ ...r, url: consoleUrl(r, r.detail) })),
      services: [...inv.byService.entries()].map(([service, r]) => ({
        service, ok: r.ok, count: r.items.length, error: r.error ?? null,
      })),
      unreadable: inv.unreadable,
      readAt: cached?.at ? new Date(cached.at).toISOString() : null,
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "AWS resources") });
  }
});

/**
 * What breaks if this is deleted.
 *
 * Both halves: the AWS relationships, and every place in the organization's
 * source that names it. The GitHub half uses the caller's own token, so it sees
 * exactly the repositories that person can see — a blast radius listing a
 * private repository they cannot open would be a leak, not a feature.
 */
router.get("/blast", async (req: Request, res: Response) => {
  const service = String(req.query.service ?? "");
  const name = String(req.query.name ?? "");
  if (!service || !name) {
    return res.status(400).json({ error: "service and name are required" });
  }

  const token = req.user?.accessToken;
  if (!token) return res.status(401).json({ error: "No GitHub token provided" });

  try {
    const inv = await inventory();
    const target: Resource | undefined =
      inv.all.find(r => r.service === service && r.name === name);
    if (!target) {
      return res.status(404).json({
        error: `No ${service} resource named "${name}" in this account`,
        // The likeliest reason, and it is not "it does not exist".
        hint: inv.unreadable.some(u => u.service === service)
          ? `${service} could not be read: ${inv.unreadable.find(u => u.service === service)!.error}`
          : undefined,
      });
    }

    const providers = defaultProviders();
    const awsRefs = await relationshipsTo(target, inv, providers);
    const octokit = createOctokit(token);
    const search = searcherFor(octokit);

    const blast = await assessBlastRadius(target, {
      inventory: inv,
      awsRefs,
      searchSource: (term) => findSourceRefs(term, org(), search),
    });

    // Who has actually worked on the files that name it.
    //
    // Costs no code search of its own — the blast radius already found the
    // files, and this reads their commit history. Skipped entirely when there
    // are none, because there is nothing to read and the answer would be an
    // empty list dressed up as a result.
    const experts = blast.sourceRefs.length > 0
      ? await expertsForResource(blast.sourceRefs, {
          listCommits: async (repo, path) => {
            const [owner, name] = repo.split("/");
            const { data } = await (octokit as any).rest.repos.listCommits({
              owner, repo: name, path, per_page: 100,
            });
            return data.map((c: any) => ({
              login: c.author?.login ?? c.committer?.login,
              at: c.commit?.author?.date,
            }));
          },
        })
      : null;

    // Drift, for the resources whose declared shape can be compared.
    //
    // Only reaches for file contents when there is a Terraform reference to
    // read: no references means nothing to compare, and fetching nothing is
    // cheaper than fetching and discovering that.
    const drift = target.service === "ec2-sg"
      ? await driftFor(target, blast.sourceRefs, octokit)
      : null;

    res.json({
      ...blast,
      // The target's own console link, so the header can offer it.
      targetUrl: consoleUrl(target, target.detail),
      experts, drift,
    });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "AWS resources") });
  }
});

/**
 * Read the Terraform that references a group, and compare.
 *
 * Capped at six files. Each is a `getContent` call, and a group named in
 * thirty files is one whose declaration is in the first few — the rest are
 * usages. Failure to read a file is a note rather than a thrown error, because
 * a drift report that vanishes because one file is unreadable is a report
 * nobody gets.
 */
async function driftFor(target: Resource, refs: SourceRef[], octokit: any) {
  const tf = refs.filter(r => r.kind === "terraform").slice(0, 6);
  if (tf.length === 0) {
    return {
      findings: [], comparable: false, declaredIn: null,
      notes: ["No Terraform file in any repository you can see names this group."],
    };
  }

  const declarations: Array<{ repo: string; path: string; groups: ReturnType<typeof parseSecurityGroups> }> = [];
  const unreadable: string[] = [];

  for (const ref of tf) {
    try {
      const [owner, name] = ref.repo.split("/");
      const { data } = await octokit.rest.repos.getContent({ owner, repo: name, path: ref.path });
      const content = (data as any).content;
      if (typeof content !== "string") { unreadable.push(ref.path); continue; }
      declarations.push({
        repo: ref.repo, path: ref.path,
        groups: parseSecurityGroups(Buffer.from(content, "base64").toString("utf8")),
      });
    } catch {
      unreadable.push(`${ref.repo}/${ref.path}`);
    }
  }

  const ingress = ((target.detail?.ingress ?? []) as any[]).map(r => ({
    protocol: String(r.protocol), from: r.from ?? null, to: r.to ?? null,
    cidrs: (r.cidrs ?? []) as string[],
  }));

  const report = driftForSecurityGroup({ name: target.name, ingress }, declarations);
  return {
    ...report,
    // An unreadable file makes the declaration incomplete, and an incomplete
    // declaration cannot be compared — the same rule as everywhere else here.
    comparable: report.comparable && unreadable.length === 0,
    findings: unreadable.length > 0 ? [] : report.findings,
    notes: unreadable.length > 0
      ? [...report.notes, `Could not read ${unreadable.join(", ")}, so this comparison is incomplete.`]
      : report.notes,
  };
}

export default router;
