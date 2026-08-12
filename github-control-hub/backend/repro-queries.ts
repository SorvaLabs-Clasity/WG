/**
 * Tests for the four checks added on top of repository metadata.
 *
 * These drive evaluateSecurityQuery itself against a fixture, rather than
 * reimplementing the filtering in the test — a test that reimplements the code
 * only proves the two copies agree, which is exactly the failure it is supposed
 * to catch.
 *
 * The graph loads from data/graph-edges.json whenever ACTIVITY_TABLE is unset,
 * which is what makes this possible without DynamoDB.
 */
import fs from "fs";
import path from "path";

delete process.env.ACTIVITY_TABLE;   // force the local-fixture path
process.env.GITHUB_ORG = "test-org";

const DATA_DIR = path.join(__dirname, "../data");
const FIXTURE = path.join(DATA_DIR, "graph-edges.json");

const NOW = Date.now();
const monthsAgo = (n: number) => {
  const d = new Date(NOW);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString();
};

const meta = (repo: string, m: Record<string, unknown>) =>
  ({ pk: `REPO#${repo}`, sk: "META#repo", type: "repo_meta", metadata: m });
const branch = (repo: string, name: string, isProtected: boolean) =>
  ({ pk: `REPO#${repo}`, sk: `BRANCH#${name}`, type: "has_branch", metadata: { protected: isProtected } });
const collab = (repo: string, user: string, role: string, source: string) =>
  ({ pk: `REPO#${repo}`, sk: `USER#${user}`, type: "has_collaborator", metadata: { role, source } });

const EDGES = [
  // Visibility.
  meta("public-site", { visibility: "public", archived: false, pushedAt: monthsAgo(1), defaultBranch: "main" }),
  meta("internal-tool", { visibility: "internal", archived: false, pushedAt: monthsAgo(1), defaultBranch: "main" }),
  meta("private-api", { visibility: "private", archived: false, pushedAt: monthsAgo(1), defaultBranch: "main" }),

  // Archived, with and without anyone still on it.
  meta("dead-with-keys", { visibility: "private", archived: true, pushedAt: monthsAgo(30), defaultBranch: "main" }),
  collab("dead-with-keys", "contractor", "admin", "direct"),
  collab("dead-with-keys", "owner", "admin", "org_owner"),
  meta("dead-and-empty", { visibility: "private", archived: true, pushedAt: monthsAgo(30), defaultBranch: "main" }),
  collab("dead-and-empty", "owner", "admin", "org_owner"),

  // Staleness.
  meta("abandoned", { visibility: "private", archived: false, pushedAt: monthsAgo(14), defaultBranch: "main" }),
  meta("quiet", { visibility: "private", archived: false, pushedAt: monthsAgo(7), defaultBranch: "main" }),
  meta("never-pushed", { visibility: "private", archived: false, pushedAt: null, defaultBranch: "main" }),

  // Protection. "trunk" has no branch called main at all.
  meta("guarded", { visibility: "private", archived: false, pushedAt: monthsAgo(1), defaultBranch: "main" }),
  branch("guarded", "main", true),
  branch("guarded", "dev", false),
  meta("wide-open", { visibility: "private", archived: false, pushedAt: monthsAgo(1), defaultBranch: "main" }),
  branch("wide-open", "main", false),
  branch("wide-open", "dev", false),
  meta("trunk-named", { visibility: "private", archived: false, pushedAt: monthsAgo(1), defaultBranch: "trunk" }),
  branch("trunk-named", "trunk", false),
];

fs.mkdirSync(DATA_DIR, { recursive: true });
const hadFixture = fs.existsSync(FIXTURE);
const previous = hadFixture ? fs.readFileSync(FIXTURE, "utf8") : null;
fs.writeFileSync(FIXTURE, JSON.stringify(EDGES));

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

(async () => {
  try {
    const { evaluateSecurityQuery } = await import("./src/services/graphService");
    const repos = async (q: string, param?: string) =>
      (await evaluateSecurityQuery(q, param)).map((r: any) => r.repo).sort();

    // ── public repositories ──────────────────────────────────────────
    {
      const r = await repos("public-repos");
      check("public and internal are both reported", r.join() === "internal-tool,public-site", r);
      check("  private repositories are not", !r.includes("private-api"));

      const rows = await evaluateSecurityQuery("public-repos");
      const internal = rows.find((x: any) => x.repo === "internal-tool");
      check("  internal is described as enterprise-wide, not internet-facing",
        internal.reason.includes("enterprise"), internal.reason);
    }

    // ── archived, still reachable ────────────────────────────────────
    {
      const r = await repos("archived-repos-with-access");
      check("an archived repo someone still holds is reported", r.join() === "dead-with-keys", r);
      check("  an archived repo nobody holds is not", !r.includes("dead-and-empty"));

      const row: any = (await evaluateSecurityQuery("archived-repos-with-access"))[0];
      check("  the holder is named", row.details.includes("contractor"), row.details);
      check("  and access the org role confers is not counted as holding it",
        !row.details.includes("owner") && row.reason.includes("1 account"), row);
    }

    // ── stale ────────────────────────────────────────────────────────
    {
      const twelve = await repos("stale-repos", "12");
      check("at twelve months only the long-abandoned one qualifies", twelve.join() === "abandoned", twelve);

      const six = await repos("stale-repos", "6");
      check("at six months the quieter one joins it", six.join() === "abandoned,quiet", six);

      check("a repository never pushed to is not called stale",
        !six.includes("never-pushed"), six);

      const dflt = await repos("stale-repos");
      check("the threshold defaults to six months", dflt.join() === "abandoned,quiet", dflt);
      const junk = await repos("stale-repos", "not-a-number");
      check("  and junk falls back to it rather than matching everything",
        junk.join() === "abandoned,quiet", junk);
    }

    // ── nothing protected at all ─────────────────────────────────────
    {
      const r = await repos("repos-without-protection");
      check("a repo with one protected branch is not reported", !r.includes("guarded"), r);
      check("a repo with branches and none protected is", r.includes("wide-open"), r);
      check("  including one whose default is not called main", r.includes("trunk-named"), r);
      check("  and repos with no branch data at all are left out",
        !r.includes("private-api"), r);

      const row: any = (await evaluateSecurityQuery("repos-without-protection"))
        .find((x: any) => x.repo === "trunk-named");
      check("  the default branch is named, since that is the surprise",
        row.details.includes("trunk"), row.details);
    }

    // ── a check whose data was never collected ───────────────────────
    {
      const { MissingGraphDataError } = await import("./src/services/graphService");

      // The graph as it is before an aggregation that knows about repo_meta:
      // branches present, repository facts absent.
      fs.writeFileSync(FIXTURE, JSON.stringify([
        branch("guarded", "main", true),
        branch("wide-open", "main", false),
      ]));
      // graphService caches the fixture after first read, so the module has to
      // be loaded fresh to see a different one.
      delete require.cache[require.resolve("./src/services/graphService")];
      const fresh = await import("./src/services/graphService?stale=1" as any).catch(() => null);
      const svc = fresh ?? require("./src/services/graphService");

      let threw: Error | null = null;
      try {
        await svc.evaluateSecurityQuery("stale-repos", "2");
      } catch (e) {
        threw = e as Error;
      }
      check("a check over uncollected data refuses rather than reporting zero",
        threw?.name === "MissingGraphDataError", threw?.message ?? "no error");
      check("  and says how to fix it",
        (threw?.message ?? "").includes("Sync data"), threw?.message);

      // A check whose data IS present still answers normally.
      const stillWorks = await svc.evaluateSecurityQuery("repos-without-protection");
      check("  while a check whose data is present still answers",
        stillWorks.some((r: any) => r.repo === "wide-open"), stillWorks);
    }
  } finally {
    if (previous !== null) fs.writeFileSync(FIXTURE, previous);
    else fs.rmSync(FIXTURE, { force: true });
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
