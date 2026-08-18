import { Router, Request, Response } from "express";
import { docClient, usesDynamo, tableName, QueryCommand, ScanCommand } from "../utils/dynamo";
import fs from "fs";
import path from "path";
import { evaluateSecurityQuery } from "../services/graphService";
import { getSystemToken } from "../github/client";
import { sanitizeError } from "../utils/errorSanitizer";
import { sendIfRateLimited } from "../utils/rateLimit";
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";
import { getOrgConfig } from "../services/orgConfigService";

const router = Router();

// Fallback for local development
let localEdges: any[] = [];
function loadLocalEdges() {
  if (localEdges.length > 0) return localEdges;
  try {
    const dataDir = path.join(__dirname, "../../../data");
    const filePath = path.join(dataDir, "graph-edges.json");
    if (fs.existsSync(filePath)) {
      localEdges = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (e) {
    console.warn("Failed to load local graph edges", e);
  }
  return localEdges;
}

// Helper to query DynamoDB for edges originating from a specific node
async function getEdgesForNode(nodeId: string) {
  if (usesDynamo()) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName("GRAPH_EDGES_TABLE"),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": nodeId },
      })
    );
    return result.Items || [];
  } else {
    const edges = loadLocalEdges();
    return edges.filter((e) => e.pk === nodeId);
  }
}

// 1. Expand a single node
router.get("/node/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const nodeId = req.params.id; // e.g. REPO#payments-api or USER#alice
    const edges = await getEdgesForNode(nodeId);
    
    res.json({
      node: nodeId,
      edges: edges.map(e => ({
        target: e.sk,
        type: e.type,
        metadata: e.metadata || {}
      }))
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "graph") });
  }
});

// 2. Blast Radius Analysis for a Repo
// If a repo is compromised, what else is affected?
// e.g. downstream dependencies, workflows, teams that own it.
router.get("/blast-radius/repo/:repo", async (req: Request<{ repo: string }>, res: Response) => {
  try {
    const repoId = `REPO#${req.params.repo}`;
    const edges = await getEdgesForNode(repoId);

    const workflows = edges.filter(e => e.type === "uses_workflow").map(e => e.sk.replace("WORKFLOW#", ""));
    const vulnerableDeps = edges.filter(e => e.type === "has_vulnerable_dependency").map(e => ({
      name: e.sk.replace("DEPENDENCY#", ""),
      severity: e.metadata?.severity
    }));
    const teams = edges.filter(e => e.type === "owned_by_team").map(e => ({
      name: e.sk.replace("TEAM#", ""),
      permission: e.metadata?.permission
    }));
    const directCollaborators = edges.filter(e => e.type === "has_collaborator").map(e => ({
      name: e.sk.replace("USER#", ""),
      role: e.metadata?.role
    }));

    res.json({
      repo: req.params.repo,
      workflows,
      vulnerableDependencies: vulnerableDeps,
      teamsWithAccess: teams,
      directCollaborators,
      riskScore: vulnerableDeps.length > 0 ? "High" : "Low"
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "graph") });
  }
});

// 3. User Impact Analysis
// If a user account is compromised, what happens?
// Get all teams the user is in, and all repos those teams own + direct repo access.
router.get("/user-impact/:user", async (req: Request<{ user: string }>, res: Response) => {
  try {
    const userId = `USER#${req.params.user}`;
    
    // Direct access
    const directEdges = await getEdgesForNode(userId);
    const teams = directEdges.filter(e => e.type === "member_of").map(e => e.sk);
    const directRepos = directEdges.filter(e => e.type === "collaborates_on").map(e => ({
      repo: e.sk.replace("REPO#", ""),
      access: "direct",
      permission: e.metadata?.role || "unknown"
    }));

    const allReposMap = new Map<string, any>();
    directRepos.forEach(r => allReposMap.set(r.repo, r));

    // Team access
    const teamNames = [];
    for (const teamId of teams) {
      teamNames.push(teamId.replace("TEAM#", ""));
      const teamEdges = await getEdgesForNode(teamId);
      const teamRepos = teamEdges.filter(e => e.type === "owns_repo");
      
      for (const tr of teamRepos) {
        const repoName = tr.sk.replace("REPO#", "");
        if (!allReposMap.has(repoName)) {
          allReposMap.set(repoName, {
            repo: repoName,
            access: "via_team",
            team: teamId.replace("TEAM#", ""),
            permission: tr.metadata?.permission || "unknown"
          });
        }
      }
    }

    const allRepos = Array.from(allReposMap.values());
    
    // Calculate how many distinct workflows this user can potentially influence
    let workflowsReachable = 0;
    for (const repo of allRepos) {
      if (repo.permission === "admin" || repo.permission === "write" || repo.permission === "maintain") {
        const repoEdges = await getEdgesForNode(`REPO#${repo.repo}`);
        const wfs = repoEdges.filter(e => e.type === "uses_workflow");
        workflowsReachable += wfs.length;
      }
    }

    res.json({
      user: req.params.user,
      teams: teamNames,
      repos: allRepos,
      writeOrAdminReposCount: allRepos.filter(r => ["admin", "write", "maintain"].includes(r.permission)).length,
      productionPipelinesReachable: workflowsReachable
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "graph") });
  }
});

// 4. Blast Radius Ranking

// 5. Graph metadata (edge count)
router.get("/meta", async (_req: Request, res: Response) => {
  try {
    let count = 0;
    if (usesDynamo()) {
      const result: any = await docClient.send(
        new ScanCommand({ TableName: tableName("GRAPH_EDGES_TABLE"), Select: "COUNT" })
      );
      count = result.Count ?? 0;
    } else {
      count = loadLocalEdges().length;
    }
    res.json({ edgeCount: count });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "graph") });
  }
});

// 6. Query Engine
router.get("/query", async (req: Request, res: Response) => {
  try {
    const q = req.query.q as string;
    const param = req.query.param as string;
    
    const advanced = { ...req.query };
    delete advanced.q;
    delete advanced.param;

    const results = await evaluateSecurityQuery(q, param, advanced, getSystemToken() || req.user?.accessToken);
    res.json(results);
  } catch (error: any) {
    // Not a server fault and not worth a stack trace: the widget names a check
    // that no longer exists, and only editing the widget will fix it.
    const { UnknownQueryError, MissingGraphDataError, PartialQueryError } =
      await import("../services/graphService");
    // 503, not 500: the check works and the data is fine, we simply could not
    // read all of it right now. Saying "try again shortly" is the whole
    // difference between a transient limit and a broken check.
    if (error instanceof PartialQueryError) {
      res.status(503).json({
        error: error.message, code: "QUERY_INCOMPLETE",
        covered: error.covered, total: error.total,
      });
      return;
    }
    if (error instanceof MissingGraphDataError) {
      res.status(409).json({ error: error.message, code: "GRAPH_DATA_MISSING", edgeType: error.edgeType });
      return;
    }
    if (error instanceof UnknownQueryError) {
      res.status(400).json({ error: error.message, code: "UNKNOWN_QUERY", queryId: error.queryId });
      return;
    }
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "graph") });
  }
});

/**
 * How fresh the stored answers are, without asking GitHub anything.
 *
 * Reads only what is already cached, so a card can say "oldest check three
 * hours ago" on every render without that costing a request. A cached finding
 * with no date on it is a claim nobody can weigh.
 */
router.get("/query/:q/freshness", async (req: Request<{ q: string }>, res: Response) => {
  try {
    const { listVerdicts, freshnessOf, isBatched } = await import("../services/queryCacheService");
    if (!isBatched(req.params.q)) {
      // Everything else is derived from the graph on the spot, so "when was
      // this checked" is "now" and there is nothing to report.
      return res.json({ batched: false, checked: 0, oldestAt: null, newestAt: null });
    }
    res.json({ batched: true, ...freshnessOf(await listVerdicts(req.params.q)) });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "graph") });
  }
});

/**
 * Check everything now, rather than waiting for the ordinary passes.
 *
 * Batches back to back with a gap sized to the budget the check draws on, until
 * it is complete or the time budget runs out. Whatever is left is picked up by
 * the scheduled passes, so pressing it twice finishes a very large
 * organization — and the response says which happened rather than leaving the
 * caller to guess.
 *
 * It cannot outrun GitHub and does not try. For a search-backed check that
 * means one batch a minute however hard the button is pressed; the reply says
 * so, because a button that appears to do nothing is worse than one that
 * explains why.
 */
router.post("/query/:q/refresh-all", async (req: Request<{ q: string }>, res: Response) => {
  const login = req.user!.login;
  if (!(await isControlHubAdmin(login).catch(() => false))) {
    return res.status(403).json({
      code: "CONTROL_HUB_ADMIN_REQUIRED",
      error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can force a `
        + `full re-check. It spends the organization's GitHub budget, not yours.`,
    });
  }

  const q = req.params.q;
  const {
    isBatched, clearThrottle, SUBJECT_COST, MANUAL_REFRESH_BUDGET_MS,
  } = await import("../services/queryCacheService");
  const { PartialQueryError } = await import("../services/graphService");

  if (!isBatched(q)) {
    return res.status(400).json({
      error: "This check reads the graph directly and is always current — there is nothing to "
        + "re-check.",
    });
  }

  const token = getSystemToken() || req.user?.accessToken;
  const started = Date.now();
  const gap = SUBJECT_COST[q].gapMs;
  let batches = 0, covered = 0, total = 0, complete = false;

  try {
    while (Date.now() - started < MANUAL_REFRESH_BUDGET_MS) {
      clearThrottle(q);
      try {
        await evaluateSecurityQuery(q, undefined, {}, token);
        complete = true;
        break;
      } catch (err: any) {
        if (!(err instanceof PartialQueryError)) throw err;
        covered = err.covered; total = err.total;
      }
      batches++;
      // Sleeping only if there is time left to use afterwards. Waiting sixty
      // seconds to then return is a minute of nothing.
      if (Date.now() - started + gap >= MANUAL_REFRESH_BUDGET_MS) break;
      await new Promise(r => setTimeout(r, gap));
    }

    res.json({
      complete, batches, covered, total,
      budget: SUBJECT_COST[q].budget,
      message: complete
        ? `Every subject re-checked.`
        : SUBJECT_COST[q].budget === "search"
          ? `Checked ${covered} of ${total}. This check costs one GitHub commit search per `
            + `account and that allowance is thirty a minute, so the rest cannot be hurried — `
            + `they will be covered by the scheduled passes, or press again in a minute.`
          : `Checked ${covered} of ${total} in ${batches} batches. Press again to continue.`,
    });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "graph") });
  }
});

// Admin tool: trigger aggregation manually (falls back to user's token if system token unavailable)
//
// Gated for the same reason /query/:q/refresh-all is: a full aggregation walks
// every repository, team and member in the organization and spends the org's
// GitHub budget rather than the caller's. It said "admin tool" in this comment
// and checked nothing, so any signed-in user could start one, repeatedly.
router.post("/aggregate", async (req: Request, res: Response) => {
  try {
    if (!(await isControlHubAdmin(req.user!.login).catch(() => false))) {
      return res.status(403).json({
        code: "CONTROL_HUB_ADMIN_REQUIRED",
        error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can `
          + `rebuild the access graph. It spends the organization's GitHub budget, not yours.`,
      });
    }
    const { aggregateGraphData } = await import("../jobs/graphAggregator");
    await aggregateGraphData(req.user?.accessToken);

    // The stored record, not a claim of success. aggregateGraphData catches its
    // own fatal errors, so returning "triggered successfully" from here said
    // nothing about whether anything was actually rebuilt — a failed run and a
    // good one produced the same reply.
    const { graphAggregation } = await getOrgConfig();
    res.json({ aggregation: graphAggregation ?? null });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "graph") });
  }
});

/**
 * When the graph was last rebuilt.
 *
 * Ungated: every screen reading the graph should be able to say how old it is,
 * and the answer is two timestamps, not data about anybody.
 */
router.get("/aggregate/status", async (_req: Request, res: Response) => {
  try {
    const { graphAggregation } = await getOrgConfig();
    res.json({ aggregation: graphAggregation ?? null });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "graph") });
  }
});

export default router;
