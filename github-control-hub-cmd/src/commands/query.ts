import { Command } from "commander";
import { requireToken } from "../auth/tokenStore";
import { evaluateSecurityQuery } from "../services/graphService";
import { heading, table, spinner, error, success, info, chalk } from "../utils/output";

const AVAILABLE_QUERIES = [
  { id: "repos-missing-branch", label: "Repos missing specific branch(es)", param: "Branch name(s), comma-separated" },
  { id: "repos-no-protection", label: "Repos with no branch protection", param: null },
  { id: "repos-stale-default", label: "Repos with stale default branch", param: "Days threshold" },
  { id: "repos-no-rulesets", label: "Repos with no rulesets", param: null },
  { id: "highly-privileged-users", label: "Highly privileged users", param: "Min. repos with write/admin access" },
  { id: "repos-with-outside-collaborators", label: "Repos with outside collaborators", param: null },
  { id: "unprotected-default-branch", label: "Repos with unprotected default branch", param: null },
  { id: "repos-missing-codeowners", label: "Repos missing CODEOWNERS file", param: null },
  { id: "repos-with-vulnerabilities", label: "Repos with known vulnerabilities", param: null },
  { id: "teams-with-admin", label: "Teams with admin access", param: null },
];

export function registerQueryCommands(program: Command): void {
  const q = program.command("query").description("Analytics query operations");

  q
    .command("list")
    .description("List available analytics queries")
    .action(() => {
      heading("Available Analytics Queries");
      table(
        ["ID", "Description", "Parameter"],
        AVAILABLE_QUERIES.map((qu) => [
          qu.id,
          qu.label,
          qu.param || chalk.gray("none"),
        ])
      );
    });

  q
    .command("run <queryId>")
    .description("Run an analytics query")
    .option("--param <value>", "Query parameter value")
    .option("--json", "Output raw JSON")
    .action(async (queryId: string, opts) => {
      const creds = requireToken();

      const qDef = AVAILABLE_QUERIES.find((qu) => qu.id === queryId);
      if (!qDef) {
        error(`Unknown query: ${queryId}`);
        info("Run: ghch query list");
        return;
      }

      if (qDef.param && !opts.param) {
        error(`This query requires --param: ${qDef.param}`);
        return;
      }

      const s = spinner(`Running query: ${qDef.label}…`);
      s.start();
      try {
        const results = await evaluateSecurityQuery(queryId, opts.param, undefined, creds.accessToken);
        s.stop();

        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }

        heading(`${qDef.label}${opts.param ? ` (param: ${opts.param})` : ""}`);

        if (!results || results.length === 0) {
          success("No issues found — all clear.");
          return;
        }

        info(`${results.length} result(s):`);
        results.forEach((r: any, i: number) => {
          if (typeof r === "string") {
            console.log(`  ${i + 1}. ${r}`);
          } else if (r.repo || r.name) {
            const name = r.repo || r.name;
            const detail = r.detail || r.reason || r.role || "";
            console.log(`  ${i + 1}. ${chalk.bold(name)}${detail ? ` — ${detail}` : ""}`);
          } else {
            console.log(`  ${i + 1}. ${JSON.stringify(r)}`);
          }
        });
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });
}
