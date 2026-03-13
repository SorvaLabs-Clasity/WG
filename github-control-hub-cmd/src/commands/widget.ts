import { Command } from "commander";
import inquirer from "inquirer";
import { requireToken } from "../auth/tokenStore";
import { listWidgets, getWidget, createWidget, deleteWidget, type WidgetConfig } from "../services/widgetService";
import { heading, table, spinner, error, success, info, chalk, formatDate, truncate } from "../utils/output";

export function registerWidgetCommands(program: Command): void {
  const w = program.command("widget").description("Analytics widget operations");

  w
    .command("list")
    .description("List all analytics widgets")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const s = spinner("Fetching widgets…");
      s.start();
      try {
        const widgets = await listWidgets();
        s.stop();

        if (opts.json) {
          console.log(JSON.stringify(widgets, null, 2));
          return;
        }

        heading(`Widgets (${widgets.length})`);
        if (widgets.length === 0) {
          info("No widgets configured.");
          return;
        }
        table(
          ["ID", "Title", "Query", "Display", "Created"],
          widgets.map((w) => [
            w.id.slice(0, 8),
            truncate(w.title, 30),
            w.queryId || w.presetId || "—",
            w.displayType || "table",
            formatDate(w.createdAt),
          ])
        );
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });

  w
    .command("create")
    .description("Create a new analytics widget interactively")
    .action(async () => {
      const creds = requireToken();

      const answers = await inquirer.prompt([
        { type: "input", name: "title", message: "Widget title:", validate: (v: string) => v.length > 0 || "Required" },
        {
          type: "list", name: "type", message: "Widget type:",
          choices: ["query", "preset"],
        },
        {
          type: "input", name: "queryId", message: "Query ID:",
          when: (a: any) => a.type === "query",
          validate: (v: string) => v.length > 0 || "Required",
        },
        {
          type: "input", name: "queryParam", message: "Query parameter (optional):",
          when: (a: any) => a.type === "query",
        },
        {
          type: "list", name: "displayType", message: "Display type:",
          choices: ["table", "count", "list"],
        },
      ]);

      const s = spinner("Creating widget…");
      s.start();
      try {
        const widget = await createWidget(
          {
            title: answers.title,
            type: answers.type,
            queryId: answers.queryId,
            queryParam: answers.queryParam,
            displayType: answers.displayType,
            createdBy: creds.login,
          },
          creds.login
        );
        s.stop();
        success(`Widget created: ${chalk.bold(widget.title)} (${widget.id.slice(0, 8)})`);
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });

  w
    .command("delete <id>")
    .description("Delete a widget")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id: string, opts) => {
      const creds = requireToken();

      const widgets = await listWidgets();
      const wg = widgets.find((x) => x.id === id || x.id.startsWith(id));
      if (!wg) {
        error(`Widget not found: ${id}`);
        return;
      }

      if (!opts.yes) {
        const { confirm } = await inquirer.prompt([
          { type: "confirm", name: "confirm", message: `Delete widget "${wg.title}"?`, default: false },
        ]);
        if (!confirm) return;
      }

      const s = spinner("Deleting…");
      s.start();
      try {
        await deleteWidget(wg.id, creds.login);
        s.stop();
        success(`Deleted widget: ${wg.title}`);
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });
}
