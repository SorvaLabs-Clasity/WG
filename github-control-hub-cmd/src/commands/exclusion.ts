import { Command } from "commander";
import inquirer from "inquirer";
import { requireToken } from "../auth/tokenStore";
import { listExclusions, createExclusion, deleteExclusion, type ExclusionList } from "../services/exclusionService";
import { listRepos } from "../services/repoService";
import { createOctokit } from "../github/client";
import { heading, table, spinner, error, success, info, chalk, formatDate, truncate } from "../utils/output";

export function registerExclusionCommands(program: Command): void {
  const exc = program.command("exclusion").description("Exclusion list operations");

  exc
    .command("list")
    .description("List all exclusion lists")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const s = spinner("Fetching exclusion lists…");
      s.start();
      try {
        const lists = await listExclusions();
        s.stop();

        if (opts.json) {
          console.log(JSON.stringify(lists, null, 2));
          return;
        }

        heading(`Exclusion Lists (${lists.length})`);
        if (lists.length === 0) {
          info("No exclusion lists. Create one with: ghch exclusion create");
          return;
        }
        table(
          ["ID", "Name", "Repos", "Forced Templates", "Created"],
          lists.map((l) => [
            l.id.slice(0, 8),
            l.name,
            String(l.repos?.length || 0),
            l.forceTemplateIds?.length ? String(l.forceTemplateIds.length) : "—",
            formatDate(l.createdAt),
          ])
        );
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });

  exc
    .command("create")
    .description("Create a new exclusion list interactively")
    .action(async () => {
      const creds = requireToken();
      const octokit = createOctokit(creds.accessToken);

      const s = spinner("Loading repos…");
      s.start();
      const repos = await listRepos(octokit);
      s.stop();

      const answers = await inquirer.prompt([
        { type: "input", name: "name", message: "Exclusion list name:", validate: (v: string) => v.length > 0 || "Required" },
        { type: "input", name: "description", message: "Description (optional):" },
        {
          type: "checkbox",
          name: "repos",
          message: "Select repos to exclude:",
          choices: repos.map((r) => ({ name: r.name, value: r.name })),
        },
        { type: "input", name: "customRepos", message: "Additional custom repo names (comma-separated, optional):" },
      ]);

      const allRepos = [
        ...answers.repos,
        ...answers.customRepos.split(",").map((s: string) => s.trim()).filter(Boolean),
      ];

      const s2 = spinner("Creating exclusion list…");
      s2.start();
      try {
        const list = await createExclusion(
          {
            name: answers.name,
            description: answers.description || "",
            repos: allRepos,
            forceTemplateIds: [],
            forceOnNewTemplates: false,
            createdBy: creds.login,
          },
          creds.login
        );
        s2.stop();
        success(`Created exclusion list: ${chalk.bold(list.name)} (${list.id.slice(0, 8)}) with ${allRepos.length} repo(s)`);
      } catch (err: any) {
        s2.stop();
        error(err.message);
      }
    });

  exc
    .command("delete <id>")
    .description("Delete an exclusion list")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id: string, opts) => {
      const creds = requireToken();

      const lists = await listExclusions();
      const list = lists.find((l) => l.id === id || l.id.startsWith(id));
      if (!list) {
        error(`Exclusion list not found: ${id}`);
        return;
      }

      if (!opts.yes) {
        const { confirm } = await inquirer.prompt([
          { type: "confirm", name: "confirm", message: `Delete exclusion list "${list.name}"?`, default: false },
        ]);
        if (!confirm) return;
      }

      const s = spinner("Deleting…");
      s.start();
      try {
        await deleteExclusion(list.id, creds.login);
        s.stop();
        success(`Deleted exclusion list: ${list.name}`);
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });
}
