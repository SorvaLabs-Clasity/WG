import { Command } from "commander";
import { requireToken } from "../auth/tokenStore";
import { createOctokit } from "../github/client";
import { listRepos } from "../services/repoService";
import { listBranches } from "../services/branchService";
import { getAllProtections, listRulesets } from "../services/branchService";
import { heading, table, spinner, error, info, chalk, badge, kvTable } from "../utils/output";

export function registerRepoCommands(program: Command): void {
  const repo = program.command("repo").description("Repository operations");

  repo
    .command("list")
    .description("List all organization repositories")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const creds = requireToken();
      const octokit = createOctokit(creds.accessToken);
      const s = spinner("Fetching repositories…");
      s.start();
      try {
        const repos = await listRepos(octokit);
        s.stop();

        if (opts.json) {
          console.log(JSON.stringify(repos, null, 2));
          return;
        }

        heading(`Repositories (${repos.length})`);
        table(
          ["Name", "Visibility", "Default Branch", "Language", "Updated"],
          repos.map((r) => [
            r.name,
            r.private ? badge("private", "yellow") : badge("public", "green"),
            r.default_branch,
            r.language || "—",
            r.updated_at ? new Date(r.updated_at).toLocaleDateString() : "—",
          ])
        );
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });

  repo
    .command("branches <repo>")
    .description("List branches for a repository")
    .option("--json", "Output raw JSON")
    .action(async (repoName: string, opts) => {
      const creds = requireToken();
      const octokit = createOctokit(creds.accessToken);
      const s = spinner(`Fetching branches for ${repoName}…`);
      s.start();
      try {
        const branches = await listBranches(octokit, repoName);
        s.stop();

        if (opts.json) {
          console.log(JSON.stringify(branches, null, 2));
          return;
        }

        heading(`Branches for ${chalk.bold(repoName)} (${branches.length})`);
        table(
          ["Branch", "Protected", "SHA"],
          branches.map((b) => [
            b.name,
            b.protected ? chalk.green("Yes") : chalk.gray("No"),
            b.sha.slice(0, 8),
          ])
        );
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });

  repo
    .command("protections <repo>")
    .description("List branch protections and rulesets for a repository")
    .option("--json", "Output raw JSON")
    .action(async (repoName: string, opts) => {
      const creds = requireToken();
      const octokit = createOctokit(creds.accessToken);
      const s = spinner(`Fetching protections for ${repoName}…`);
      s.start();
      try {
        const [protections, rulesets] = await Promise.all([
          getAllProtections(octokit, repoName),
          listRulesets(octokit, repoName),
        ]);
        s.stop();

        if (opts.json) {
          console.log(JSON.stringify({ protections, rulesets }, null, 2));
          return;
        }

        heading(`Protections for ${chalk.bold(repoName)}`);

        const protBranches = Object.keys(protections);
        if (protBranches.length > 0) {
          info(`Classic branch protections (${protBranches.length}):`);
          table(
            ["Branch", "PR Required", "Approvals", "Enforce Admins"],
            protBranches.map((b) => {
              const p = protections[b] as any;
              return [
                b,
                p?.required_pull_request_reviews ? chalk.green("Yes") : chalk.gray("No"),
                String(p?.required_pull_request_reviews?.required_approving_review_count ?? "—"),
                p?.enforce_admins?.enabled ? chalk.green("Yes") : chalk.gray("No"),
              ];
            })
          );
        } else {
          info("No classic branch protections.");
        }

        console.log();
        const rsList = Array.isArray(rulesets) ? rulesets : [];
        if (rsList.length > 0) {
          info(`Rulesets (${rsList.length}):`);
          table(
            ["ID", "Name", "Enforcement", "Target"],
            rsList.map((rs: any) => [
              String(rs.id),
              rs.name,
              badge(rs.enforcement, rs.enforcement === "active" ? "green" : "yellow"),
              rs.conditions?.ref_name?.include?.join(", ") || "—",
            ])
          );
        } else {
          info("No rulesets.");
        }
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });
}
