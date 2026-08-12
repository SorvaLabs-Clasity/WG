import { Router, Request, Response } from "express";
import { docClient, usesDynamo, tableName, QueryCommand, ScanCommand } from "../utils/dynamo";
import fs from "fs";
import path from "path";
import { evaluateSecurityQuery } from "../services/graphService";
import { getSystemToken } from "../github/client";
import { sanitizeError } from "../utils/errorSanitizer";
import { sendIfRateLimited } from "../utils/rateLimit";

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
    const { UnknownQueryError } = await import("../services/graphService");
    if (error instanceof UnknownQueryError) {
      res.status(400).json({ error: error.message, code: "UNKNOWN_QUERY", queryId: error.queryId });
      return;
    }
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "graph") });
  }
});

// Admin tool: trigger aggregation manually (falls back to user's token if system token unavailable)
router.post("/aggregate", async (req: Request, res: Response) => {
  try {
    const { aggregateGraphData } = await import("../jobs/graphAggregator");
    await aggregateGraphData(req.user?.accessToken);
    res.json({ message: "Aggregation triggered successfully." });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "graph") });
  }
});

export default router;
