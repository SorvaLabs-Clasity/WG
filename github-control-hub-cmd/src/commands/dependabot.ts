import { Command } from "commander";
import { requireToken } from "../auth/tokenStore";
import { createOctokit, getOrg } from "../github/client";
import { listRepos } from "../services/repoService";
import { heading, table, spinner, error, success, info, chalk, badge } from "../utils/output";

interface DependabotAlert {
  number: number;
  state: string;
  security_advisory: {
    summary: string;
    severity: string;
  };
  dependency: {
    package: { name: string; ecosystem: string };
    manifest_path: string;
  };
  html_url: string;
}

export function registerDependabotCommands(program: Command): void {
  const dep = program.command("dependabot").description("Dependabot alert operations");

  dep
    .command("scan")
    .description("Show Dependabot alerts across all org repos")
    .option("--repo <name>", "Scan a single repo")
    .option("--state <state>", "Filter by state (open, dismissed, fixed)", "open")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const creds = requireToken();
      const octokit = createOctokit(creds.accessToken);
      const org = getOrg();

      const s = spinner("Scanning for Dependabot alerts…");
      s.start();
      try {
        let allAlerts: { repo: string; alert: DependabotAlert }[] = [];

        if (opts.repo) {
          const alerts = await fetchAlerts(octokit, org, opts.repo, opts.state);
          allAlerts = alerts.map((a) => ({ repo: opts.repo, alert: a }));
        } else {
          const repos = await listRepos(octokit);
          for (const repo of repos) {
            try {
              const alerts = await fetchAlerts(octokit, org, repo.name, opts.state);
              alerts.forEach((a) => allAlerts.push({ repo: repo.name, alert: a }));
            } catch {
              // repo may not have dependabot enabled
            }
          }
        }
        s.stop();

        if (opts.json) {
          console.log(JSON.stringify(allAlerts, null, 2));
          return;
        }

        heading(`Dependabot Alerts — ${opts.state} (${allAlerts.length})`);

        if (allAlerts.length === 0) {
          success("No alerts found. Everything looks clean.");
          return;
        }

        const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
        allAlerts.forEach(({ alert }) => {
          const sev = alert.security_advisory?.severity?.toLowerCase() || "low";
          if (sev in bySeverity) (bySeverity as any)[sev]++;
        });

        info(`Critical: ${chalk.red(String(bySeverity.critical))} | High: ${chalk.yellow(String(bySeverity.high))} | Medium: ${bySeverity.medium} | Low: ${bySeverity.low}`);
        console.log();

        table(
          ["Repo", "Package", "Severity", "Summary"],
          allAlerts.slice(0, 50).map(({ repo, alert }) => [
            repo,
            alert.dependency?.package?.name || "—",
            severityBadge(alert.security_advisory?.severity),
            (alert.security_advisory?.summary || "—").slice(0, 50),
          ])
        );

        if (allAlerts.length > 50) {
          info(`Showing first 50 of ${allAlerts.length}. Use --repo to narrow down.`);
        }
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });

  dep
    .command("enable <repo>")
    .description("Enable Dependabot alerts for a repository")
    .action(async (repo: string) => {
      const creds = requireToken();
      const octokit = createOctokit(creds.accessToken);
      const org = getOrg();

      const s = spinner(`Enabling Dependabot for ${repo}…`);
      s.start();
      try {
        await octokit.request("PUT /repos/{owner}/{repo}/vulnerability-alerts", {
          owner: org,
          repo,
        });
        s.stop();
        success(`Dependabot alerts enabled for ${chalk.bold(repo)}`);
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });

  dep
    .command("disable <repo>")
    .description("Disable Dependabot alerts for a repository")
    .action(async (repo: string) => {
      const creds = requireToken();
      const octokit = createOctokit(creds.accessToken);
      const org = getOrg();

      const s = spinner(`Disabling Dependabot for ${repo}…`);
      s.start();
      try {
        await octokit.request("DELETE /repos/{owner}/{repo}/vulnerability-alerts", {
          owner: org,
          repo,
        });
        s.stop();
        success(`Dependabot alerts disabled for ${chalk.bold(repo)}`);
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });
}

async function fetchAlerts(octokit: any, owner: string, repo: string, state: string): Promise<DependabotAlert[]> {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/dependabot/alerts", {
      owner,
      repo,
      state,
      per_page: 100,
    });
    return data || [];
  } catch {
    return [];
  }
}

function severityBadge(severity: string): string {
  const s = (severity || "unknown").toLowerCase();
  if (s === "critical") return chalk.bgRed.white.bold(` CRITICAL `);
  if (s === "high") return chalk.red("HIGH");
  if (s === "medium") return chalk.yellow("MEDIUM");
  return chalk.gray("LOW");
}
