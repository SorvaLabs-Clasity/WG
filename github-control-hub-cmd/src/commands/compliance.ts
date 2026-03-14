import { Command } from "commander";
import inquirer from "inquirer";
import { requireToken } from "../auth/tokenStore";
import { createOctokit } from "../github/client";
import { calculateRepoCompliance, type RepoComplianceScore } from "../services/complianceService";
import { getCachedScores, refreshAll, refreshRepo } from "../services/complianceCacheService";
import { getComplianceConfig, updateComplianceConfig, type ComplianceRule } from "../services/complianceConfigService";
import { listRepos } from "../services/repoService";
import { heading, table, spinner, error, success, info, chalk, badge, kvTable } from "../utils/output";

function scoreBadge(score: number): string {
  if (score >= 90) return chalk.green(`${score}%`);
  if (score >= 70) return chalk.yellow(`${score}%`);
  return chalk.red(`${score}%`);
}

export function registerComplianceCommands(program: Command): void {
  const comp = program.command("compliance").description("Compliance operations");

  comp
    .command("check")
    .description("Run a full compliance scan (or show cached results)")
    .option("--refresh", "Force refresh all repos instead of using cache")
    .option("--repo <name>", "Check a single repo")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const creds = requireToken();

      const s = spinner("Loading compliance data…");
      s.start();
      try {
        let scores: RepoComplianceScore[];

        if (opts.repo) {
          s.text = `Scanning ${opts.repo}…`;
          const score = await refreshRepo(creds.accessToken, opts.repo);
          scores = [score];
        } else if (opts.refresh) {
          s.text = "Refreshing all repos (this may take a while)…";
          scores = await refreshAll(creds.accessToken);
        } else {
          scores = await getCachedScores();
          if (scores.length === 0) {
            s.text = "No cached data. Running full scan…";
            scores = await refreshAll(creds.accessToken);
          }
        }
        s.stop();

        if (opts.json) {
          console.log(JSON.stringify(scores, null, 2));
          return;
        }

        heading(`Compliance Report (${scores.length} repos)`);

        const sorted = [...scores].sort((a, b) => a.score - b.score);
        table(
          ["Repo", "Score", "Protections", "Rulesets", "Req. Files", "Issues"],
          sorted.map((sc) => [
            sc.repo,
            scoreBadge(sc.score),
            sc.protectionsActive ? chalk.green("Yes") : chalk.red("No"),
            sc.rulesetsActive ? chalk.green("Yes") : chalk.gray("No"),
            sc.hasRequiredFiles ? chalk.green("Yes") : chalk.red("No"),
            sc.issues.length > 0 ? chalk.yellow(String(sc.issues.length)) : chalk.green("0"),
          ])
        );

        const avg = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b.score, 0) / scores.length) : 0;
        const failing = scores.filter((s) => s.score < 70).length;
        console.log();
        info(`Average score: ${scoreBadge(avg)} | Failing (<70%): ${failing > 0 ? chalk.red(String(failing)) : "0"}`);
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });

  comp
    .command("config")
    .description("Show or edit compliance rules")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const s = spinner("Loading config…");
      s.start();
      try {
        const config = await getComplianceConfig();
        s.stop();

        if (opts.json) {
          console.log(JSON.stringify(config, null, 2));
          return;
        }

        heading("Compliance Rules");
        if (!config.rules || config.rules.length === 0) {
          info("No compliance rules configured.");
          return;
        }

        table(
          ["ID", "Name", "Enabled", "Weight", "Type"],
          config.rules.map((r) => [
            r.id.slice(0, 8),
            r.name,
            r.enabled ? chalk.green("Yes") : chalk.gray("No"),
            String(r.weight),
            r.type || "—",
          ])
        );

        const { edit } = await inquirer.prompt([
          { type: "confirm", name: "edit", message: "Toggle any rules?", default: false },
        ]);
        if (!edit) return;

        const { toggleIds } = await inquirer.prompt([
          {
            type: "checkbox",
            name: "toggleIds",
            message: "Select rules to toggle:",
            choices: config.rules.map((r) => ({
              name: `${r.name} (${r.enabled ? "enabled" : "disabled"})`,
              value: r.id,
            })),
          },
        ]);

        if (toggleIds.length > 0) {
          const updated = config.rules.map((r) =>
            toggleIds.includes(r.id) ? { ...r, enabled: !r.enabled } : r
          );
          await updateComplianceConfig(updated);
          success(`Toggled ${toggleIds.length} rule(s).`);
        }
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });

  comp
    .command("refresh")
    .description("Refresh compliance cache for all repos")
    .option("--repo <name>", "Refresh a single repo")
    .action(async (opts) => {
      const creds = requireToken();

      const s = spinner("Refreshing compliance data…");
      s.start();
      try {
        if (opts.repo) {
          await refreshRepo(creds.accessToken, opts.repo);
          s.stop();
          success(`Refreshed compliance for ${opts.repo}`);
        } else {
          const scores = await refreshAll(creds.accessToken);
          s.stop();
          success(`Refreshed compliance for ${scores.length} repos`);
        }
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });
}
