import { Octokit } from "octokit";
import { getOrg, getSystemTokenAsync } from "../github/client";
import { usesDynamo, tableName, scanAll, batchWrite } from "../utils/dynamo";
import { refreshAll } from "../services/complianceCacheService";
import { invalidateAccessMap } from "../services/accessMapService";
import { invalidateEdgeCache } from "../services/graphService";
import { recordGraphAggregation } from "../services/orgConfigService";

interface GraphEdge {
  pk: string;
  sk: string;
  type: string;
  metadata?: any;
}

export async function aggregateGraphData(fallbackToken?: string) {
  // Stamped before the walk, so a run that dies mid-way still leaves evidence
  // it was tried. The success timestamp is written only once edges are on disk.
  await recordGraphAggregation({ lastAttemptAt: new Date().toISOString() })
    .catch(err => console.warn("[GraphAggregator] Could not record the attempt:", err?.message ?? err));

  const token = await getSystemTokenAsync() || fallbackToken;
  if (!token) {
    console.warn("No GitHub token available, skipping graph aggregation.");
    return;
  }

  const octokit = new Octokit({ auth: token });
  const org = getOrg();
  const edges: GraphEdge[] = [];
  const edgesTable = usesDynamo() ? tableName("GRAPH_EDGES_TABLE") : "";

  console.log(`[GraphAggregator] Starting aggregation for org: ${org}`);

  try {
    // 1. Fetch Repositories
    const repos: any[] = [];
    let repoPage = 1;
    while (true) {
      const { data } = await octokit.rest.repos.listForOrg({ org, per_page: 100, page: repoPage });
      if (data.length === 0) break;
      repos.push(...data);
      if (data.length < 100) break;
      repoPage++;
    }
    console.log(`[GraphAggregator] Fetched ${repos.length} repositories`);

    // 2. Fetch Teams and Members
    const teams: any[] = [];
    let teamPage = 1;
    while (true) {
      const { data } = await octokit.rest.teams.list({ org, per_page: 100, page: teamPage });
      if (data.length === 0) break;
      teams.push(...data);
      if (data.length < 100) break;
      teamPage++;
    }
    console.log(`[GraphAggregator] Fetched ${teams.length} teams`);

    // Org owners are admin on every repository by virtue of the role. Recorded
    // so queries can ask "who has admin that ownership does not explain",
    // rather than reporting the owner against every repository.
    const orgOwners = new Set<string>();
    try {
      const { data } = await octokit.rest.orgs.listMembers({ org, role: "admin", per_page: 100 });
      for (const m of data) if (m?.login) orgOwners.add(m.login);
    } catch {
      // Without this the worst case is a grant recorded as direct rather than
      // as ownership — a wrong label, not a missing edge.
    }

    // Everyone in the organization, whether or not they can write anywhere.
    //
    // Privileged edges alone cannot answer "who has access to what": someone
    // with read on everything and write on nothing has no edges at all, and a
    // map that omits them is a map of the people you already worried about.
    const people = new Map<string, { orgRole: string; avatarUrl?: string }>();
    try {
      let page = 1;
      while (true) {
        const { data } = await octokit.rest.orgs.listMembers({ org, per_page: 100, page });
        if (data.length === 0) break;
        for (const m of data) {
          if (!m?.login) continue;
          people.set(m.login, {
            orgRole: orgOwners.has(m.login) ? "owner" : "member",
            avatarUrl: m.avatar_url,
          });
        }
        if (data.length < 100) break;
        page++;
      }
    } catch (err) {
      console.warn("[GraphAggregator] Failed to list organization members");
    }

    // People who are not in the organization but hold access to a repository
    // in it. The single most important row in an access review, and invisible
    // without asking for them by name.
    try {
      let page = 1;
      while (true) {
        const { data } = await octokit.rest.orgs.listOutsideCollaborators({ org, per_page: 100, page });
        if (data.length === 0) break;
        for (const m of data) {
          if (!m?.login) continue;
          people.set(m.login, { orgRole: "outside_collaborator", avatarUrl: m.avatar_url });
        }
        if (data.length < 100) break;
        page++;
      }
    } catch (err) {
      console.warn("[GraphAggregator] Failed to list outside collaborators");
    }

    for (const [login, meta] of people) {
      edges.push({
        pk: `USER#${login}`,
        sk: "META#user",
        type: "user_meta",
        metadata: { login, ...meta },
      });
    }
    console.log(`[GraphAggregator] Fetched ${people.size} people`);

    // What every member can do without being granted anything.
    //
    // The access map's headline claim — "everyone can read every repository" —
    // is only true when the organization's default says so. Asserting it
    // without checking would be the map's biggest statement resting on an
    // assumption.
    // Held beyond the block below: whether a plain read is worth recording
    // depends on it, and that decision is made once per collaborator further
    // down.
    let orgDefault = "unknown";
    try {
      const { data: orgInfo } = await octokit.rest.orgs.get({ org });
      orgDefault = (orgInfo as any).default_repository_permission ?? "unknown";
      edges.push({
        pk: `ORG#${org}`,
        sk: "META#org",
        type: "org_meta",
        metadata: {
          defaultRepositoryPermission: orgDefault,
          membersCanCreateRepositories: (orgInfo as any).members_can_create_repositories ?? null,
          twoFactorRequirementEnabled: (orgInfo as any).two_factor_requirement_enabled ?? null,
          memberCount: people.size,
        },
      });
    } catch {
      // Absent org_meta makes the map say the default is unknown, which is
      // the honest reading when we could not ask.
    }

    /** repo name -> logins that reach it through a team. */
    const viaTeam = new Map<string, Set<string>>();

    // TEAM -> REPO edges & USER -> TEAM edges
    for (const team of teams) {
      const teamId = `TEAM#${team.slug}`;

      // Slugs are what edges are keyed on, but "platform-eng-core" is not what
      // anyone calls the team out loud.
      edges.push({
        pk: teamId,
        sk: "META#team",
        type: "team_meta",
        metadata: {
          slug: team.slug,
          name: team.name ?? team.slug,
          description: team.description ?? null,
          privacy: team.privacy ?? null,
          parent: team.parent?.slug ?? null,
        },
      });
      const teamRepoNames: string[] = [];
      const teamMemberLogins: string[] = [];

      // Get repos for team
      try {
        let tpPage = 1;
        while (true) {
          const { data: teamRepos } = await octokit.rest.teams.listReposInOrg({ org, team_slug: team.slug, per_page: 100, page: tpPage });
          if (teamRepos.length === 0) break;
          for (const tr of teamRepos) {
            if (!viaTeam.has(tr.name)) viaTeam.set(tr.name, new Set());
            teamRepoNames.push(tr.name);
            edges.push({
              pk: teamId,
              sk: `REPO#${tr.name}`,
              type: "owns_repo",
              metadata: { permission: tr.role_name || "read" }
            });
            edges.push({
              pk: `REPO#${tr.name}`,
              sk: teamId,
              type: "owned_by_team",
              metadata: { permission: tr.role_name || "read" }
            });
          }
          if (teamRepos.length < 100) break;
          tpPage++;
        }
      } catch (err) {
        console.warn(`[GraphAggregator] Failed to fetch repos for team ${team.slug}`);
      }

      // Get members for team
      try {
        let tmPage = 1;
        while (true) {
          const { data: members } = await octokit.rest.teams.listMembersInOrg({ org, team_slug: team.slug, per_page: 100, page: tmPage });
          if (members.length === 0) break;
          for (const member of members) {
            if (member && member.login) {
              teamMemberLogins.push(member.login);
              edges.push({
                pk: `USER#${member.login}`,
                sk: teamId,
                type: "member_of",
              });
              edges.push({
                pk: teamId,
                sk: `USER#${member.login}`,
                type: "has_member",
              });
            }
          }
          if (members.length < 100) break;
          tmPage++;
        }
      } catch (err) {
        console.warn(`[GraphAggregator] Failed to fetch members for team ${team.slug}`);
      }

      for (const repoName of teamRepoNames) {
        const set = viaTeam.get(repoName)!;
        for (const login of teamMemberLogins) set.add(login);
      }
    }

    // 3. Repo details: Collaborators, Workflows, Dependabot
    for (const repo of repos) {
      const repoId = `REPO#${repo.name}`;

      // The repository's own facts, which listForOrg already returned and this
      // loop used to throw away. Keeping them is one edge per repository and no
      // additional request, and it lets questions about visibility, archival
      // and last activity be answered from the graph rather than by fetching
      // every repository again at query time.
      edges.push({
        pk: repoId,
        sk: "META#repo",
        type: "repo_meta",
        metadata: {
          visibility: repo.visibility ?? (repo.private ? "private" : "public"),
          archived: !!repo.archived,
          fork: !!repo.fork,
          pushedAt: repo.pushed_at ?? null,
          defaultBranch: repo.default_branch ?? "main",
          // Every one of these is off across the sampled organization, and each
          // is a control an auditor asks about by name.
          secretScanning: repo.security_and_analysis?.secret_scanning?.status ?? "unknown",
          pushProtection: repo.security_and_analysis?.secret_scanning_push_protection?.status ?? "unknown",
        },
      });

      // Who can write to this repository, and how they came by it.
      //
      // This asked for affiliation "direct", meaning only people granted access
      // to the repository individually. Almost nobody gets access that way —
      // it arrives through org membership or a team — so the graph recorded
      // one collaborator across the whole organization and every question
      // about people returned nothing.
      //
      // One deliberate narrowing keeps that from turning into noise: each edge
      // carries how the access was obtained. Without it an org owner is admin
      // on every repository and floods every result; with it a query can ask
      // the useful question, which is who has admin that ownership and team
      // membership do not already explain.
      //
      // Which roles are recorded is decided just below, and is no longer a
      // fixed list.
      try {
        // Which roles are worth an edge.
        //
        // This was a fixed list of admin, write and maintain, which dropped
        // three things people expect to see:
        //
        //   triage — never an organization default, so it is always an explicit
        //   grant, and an access review wants explicit grants above all.
        //
        //   custom repository roles — the name is whatever the organization
        //   called it, so it matched nothing in the list and anybody holding one
        //   vanished from the map entirely.
        //
        //   read held by an outside collaborator — the person who is not in the
        //   organization and can nevertheless see the code, which is the row an
        //   access review exists to find.
        //
        // The one exclusion that survives is the one the volume argument was
        // really about: a *member's* plain read, where the organization already
        // grants read or better to everyone. listCollaborators reports those,
        // so recording them would add an edge per member per repository —
        // hundreds of thousands at a real company — to say something the
        // organization default already says once, on screen, at the top of the
        // page. When the default is `none`, that same read is an explicit grant
        // and is recorded like any other.
        const DEFAULT_COVERS_READ = orgDefault === "read" || orgDefault === "write" || orgDefault === "admin";
        const worthRecording = (role: string, login: string): boolean => {
          const isRead = role === "read" || role === "pull";
          if (!isRead) return true;
          const isOutside = people.get(login)?.orgRole === "outside_collaborator";
          if (isOutside) return true;
          return !DEFAULT_COVERS_READ;
        };

        const teamMembersHere = viaTeam.get(repo.name);
        let colPage = 1;
        while (true) {
          const { data: collaborators } = await octokit.rest.repos.listCollaborators({ owner: org, repo: repo.name, affiliation: "all", per_page: 100, page: colPage });
          if (collaborators.length === 0) break;
          for (const collab of collaborators) {
            if (!collab?.login) continue;
            const role = collab.role_name ?? "read";
            if (!worthRecording(role, collab.login)) continue;

            const source = orgOwners.has(collab.login) ? "org_owner"
              : teamMembersHere?.has(collab.login) ? "team"
              : "direct";

            const metadata = { role, source };
            edges.push({ pk: `USER#${collab.login}`, sk: repoId, type: "collaborates_on", metadata });
            edges.push({ pk: repoId, sk: `USER#${collab.login}`, type: "has_collaborator", metadata });
          }
          if (collaborators.length < 100) break;
          colPage++;
        }
      } catch (err: any) {
         if (err.status !== 403 && err.status !== 404) console.warn(`[GraphAggregator] Failed to fetch collaborators for ${repo.name}`);
      }

      // Workflows
      try {
        const { data: workflows } = await octokit.rest.actions.listRepoWorkflows({ owner: org, repo: repo.name, per_page: 100 });
        for (const wf of workflows.workflows) {
          edges.push({
            pk: repoId,
            sk: `WORKFLOW#${wf.name}`,
            type: "uses_workflow",
            metadata: { path: wf.path, state: wf.state }
          });
        }
      } catch (err: any) {
        if (err.status !== 403 && err.status !== 404) console.warn(`[GraphAggregator] Failed to fetch workflows for ${repo.name}`);
      }

      // Dependabot Alerts (Dependencies)
      try {
        const { data: alerts } = await octokit.rest.dependabot.listAlertsForRepo({ owner: org, repo: repo.name, state: "open", per_page: 100 });
        for (const alert of alerts) {
          const depName = alert.security_vulnerability?.package?.name || alert.security_advisory?.summary || "unknown";
          const severity = alert.security_vulnerability?.severity || alert.security_advisory?.severity || "low";
          edges.push({
            pk: repoId,
            sk: `DEPENDENCY#${depName}`,
            type: "has_vulnerable_dependency",
            metadata: { severity, alert_number: alert.number }
          });
        }
      } catch (err: any) {
        if (err.status !== 403 && err.status !== 404 && err.status !== 400) console.warn(`[GraphAggregator] Failed to fetch dependabot alerts for ${repo.name}`);
      }

      // Branches
      try {
        let branchPage = 1;
        while (true) {
          const { data: branches } = await octokit.rest.repos.listBranches({ owner: org, repo: repo.name, per_page: 100, page: branchPage });
          if (branches.length === 0) break;
          for (const branch of branches) {
            edges.push({
              pk: repoId,
              sk: `BRANCH#${branch.name}`,
              type: "has_branch",
              metadata: { protected: branch.protected, default: branch.name === repo.default_branch }
            });
          }
          if (branches.length < 100) break;
          branchPage++;
        }
      } catch (err: any) {
        if (err.status !== 403 && err.status !== 404 && err.status !== 409) console.warn(`[GraphAggregator] Failed to fetch branches for ${repo.name}`);
      }
    }

    console.log(`[GraphAggregator] Generated ${edges.length} graph edges. Starting database sync...`);

    // Write edges to database
    if (usesDynamo()) {
      // Only what changed.
      //
      // This deleted every row and rewrote every row on every run. The data it
      // describes — who is in which team, who can reach which repository —
      // barely moves between one sync and the next, so almost all of those
      // writes replaced a row with an identical row. On-demand DynamoDB bills
      // per write, and a graph of thirty thousand edges rewritten four times a
      // day is 7.2 million write units a month to record almost nothing.
      //
      // The scan was already happening, to find rows to delete. Reading the
      // whole item instead of just its key makes the comparison possible, and
      // reads are an order of magnitude cheaper than writes: a steady-state
      // sync now writes nothing at all.
      console.log(`[GraphAggregator] Comparing against stored edges...`);

      const fingerprint = (e: { type: string; metadata?: any }) =>
        JSON.stringify({ t: e.type, m: e.metadata ?? null });

      /**
       * A key that cannot be confused with the data in it.
       *
       * This used to join pk and sk with "::" and split the pair back out of
       * the string when deciding what to delete. A workflow named "Build ::
       * Test" — or a Dependabot advisory summary, which is free text and ends
       * up in a DEPENDENCY# key — split into three parts, so the delete was
       * issued against a truncated sort key that matches nothing. The row it
       * meant to remove stayed: an edge for a workflow or a package that no
       * longer exists, which every security check reads as current.
       *
       * NUL cannot appear in a DynamoDB string attribute, so it cannot appear
       * in a pk or an sk either — and the pair is kept alongside the key now
       * rather than reconstructed from it, so nothing depends on that.
       */
      const keyOf = (e: { pk: string; sk: string }) => `${e.pk}\u0000${e.sk}`;

      let stored: Map<string, { fingerprint: string; pk: string; sk: string }>;
      try {
        const oldItems = await scanAll<GraphEdge>(edgesTable);
        stored = new Map(oldItems.map(i =>
          [keyOf(i), { fingerprint: fingerprint(i), pk: i.pk, sk: i.sk }]));
      } catch (e) {
        // Not survivable, and not something to write through.
        //
        // Without the stored set there is no way to know which rows have gone,
        // and writing anyway would leave orphans — rows for repositories and
        // people that no longer exist, which the security checks read as
        // current. Failing leaves the previous sync's data in place, which is
        // merely old.
        throw new Error(`Could not read the stored graph, so nothing was written: ${(e as Error).message}`);
      }

      // Deduplicated across the whole run, not per batch. The previous code
      // removed duplicates inside each batch of 25, so the same edge produced
      // twice in different batches was written twice.
      const wanted = new Map<string, GraphEdge>();
      for (const e of edges) wanted.set(keyOf(e), e);

      const puts: GraphEdge[] = [];
      for (const [key, e] of wanted) {
        if (stored.get(key)?.fingerprint !== fingerprint(e)) puts.push(e);
      }
      const deletes: { pk: string; sk: string }[] = [];
      for (const [key, row] of stored) {
        if (!wanted.has(key)) deletes.push({ pk: row.pk, sk: row.sk });
      }

      console.log(
        `[GraphAggregator] ${wanted.size} edges: ${puts.length} new or changed, ` +
        `${deletes.length} gone, ${wanted.size - puts.length} unchanged and left alone.`,
      );

      // Writes first, deletions after.
      //
      // Both orders leave a window, and this is the one whose window is
      // harmless: a moment where a renamed edge exists under both keys reads
      // as one stale row, while deleting first leaves a moment where the edge
      // exists under neither and a check running in it reports access nobody
      // has. Between "briefly duplicated" and "briefly missing", a security
      // report should never be the second.
      //
      // batchWrite retries whatever DynamoDB declines. The loops this replaces
      // read the response and discarded it, so a throttled batch — ordinary on
      // a table this size the moment on-demand capacity has to ramp — was
      // thirty thousand edges of which an unknown number were never written,
      // reported as a successful sync.
      try {
        await batchWrite(edgesTable, puts.map(item => ({ PutRequest: { Item: item } })));
      } catch (e) {
        // Rethrown rather than logged. A partial write is a graph that
        // disagrees with GitHub, and the success stamp below must not be
        // reached — a snapshot dated now is worse than one dated six hours ago,
        // because only one of them looks wrong.
        throw new Error(`Writing graph edges failed: ${(e as Error).message}`);
      }

      try {
        await batchWrite(edgesTable,
          deletes.map(k => ({ DeleteRequest: { Key: { pk: k.pk, sk: k.sk } } })));
      } catch (e) {
        // Not fatal, and deliberately not. Everything current is on disk by
        // here; what is left is rows for things that no longer exist, which the
        // next sync will try again. Over-reporting is the safe direction.
        console.error(`[GraphAggregator] Some stale edges could not be removed:`, (e as Error).message);
      }
      console.log(`[GraphAggregator] DynamoDB sync complete.`);
    } else {
      // Fallback for local development if not using DynamoDB
      // We'll write to a JSON file in the backend/data directory
      const fs = require("fs");
      const path = require("path");
      const dataDir = path.join(__dirname, "../../data");
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(path.join(dataDir, "graph-edges.json"), JSON.stringify(edges, null, 2));
      console.log(`[GraphAggregator] Wrote edges to local JSON file.`);
    }

    // Only here. Reaching this line means edges were written, so this is the
    // one point at which the snapshot on screen is genuinely this fresh —
    // stamping it earlier would date a graph that was never replaced.
    await recordGraphAggregation({
      lastSuccessAt: new Date().toISOString(),
      edgeCount: edges.length,
      lastError: undefined,
    }).catch(err => console.warn("[GraphAggregator] Could not record success:", err?.message ?? err));

  } catch (error) {
    console.error(`[GraphAggregator] Fatal error during aggregation:`, error);
    await recordGraphAggregation({ lastError: (error as Error)?.message ?? String(error) })
      .catch(() => { /* the console line above is the record of last resort */ });
  }

  // The access map is derived from these edges and cached. Without this, a
  // sync a user just asked for would appear to have changed nothing.
  invalidateAccessMap();
  // Same reason, one layer down: the raw edges are held for a few seconds, and
  // a sync is exactly the moment that held copy is wrong.
  invalidateEdgeCache();

  try {
    console.log(`[GraphAggregator] Refreshing compliance cache for all repos...`);
    const scores = await refreshAll(token);
    console.log(`[GraphAggregator] Compliance cache refreshed for ${scores.length} repos.`);
  } catch (err) {
    console.error(`[GraphAggregator] Compliance cache refresh failed:`, err);
  }
}