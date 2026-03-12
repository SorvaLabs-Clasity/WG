import { Router, Request, Response } from "express";
import { getOrgConfig } from "../services/orgConfigService";
import { createOctokit, getOrg } from "../github/client";

const router = Router();

router.get("/config", async (req: Request, res: Response) => {
  try {
    const config = await getOrgConfig();
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/actors", async (req: Request, res: Response) => {
  try {
    const octokit = createOctokit(req.user!.accessToken);
    const org = getOrg();

    const builtInRoles = [
      { id: 5, name: "Admin", description: "Full access to the repository" },
      { id: 1, name: "Maintain", description: "Manage repository without access to sensitive or destructive actions" },
      { id: 2, name: "Write", description: "Read and write access to code, issues, and pull requests" },
    ];

    let customRoles: Array<{ id: number; name: string; description: string }> = [];
    try {
      const { data } = await (octokit as any).rest.orgs.listCustomRepoRoles({ org });
      if (data?.custom_roles) {
        customRoles = data.custom_roles.map((r: any) => ({ id: r.id, name: r.name, description: r.description || "" }));
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
    console.error("Error fetching org actors:", error);
    res.status(500).json({ error: error.message || "Failed to fetch organization actors" });
  }
});

export default router;
