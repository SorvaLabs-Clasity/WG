import { Command } from "commander";
import { requireToken } from "../auth/tokenStore";
import { aggregateGraphData } from "../jobs/graphAggregator";
import { evaluateSecurityQuery } from "../services/graphService";
import { heading, table, spinner, error, success, info, chalk, badge, riskBadge } from "../utils/output";

export function registerGraphCommands(program: Command): void {
  const graph = program.command("graph").description("Knowledge graph operations");

  graph
    .command("sync")
    .description("Run full graph aggregation (fetches all org data)")
    .action(async () => {
      const creds = requireToken();

      const s = spinner("Running full graph aggregation (this may take several minutes)…");
      s.start();
      try {
        await aggregateGraphData(creds.accessToken);
        s.stop();
        success("Graph aggregation complete. All repository data has been indexed.");
      } catch (err: any) {
        s.stop();
        error(`Graph sync failed: ${err.message}`);
      }
    });

  graph
    .command("explore <repo>")
    .description("Show graph relationships for a repository")
    .option("--json", "Output raw JSON")
    .action(async (repoName: string, opts) => {
      const creds = requireToken();

      const s = spinner(`Loading graph data for ${repoName}…`);
      s.start();
      try {
        const { docClient, tableName, ScanCommand } = await import("../utils/dynamo");
        const edgesTable = tableName("GRAPH_EDGES_TABLE");

        const edges: any[] = [];
        let lastKey: any = undefined;
        do {
          const res = await docClient.send(new ScanCommand({
            TableName: edgesTable,
            FilterExpression: "begins_with(source, :src) OR begins_with(target, :src)",
            ExpressionAttributeValues: { ":src": `REPO#${repoName}` },
            ExclusiveStartKey: lastKey,
          }));
          edges.push(...(res.Items || []));
          lastKey = res.LastEvaluatedKey;
        } while (lastKey);
        s.stop();

        if (opts.json) {
          console.log(JSON.stringify(edges, null, 2));
          return;
        }

        heading(`Graph: ${chalk.bold(repoName)}`);

        if (edges.length === 0) {
          info("No graph data for this repo. Run: ghch graph sync");
          return;
        }

        const grouped: Record<string, any[]> = {
          branches: [], collaborators: [], teams: [], workflows: [], dependencies: [], other: [],
        };

        edges.forEach((e: any) => {
          const t = e.target || "";
          if (t.startsWith("BRANCH#")) grouped.branches.push({ name: t.replace("BRANCH#", ""), protected: e.metadata?.protected });
          else if (t.startsWith("USER#")) grouped.collaborators.push({ name: t.replace("USER#", ""), role: e.metadata?.role || "read" });
          else if (t.startsWith("TEAM#")) grouped.teams.push({ name: t.replace("TEAM#", ""), permission: e.metadata?.permission });
          else if (t.startsWith("WORKFLOW#")) grouped.workflows.push({ name: t.replace("WORKFLOW#", "") });
          else if (t.startsWith("DEPENDENCY#")) grouped.dependencies.push({ name: t.replace("DEPENDENCY#", ""), severity: e.metadata?.severity });
          else if (e.source?.startsWith("REPO#")) grouped.other.push({ target: t, type: e.type });
        });

        if (grouped.branches.length > 0) {
          info(`Branches (${grouped.branches.length}):`);
          table(
            ["Branch", "Protected"],
            grouped.branches.sort((a, b) => a.name.localeCompare(b.name))
              .map((b) => [b.name, b.protected ? chalk.green("Yes") : chalk.gray("No")])
          );
        }

        if (grouped.collaborators.length > 0) {
          console.log();
          info(`Collaborators (${grouped.collaborators.length}):`);
          table(
            ["User", "Role"],
            grouped.collaborators.sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => [c.name, ["admin", "write", "maintain"].includes(c.role) ? chalk.red(c.role) : c.role])
          );
        }

        if (grouped.teams.length > 0) {
          console.log();
          info(`Teams (${grouped.teams.length}):`);
          table(
            ["Team", "Permission"],
            grouped.teams.map((t) => [t.name, t.permission || "—"])
          );
        }

        if (grouped.workflows.length > 0) {
          console.log();
          info(`Workflows (${grouped.workflows.length}):`);
          grouped.workflows.forEach((w) => console.log(`  • ${w.name}`));
        }

        if (grouped.dependencies.length > 0) {
          console.log();
          info(`Vulnerable Dependencies (${grouped.dependencies.length}):`);
          table(
            ["Dependency", "Severity"],
            grouped.dependencies.map((d) => [
              d.name,
              d.severity === "critical" ? chalk.red(d.severity) :
              d.severity === "high" ? chalk.yellow(d.severity) : d.severity || "—",
            ])
          );
        }

        console.log();
        info(`Total edges: ${edges.length}`);
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });
}
