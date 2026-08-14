/**
 * Tests for the access map.
 *
 * The map's whole value is the paths, not the totals. "Alice has admin on
 * payments" is useless in an access review; "Alice has admin on payments
 * because she is an org owner, and would still have write through the platform
 * team if you removed that" is the answer. So these tests are mostly about
 * paths being complete and correctly attributed.
 *
 * Driven against the local graph fixture, which graphService reads whenever
 * ACTIVITY_TABLE is unset.
 */
import fs from "fs";
import path from "path";

delete process.env.ACTIVITY_TABLE;
process.env.GITHUB_ORG = "test-org";

const DATA_DIR = path.join(__dirname, "../data");
const FIXTURE = path.join(DATA_DIR, "graph-edges.json");

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const user = (login: string, orgRole: string) =>
  ({ pk: `USER#${login}`, sk: "META#user", type: "user_meta", metadata: { login, orgRole } });
const team = (slug: string, name: string) =>
  ({ pk: `TEAM#${slug}`, sk: "META#team", type: "team_meta", metadata: { slug, name } });
const inTeam = (login: string, slug: string) =>
  ({ pk: `USER#${login}`, sk: `TEAM#${slug}`, type: "member_of" });
const teamOwns = (slug: string, repo: string, permission: string) =>
  ({ pk: `TEAM#${slug}`, sk: `REPO#${repo}`, type: "owns_repo", metadata: { permission } });
const collab = (login: string, repo: string, role: string, source: string) =>
  ({ pk: `USER#${login}`, sk: `REPO#${repo}`, type: "collaborates_on", metadata: { role, source } });
const repoMeta = (repo: string, m: Record<string, unknown>) =>
  ({ pk: `REPO#${repo}`, sk: "META#repo", type: "repo_meta", metadata: m });

const EDGES = [
  { pk: "ORG#test-org", sk: "META#org", type: "org_meta",
    metadata: { defaultRepositoryPermission: "read", memberCount: 4 } },

  user("owner-ann", "owner"),
  user("dev-dan", "member"),
  user("lurker-lee", "member"),
  user("vendor-vic", "outside_collaborator"),

  team("platform", "Platform"),
  team("payments", "Payments Squad"),

  inTeam("dev-dan", "platform"),
  inTeam("dev-dan", "payments"),

  teamOwns("platform", "api", "write"),
  teamOwns("platform", "infra", "admin"),
  teamOwns("payments", "api", "admin"),

  repoMeta("api", { visibility: "private", archived: false }),
  repoMeta("infra", { visibility: "private", archived: false }),
  repoMeta("legacy", { visibility: "private", archived: true }),
  repoMeta("secret-thing", { visibility: "private", archived: false }),

  // Dan's effective role on api is admin — the payments team explains it.
  collab("dev-dan", "api", "admin", "team"),
  collab("dev-dan", "infra", "admin", "team"),
  // On legacy he has admin with no team owning it: that is a personal grant.
  collab("dev-dan", "legacy", "admin", "direct"),
  // The outside collaborator, with one repository and no team, no membership.
  collab("vendor-vic", "secret-thing", "write", "direct"),
  // The owner appears against one repo only; ownership covers the rest.
  collab("owner-ann", "api", "admin", "org_owner"),
];

fs.mkdirSync(DATA_DIR, { recursive: true });
const had = fs.existsSync(FIXTURE);
const previous = had ? fs.readFileSync(FIXTURE, "utf8") : null;
fs.writeFileSync(FIXTURE, JSON.stringify(EDGES));

(async () => {
  try {
    const svc = await import("./src/services/accessMapService");

    // ── one person, every route ──────────────────────────────────────
    {
      const dan = await svc.accessForUser("dev-dan");
      const on = (repo: string) => dan.repos.find(r => r.repo === repo);

      check("a team member's repositories come from their teams",
        dan.repos.map(r => r.repo).sort().join() === "api,infra,legacy", dan.repos.map(r => r.repo));

      check("a repo two of their teams own lists both routes",
        on("api")!.paths.filter(p => p.via === "team").map(p => p.team).sort().join() === "payments,platform",
        on("api")!.paths);

      check("  the effective role is the strongest of them, not the first",
        on("api")!.role === "admin", on("api"));

      check("  and each route says what it alone grants",
        on("api")!.paths.find(p => p.team === "platform")!.role === "write" &&
        on("api")!.paths.find(p => p.team === "payments")!.role === "admin",
        on("api")!.paths);

      check("  teams are named, not just slugged",
        on("api")!.paths.some(p => p.teamName === "Payments Squad"), on("api")!.paths);

      check("access a team fully explains is not also called direct",
        !on("api")!.paths.some(p => p.via === "direct"), on("api")!.paths);

      check("access no team explains is called direct",
        on("legacy")!.paths.length === 1 && on("legacy")!.paths[0].via === "direct",
        on("legacy")!.paths);

      check("  and their team memberships are listed",
        dan.teams.map(t => t.name).sort().join() === "Payments Squad,Platform", dan.teams);
    }

    // ── the owner ────────────────────────────────────────────────────
    {
      const ann = await svc.accessForUser("owner-ann");
      check("an org owner reaches every repository, not just the ones GitHub returned",
        ann.repos.length === 4, ann.repos.map(r => r.repo));
      check("  every one of them attributed to ownership",
        ann.repos.every(r => r.paths.some(p => p.via === "org_owner")), ann.repos);
      check("  and never mislabelled as a personal grant",
        !ann.repos.some(r => r.paths.some(p => p.via === "direct")), ann.repos);
    }

    // ── someone with nothing ─────────────────────────────────────────
    {
      const lee = await svc.accessForUser("lurker-lee");
      check("a member with no write anywhere still resolves",
        lee.orgRole === "member" && lee.repos.length === 0, lee);
      check("  and is not reported as unknown", !lee.unknown, lee);
    }

    // ── outside collaborators ────────────────────────────────────────
    {
      const vic = await svc.accessForUser("vendor-vic");
      check("an outside collaborator is marked as one",
        vic.orgRole === "outside_collaborator", vic.orgRole);
      check("  with exactly the repository they were granted",
        vic.repos.map(r => r.repo).join() === "secret-thing", vic.repos);
    }

    // ── the summary ──────────────────────────────────────────────────
    {
      const summary = await svc.accessSummary();
      const by = (login: string) => summary.people.find(p => p.login === login)!;

      check("everyone appears in the summary",
        summary.people.length === 4, summary.people.map(p => p.login));
      check("  sorted with the widest access first",
        summary.people[0].login === "owner-ann", summary.people.map(p => p.login));
      check("  direct grants are counted separately from everything else",
        by("dev-dan").directCount === 1 && by("dev-dan").repoCount === 3, by("dev-dan"));
      check("  an owner's admin count is every repository",
        by("owner-ann").adminCount === 4, by("owner-ann"));
      check("  a member with no write is listed with zero, not omitted",
        by("lurker-lee").repoCount === 0, by("lurker-lee"));
      check("the organization's read default is reported rather than assumed",
        summary.org.defaultRepositoryPermission === "read", summary.org);
      check("  and a graph with people in it is not called stale",
        summary.stale === false, summary.stale);
    }

    // ── the other direction ──────────────────────────────────────────
    {
      const api = await svc.accessForRepo("api");
      const who = api.people.map(p => p.login).sort();
      check("a repository lists everyone who can reach it",
        who.join() === "dev-dan,owner-ann", who);
      check("  including the owner, who was never granted it",
        api.people.find(p => p.login === "owner-ann")!.paths.some(p => p.via === "org_owner"),
        api.people);
      check("  and the teams that own it, with what each grants",
        api.teams.map(t => `${t.slug}:${t.permission}`).sort().join() === "payments:admin,platform:write",
        api.teams);

      const secret = await svc.accessForRepo("secret-thing");
      check("an outside collaborator shows up against the repo they hold",
        secret.people.some(p => p.login === "vendor-vic" && p.outside), secret.people);
      check("  and a repo no team owns says so",
        secret.teams.length === 0, secret.teams);
    }

    // ── a graph built before people were collected ───────────────────
    {
      fs.writeFileSync(FIXTURE, JSON.stringify([teamOwns("platform", "api", "write")]));
      svc.invalidateAccessMap();
      delete require.cache[require.resolve("./src/services/graphService")];
      delete require.cache[require.resolve("./src/services/accessMapService")];
      const fresh = require("./src/services/accessMapService");

      const summary = await fresh.accessSummary();
      check("a graph with no people in it is reported as stale, not as empty",
        summary.stale === true, summary);
    }
  } finally {
    if (previous !== null) fs.writeFileSync(FIXTURE, previous);
    else fs.rmSync(FIXTURE, { force: true });
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
