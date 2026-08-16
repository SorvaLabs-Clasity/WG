import { Router, Request, Response } from "express";
import { getOrgConfig } from "../services/orgConfigService";
import { createOctokit, getOrg } from "../github/client";
import { sanitizeError } from "../utils/errorSanitizer";
import { sendIfRateLimited } from "../utils/rateLimit";

const router = Router();

/**
 * Whether the org webhook is still reaching us.
 *
 * Silence is the failure mode: a broken webhook looks exactly like a quiet
 * week. Reporting when GitHub last got through lets the difference be seen.
 */
router.get("/webhook-health", async (_req: Request, res: Response) => {
  try {
    const { lastGitHubEvent, webhookHealth } = await import("../services/activityService");
    const { at, action } = await lastGitHubEvent();
    res.json({ ...webhookHealth(at), lastEventAction: action });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "org") });
  }
});

/**
 * Everyone in the organization, so a person can be picked rather than typed.
 *
 * Read as the caller. An installation token would list members the person
 * looking cannot otherwise see, and this exists to fill a name box — not to
 * widen what somebody knows about the org.
 */
router.get("/members", async (req: Request, res: Response) => {
  try {
    const { listOrgMembers, depsFromOctokit } = await import("../services/orgMembersService");
    const octokit = createOctokit(req.user!.accessToken);
    res.json(await listOrgMembers(depsFromOctokit(octokit), getOrg()));
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "org") });
  }
});

router.get("/config", async (req: Request, res: Response) => {
  try {
    const config = await getOrgConfig();
    res.json(config);
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "org") });
  }
});

router.get("/actors", async (req: Request, res: Response) => {
  try {
    const octokit = createOctokit(req.user!.accessToken);
    const org = getOrg();

    const WRITE_BASE_ROLES = new Set(["write", "maintain", "admin"]);
    const builtInRoles = [
      { id: 5, name: "Admin", description: "Full access to the repository", base_role: "admin", has_write: true },
      { id: 1, name: "Maintain", description: "Manage repository without access to sensitive or destructive actions", base_role: "maintain", has_write: true },
      { id: 2, name: "Write", description: "Read and write access to code, issues, and pull requests", base_role: "write", has_write: true },
    ];

    let customRoles: Array<{ id: number; name: string; description: string; base_role: string; has_write: boolean }> = [];
    try {
      const { data } = await (octokit as any).rest.orgs.listCustomRepoRoles({ org });
      if (data?.custom_roles) {
        customRoles = data.custom_roles.map((r: any) => ({
          id: r.id, name: r.name, description: r.description || "",
          base_role: r.base_role || "read",
          has_write: WRITE_BASE_ROLES.has(r.base_role || "read"),
        }));
      }
    } catch { /* custom roles may not be available on all plans */ }

    let teams: Array<{ id: number; name: string; slug: string }> = [];
    try {
      let page = 1;
      while (true) {
        const { data } = await octokit.rest.teams.list({ org, per_page: 100, page });
        if (data.length === 0) break;
        teams.push(...data.map((t: any) => ({ id: t.id, name: t.name, slug: t.slug })));
        if (data.length < 100) break;
        page++;
      }
    } catch { /* teams may not be accessible */ }

    let apps: Array<{ id: number; name: string; slug: string }> = [];
    try {
      const { data } = await octokit.rest.orgs.listAppInstallations({ org, per_page: 100 });
      if (data?.installations) {
        apps = data.installations
          .filter((a: any) => a.app_slug)
          .map((a: any) => ({ id: a.id, name: a.app_slug, slug: a.app_slug }));
      }
    } catch { /* apps may not be accessible */ }

    res.json({
      roles: [...builtInRoles, ...customRoles],
      teams,
      apps,
    });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "org") });
  }
});

export default router;
