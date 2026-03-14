import { Command } from "commander";
import inquirer from "inquirer";
import { requireToken } from "../auth/tokenStore";
import { createOctokit } from "../github/client";
import { listTemplates, getTemplate, createTemplate, deleteTemplate, applyTemplate, type RepoTemplate, type BranchRule } from "../services/templateService";
import { listRepos } from "../services/repoService";
import { heading, table, spinner, error, success, info, chalk, kvTable, badge, truncate, formatDate } from "../utils/output";

export function registerTemplateCommands(program: Command): void {
  const tmpl = program.command("template").description("Template operations");

  tmpl
    .command("list")
    .description("List all templates")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const s = spinner("Fetching templates…");
      s.start();
      try {
        const templates = await listTemplates();
        s.stop();

        if (opts.json) {
          console.log(JSON.stringify(templates, null, 2));
          return;
        }

        heading(`Templates (${templates.length})`);
        if (templates.length === 0) {
          info("No templates found. Create one with: ghch template create");
          return;
        }
        table(
          ["ID", "Name", "Branches", "Auto-Apply", "Created"],
          templates.map((t) => [
            t.id.slice(0, 8),
            t.name,
            String(t.branches?.length || 0),
            t.autoApplyOnNewRepo ? chalk.green("Yes") : chalk.gray("No"),
            formatDate(t.createdAt),
          ])
        );
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });

  tmpl
    .command("show <id>")
    .description("Show template details")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      const s = spinner("Fetching template…");
      s.start();
      try {
        const templates = await listTemplates();
        const t = templates.find((x) => x.id === id || x.id.startsWith(id));
        s.stop();

        if (!t) {
          error(`Template not found: ${id}`);
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(t, null, 2));
          return;
        }

        heading(`Template: ${t.name}`);
        kvTable([
          ["ID", t.id],
          ["Name", t.name],
          ["Description", t.description || "—"],
          ["Auto-Apply", t.autoApplyOnNewRepo ? "Yes" : "No"],
          ["Created By", t.createdBy],
          ["Created At", formatDate(t.createdAt)],
          ["Updated At", formatDate(t.updatedAt)],
        ]);

        if (t.branches && t.branches.length > 0) {
          console.log();
          info(`Branch Rules (${t.branches.length}):`);
          t.branches.forEach((br: BranchRule, i: number) => {
            console.log(`  ${chalk.bold(`${i + 1}.`)} Branches: ${chalk.cyan(br.branchNames.join(", "))}`);
            console.log(`     Type: ${br.protection?.type} | PR Required: ${br.protection?.requirePr ? "Yes" : "No"} | Approvals: ${br.protection?.requiredApprovals}`);
            if (br.protection?.rulesetName) console.log(`     Ruleset: ${br.protection.rulesetName}`);
          });
        }
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });

  tmpl
    .command("create")
    .description("Create a new template interactively")
    .action(async () => {
      const creds = requireToken();

      const answers = await inquirer.prompt([
        { type: "input", name: "name", message: "Template name:", validate: (v: string) => v.length > 0 || "Required" },
        { type: "input", name: "description", message: "Description (optional):" },
        { type: "confirm", name: "autoApply", message: "Auto-apply to new repos?", default: false },
      ]);

      const branches: BranchRule[] = [];
      let addMore = true;
      while (addMore) {
        const br = await inquirer.prompt([
          { type: "input", name: "branchNames", message: "Branch name(s) (comma-separated):", validate: (v: string) => v.length > 0 || "Required" },
          { type: "list", name: "type", message: "Protection type:", choices: ["ruleset", "classic"] },
          { type: "input", name: "rulesetName", message: "Ruleset name:", when: (a: any) => a.type === "ruleset", default: "default-protection" },
          { type: "confirm", name: "requirePr", message: "Require pull requests?", default: true },
          { type: "number", name: "requiredApprovals", message: "Required approvals:", default: 1 },
          { type: "confirm", name: "enforceAdmins", message: "Enforce for admins?", default: true },
          { type: "confirm", name: "preventForcePush", message: "Prevent force push?", default: true },
          { type: "confirm", name: "preventDeletion", message: "Prevent deletion?", default: true },
        ]);

        branches.push({
          branchNames: br.branchNames.split(",").map((s: string) => s.trim()),
          protection: {
            type: br.type,
            rulesetName: br.rulesetName,
            requirePr: br.requirePr,
            requiredApprovals: br.requiredApprovals,
            dismissStaleReviews: false,
            requireCodeOwnerReviews: false,
            requireConversationResolution: false,
            requireStatusChecks: false,
            strictStatusChecks: false,
            requireSignedCommits: false,
            requireLinearHistory: false,
            enforceAdmins: br.enforceAdmins,
            preventForcePush: br.preventForcePush,
            preventDeletion: br.preventDeletion,
          },
        });

        const { more } = await inquirer.prompt([
          { type: "confirm", name: "more", message: "Add another branch rule?", default: false },
        ]);
        addMore = more;
      }

      const s = spinner("Creating template…");
      s.start();
      try {
        const template = await createTemplate(
          {
            name: answers.name,
            description: answers.description || "",
            branches,
            autoApplyOnNewRepo: answers.autoApply,
            createdBy: creds.login,
          },
          creds.login
        );
        s.stop();
        success(`Template created: ${chalk.bold(template.name)} (${template.id.slice(0, 8)})`);
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });

  tmpl
    .command("apply <id>")
    .description("Apply a template to repositories")
    .requiredOption("--repos <repos>", "Comma-separated list of repo names")
    .option("--dry-run", "Preview without making changes")
    .action(async (id: string, opts) => {
      const creds = requireToken();
      const octokit = createOctokit(creds.accessToken);

      const s = spinner("Loading template…");
      s.start();
      const templates = await listTemplates();
      const t = templates.find((x) => x.id === id || x.id.startsWith(id));
      s.stop();

      if (!t) {
        error(`Template not found: ${id}`);
        return;
      }

      const repos = opts.repos.split(",").map((r: string) => r.trim());
      info(`Applying template ${chalk.bold(t.name)} to ${repos.length} repo(s)…\n`);

      if (opts.dryRun) {
        info("DRY RUN — no changes will be made.");
        repos.forEach((r: string) => console.log(`  • ${r}`));
        return;
      }

      for (const repo of repos) {
        const rs = spinner(`  ${repo}…`);
        rs.start();
        try {
          const result = await applyTemplate(octokit, t.id, repo, creds.login);
          rs.stop();

          const parts: string[] = [];
          if (result.created.length) parts.push(`${result.created.length} branches created`);
          if (result.protected.length) parts.push(`${result.protected.length} protections applied`);
          if (result.errors.length) parts.push(chalk.red(`${result.errors.length} errors`));
          if (result.conflicts.length) parts.push(chalk.yellow(`${result.conflicts.length} conflicts`));

          success(`${repo}: ${parts.join(", ") || "done"}`);

          if (result.conflicts.length > 0) {
            result.conflicts.forEach((c) => {
              console.log(`    ${chalk.yellow("⚠")} Conflict: ${c.type} "${c.name}" — ${c.differences.join("; ")}`);
            });
          }
          if (result.errors.length > 0) {
            result.errors.forEach((e) => console.log(`    ${chalk.red("✗")} ${e}`));
          }
        } catch (err: any) {
          rs.stop();
          error(`${repo}: ${err.message}`);
        }
      }
    });

  tmpl
    .command("delete <id>")
    .description("Delete a template")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id: string, opts) => {
      const creds = requireToken();

      const templates = await listTemplates();
      const t = templates.find((x) => x.id === id || x.id.startsWith(id));
      if (!t) {
        error(`Template not found: ${id}`);
        return;
      }

      if (!opts.yes) {
        const { confirm } = await inquirer.prompt([
          { type: "confirm", name: "confirm", message: `Delete template "${t.name}"?`, default: false },
        ]);
        if (!confirm) return;
      }

      const s = spinner("Deleting…");
      s.start();
      try {
        await deleteTemplate(t.id, creds.login);
        s.stop();
        success(`Deleted template: ${t.name}`);
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });
}
