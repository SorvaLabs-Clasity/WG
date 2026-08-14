import { Router, Request, Response } from "express";
import { createOctokit, getOrg, getSystemToken } from "../github/client";
import { listRepos } from "../services/repoService";
import { logActivity } from "../services/activityService";
import { sanitizeError } from "../utils/errorSanitizer";
import { sendIfRateLimited } from "../utils/rateLimit";
import { sendIfPermissionDenied } from "../utils/permissionError";

const router = Router();

/** The `after` cursor from a Link header's rel="next", if there is one. */
function nextCursor(link: string | undefined): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const url = part.match(/<([^>]+)>/)?.[1];
    if (!url) continue;
    const after = new URL(url).searchParams.get("after");
    if (after) return after;
  }
  return undefined;
}

/**
 * Every open alert, not the first hundred — walked the way these endpoints
 * actually paginate.
 *
 * Two bugs live here. Originally all three Dependabot calls asked for
 * `per_page: 100` and used the single page they got back, so past a hundred
 * open alerts an organisation under-counted every severity and under-listed
 * every repository — silently, in the direction that reads as good news.
 *
 * The fix for that walked pages with `?page=N`, shaped like listRepos' loop
 * because that is the pattern everywhere else here. But listRepos calls an
 * endpoint that supports page numbers and the Dependabot alerts endpoints do
 * not — organisation-level and repository-level alike answer:
 *
 *     400  Pagination using the `page` parameter is not supported.
 *
 * They use cursor pagination: a Link header with rel="next" carrying an
 * `after` cursor. So the walk follows that instead, and ends when GitHub stops
 * offering a next link rather than when a page looks short. A short page is not
 * reliable evidence of the end here, and the link is.
 *
 * Exported for repro-dependencies.ts.
 */
export async function fetchAllCursorPages(
  fetchPage: (cursor: string | undefined) => Promise<{ data: any[]; headers?: Record<string, any> }>,
): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined = undefined;

  while (true) {
    const { data, headers } = await fetchPage(cursor);
    if (!data || data.length === 0) break;
    all.push(...data);

    const next = nextCursor(headers?.link);
    if (!next) break;
    cursor = next;
  }

  return all;
}

router.get("/dependencies", async (req: Request, res: Response) => {
  try {
    const token = getSystemToken() || req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    const repoFilter = req.query.repo as string | undefined;
    const severityFilter = req.query.severity as string | undefined;

    let allAlerts: any[] = [];

    if (repoFilter) {
      const data = await fetchAllCursorPages((after) =>
        octokit.rest.dependabot.listAlertsForRepo({
          owner: org,
          repo: repoFilter,
          state: "open",
          per_page: 100,
          ...(after ? { after } : {}),
        })
      );
      allAlerts = data.map((a: any) => mapAlert(a, repoFilter, org));
      
      // No alerts means one of two things, and the caller has to be able to
      // tell them apart: alerts are switched off, or they are on and the repo
      // is clean. Returning an empty list for both made a clean repo look like
      // one that had vanished, so each case gets its marker — the same
      // contract the org-wide branch below returns.
      if (allAlerts.length === 0) {
        try {
          await octokit.rest.repos.checkVulnerabilityAlerts({ owner: org, repo: repoFilter });
          allAlerts.push(mockCleanAlert(repoFilter, org));
        } catch (err: any) {
          if (err.status === 404) {
            allAlerts.push(mockDisabledAlert(repoFilter, org));
          }
        }
      }
    } else {
      try {
        const data = await fetchAllCursorPages((after) =>
          octokit.rest.dependabot.listAlertsForOrg({
            org,
            state: "open",
            per_page: 100,
            ...(after ? { after } : {}),
          })
        );
        allAlerts = data.map((a: any) => mapAlert(a, a.repository?.name || "unknown", org));
      } catch (err: any) {
        // The alert sweep failing should cost the alerts, not the page. Every
        // repository below is still listed with its Dependabot state, which is
        // most of what this screen is for.
        //
        // 400 is here because of how this broke: the walk asked for `?page=N`,
        // which these endpoints reject, and a rethrown 400 turned the whole
        // request into a 500 and the screen into a blank one. The pagination is
        // fixed above; this makes the next such mistake cost less than
        // everything.
        if (err.status !== 400 && err.status !== 403 && err.status !== 404) {
          throw err;
        }
        console.error(`[Dependencies] Org-wide alert sweep failed (${err.status}) — listing repositories without alert data:`, err.message);
      }
      
      // Also fetch all repos and check if any have dependabot disabled
      const repos = await listRepos(octokit);
      const reposWithAlerts = new Set(allAlerts.map(a => a.repo));
      const reposToCheck = repos.filter(r => !reposWithAlerts.has(r.name));
      
      // Check in batches of 10 to avoid rate limits
      const CHUNK_SIZE = 10;
      for (let i = 0; i < reposToCheck.length; i += CHUNK_SIZE) {
        const chunk = reposToCheck.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async (r) => {
          try {
            await octokit.rest.repos.checkVulnerabilityAlerts({ owner: org, repo: r.name });
            allAlerts.push(mockCleanAlert(r.name, org));
          } catch (err: any) {
            if (err.status === 404) {
              allAlerts.push(mockDisabledAlert(r.name, org));
            }
          }
        }));
      }
    }

    if (severityFilter) {
      allAlerts = allAlerts.filter(a => a.severity === severityFilter);
    }

    res.json(allAlerts);
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.post("/dependencies/enable", async (req: Request, res: Response) => {
  try {
    // A write against a specific repo — act as the user so GitHub authorises it.
    const token = req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const { repo } = req.body;
    if (!repo) {
      return res.status(400).json({ error: "Repo name is required" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    try {
      await octokit.rest.repos.enableVulnerabilityAlerts({ owner: org, repo });
    } catch (err) {
      if (sendIfPermissionDenied(res, err, req.user!.login, "enable Dependabot alerts", repo)) return;
      throw err;
    }

    await logActivity("dependabot.enable" as any, req.user?.login || "system", repo, "Dependabot",
      `Enabled Dependabot vulnerability alerts for "${repo}"`,
      undefined, "app", undefined, undefined,
      { undoPayload: { action: "disable_dependabot", params: { repo } } }
    );

    res.json({ success: true });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.post("/dependencies/disable", async (req: Request, res: Response) => {
  try {
    // A write against a specific repo — act as the user so GitHub authorises it.
    const token = req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const { repo } = req.body;
    if (!repo) {
      return res.status(400).json({ error: "Repo name is required" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    try {
      await octokit.rest.repos.disableVulnerabilityAlerts({ owner: org, repo });
    } catch (err) {
      if (sendIfPermissionDenied(res, err, req.user!.login, "disable Dependabot alerts", repo)) return;
      throw err;
    }

    await logActivity("dependabot.disable" as any, req.user?.login || "system", repo, "Dependabot",
      `Disabled Dependabot vulnerability alerts for "${repo}"`,
      undefined, "app", undefined, undefined,
      { undoPayload: { action: "enable_dependabot", params: { repo } } }
    );

    res.json({ success: true });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.get("/summary", async (req: Request, res: Response) => {
  try {
    const token = getSystemToken() || req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    let allAlerts: any[] = [];
    try {
      allAlerts = await fetchAllCursorPages((after) =>
        octokit.rest.dependabot.listAlertsForOrg({
          org,
          state: "open",
          per_page: 100,
          ...(after ? { after } : {}),
        })
      );
    } catch (err: any) {
      if (err.status === 403 || err.status === 404) {
        return res.json({ critical: 0, high: 0, medium: 0, low: 0, repos_with_vulns: 0 });
      }
      throw err;
    }

    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    const reposWithVulns = new Set<string>();

    for (const alert of allAlerts) {
      const severity = alert.security_advisory?.severity || alert.security_vulnerability?.severity || "low";
      if (severity in counts) {
        counts[severity as keyof typeof counts]++;
      }
      if (alert.repository?.name) {
        reposWithVulns.add(alert.repository.name);
      }
    }

    res.json({
      ...counts,
      repos_with_vulns: reposWithVulns.size,
    });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

function mapAlert(alert: any, repoName: string, orgName: string) {
  const advisory = alert.security_advisory || {};
  const vuln = alert.security_vulnerability || {};

  return {
    id: `dep-${alert.number}`,
    repo: repoName,
    org: orgName,
    dependency: vuln.package?.name || advisory.summary || "unknown",
    severity: advisory.severity || vuln.severity || "low",
    cve: advisory.cve_id || (advisory.identifiers || []).find((i: any) => i.type === "CVE")?.value || "",
    ecosystem: vuln.package?.ecosystem || "",
    vulnerable_version: vuln.vulnerable_version_range || "",
    patched_version: vuln.first_patched_version?.identifier || null,
    detected_at: alert.created_at || new Date().toISOString(),
  };
}

function mockDisabledAlert(repoName: string, orgName: string) {
  return {
    id: `disabled-${repoName}`,
    repo: repoName,
    org: orgName,
    dependency: "Dependabot alerts disabled",
    severity: "low",
    cve: "",
    ecosystem: "",
    vulnerable_version: "",
    patched_version: null,
    detected_at: new Date().toISOString(),
    disabled: true
  };
}

function mockCleanAlert(repoName: string, orgName: string) {
  return {
    id: `clean-${repoName}`,
    repo: repoName,
    org: orgName,
    dependency: "No vulnerabilities found",
    severity: "low",
    cve: "",
    ecosystem: "",
    vulnerable_version: "",
    patched_version: null,
    detected_at: new Date().toISOString(),
    clean: true
  };
}

export default router;
