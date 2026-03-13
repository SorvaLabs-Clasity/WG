import { Command } from "commander";
import { requireToken } from "../auth/tokenStore";
import { createOctokit } from "../github/client";
import {
  getActivity, getActivityById, getChildActivities, buildActivityTree,
  markActivityUndone, markActivityRedone, markActivityRetried,
  logActivity, type ActivityEntry, type UndoPayload,
} from "../services/activityService";
import {
  deleteRuleset, deleteProtection, deleteBranch,
  protectBranch, createBranch,
} from "../services/branchService";
import { heading, table, spinner, error, success, info, chalk, badge, formatDate, truncate } from "../utils/output";

function actionBadge(action: string): string {
  if (action.includes("create") || action.includes("enable")) return badge(action, "green");
  if (action.includes("delete") || action.includes("disable")) return badge(action, "red");
  if (action.includes("undo")) return badge(action, "yellow");
  return badge(action, "blue");
}

async function executeUndo(octokit: any, payload: UndoPayload): Promise<void> {
  const { action, params } = payload;
  switch (action) {
    case "deleteBranch":
      await deleteBranch(octokit, params.repo, params.branch);
      break;
    case "createBranch":
      await createBranch(octokit, params.repo, params.branch, params.baseBranch || "main");
      break;
    case "deleteRuleset":
      await deleteRuleset(octokit, params.repo, params.rulesetId);
      break;
    case "deleteProtection":
      await deleteProtection(octokit, params.repo, params.branch);
      break;
    case "protectBranch":
      await protectBranch(octokit, params.repo, params.branch, params.protection);
      break;
    default:
      throw new Error(`Unknown undo action: ${action}`);
  }
}

export function registerActivityCommands(program: Command): void {
  const act = program.command("activity").description("Activity log operations");

  act
    .command("list")
    .description("Show recent activity log")
    .option("-n, --limit <n>", "Number of entries", "25")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const s = spinner("Fetching activity…");
      s.start();
      try {
        const entries = await getActivity(parseInt(opts.limit));
        const tree = buildActivityTree(entries);
        s.stop();

        if (opts.json) {
          console.log(JSON.stringify(tree, null, 2));
          return;
        }

        heading(`Activity Log (${tree.length} entries)`);
        if (tree.length === 0) {
          info("No activity entries.");
          return;
        }

        table(
          ["ID", "Action", "Repo", "Target", "Actor", "Time", "Status"],
          tree.map((e) => [
            e.id.slice(0, 8),
            actionBadge(e.action),
            truncate(e.repo || "—", 20),
            truncate(e.target || "—", 25),
            e.actor || "—",
            formatDate(e.timestamp),
            e.failed ? chalk.red("Failed") : e.undone ? chalk.yellow("Undone") : chalk.green("OK"),
          ])
        );
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });

  act
    .command("show <id>")
    .description("Show details of an activity entry")
    .action(async (id: string) => {
      const s = spinner("Fetching…");
      s.start();
      try {
        const entries = await getActivity(500);
        const entry = entries.find((e) => e.id === id || e.id.startsWith(id));
        s.stop();

        if (!entry) {
          error(`Activity not found: ${id}`);
          return;
        }

        heading(`Activity: ${entry.action}`);
        console.log(`  ID:      ${entry.id}`);
        console.log(`  Action:  ${actionBadge(entry.action)}`);
        console.log(`  Repo:    ${entry.repo || "—"}`);
        console.log(`  Target:  ${entry.target || "—"}`);
        console.log(`  Actor:   ${entry.actor || "—"}`);
        console.log(`  Time:    ${formatDate(entry.timestamp)}`);
        console.log(`  Source:  ${entry.source}`);
        if (entry.details) console.log(`  Details: ${entry.details}`);
        if (entry.failed) console.log(`  ${chalk.red("FAILED")}: ${entry.errorMessage || "Unknown error"}`);
        if (entry.undone) console.log(`  ${chalk.yellow("UNDONE")} at ${entry.undoneAt || "?"}`);

        if (entry.undoPayload) {
          console.log(`  Undo:    ${entry.undoPayload.action} (${JSON.stringify(entry.undoPayload.params).slice(0, 80)})`);
        }

        const children = await getChildActivities(entry.id);
        if (children.length > 0) {
          console.log();
          info(`Sub-entries (${children.length}):`);
          children.forEach((c) => {
            const status = c.failed ? chalk.red("FAIL") : c.undone ? chalk.yellow("UNDONE") : chalk.green("OK");
            console.log(`  ${c.id.slice(0, 8)} ${actionBadge(c.action)} ${c.repo || ""} ${c.target || ""} ${status}`);
          });
        }
      } catch (err: any) {
        s.stop();
        error(err.message);
      }
    });

  act
    .command("undo <id>")
    .description("Undo an activity")
    .action(async (id: string) => {
      const creds = requireToken();
      const octokit = createOctokit(creds.accessToken);

      const s = spinner("Loading activity…");
      s.start();
      try {
        const entries = await getActivity(500);
        const entry = entries.find((e) => e.id === id || e.id.startsWith(id));

        if (!entry) { s.stop(); error(`Activity not found: ${id}`); return; }
        if (entry.undone) { s.stop(); error("Already undone."); return; }
        if (!entry.undoPayload) { s.stop(); error("This activity cannot be undone (no undo payload)."); return; }

        s.text = "Executing undo…";
        const children = await getChildActivities(entry.id);
        const undoTargets = children.length > 0
          ? children.filter((c) => !c.undone && !c.failed && c.undoPayload)
          : [entry];

        for (const target of undoTargets) {
          if (target.undoPayload) {
            await executeUndo(octokit, target.undoPayload);
            await markActivityUndone(target.id);
          }
        }
        if (children.length > 0) {
          await markActivityUndone(entry.id);
        }

        await logActivity("activity.undo", creds.login, entry.repo, entry.target,
          `Undid: ${entry.action}`, undefined, "app", undefined, undefined,
          { linkedActivityId: entry.id });

        s.stop();
        success(`Undone: ${entry.action} on ${entry.repo || "—"}`);
      } catch (err: any) {
        s.stop();
        error(`Undo failed: ${err.message}`);
      }
    });

  act
    .command("redo <id>")
    .description("Redo an undone activity")
    .action(async (id: string) => {
      const creds = requireToken();
      const octokit = createOctokit(creds.accessToken);

      const s = spinner("Loading activity…");
      s.start();
      try {
        const entries = await getActivity(500);
        const entry = entries.find((e) => e.id === id || e.id.startsWith(id));

        if (!entry) { s.stop(); error(`Activity not found: ${id}`); return; }
        if (!entry.undone) { s.stop(); error("This activity is not undone."); return; }
        if (!entry.retryPayload && !entry.undoPayload) { s.stop(); error("No redo payload available."); return; }

        s.text = "Executing redo…";
        await markActivityRedone(entry.id);

        await logActivity("activity.redo", creds.login, entry.repo, entry.target,
          `Redid: ${entry.action}`, undefined, "app", undefined, undefined,
          { linkedActivityId: entry.id });

        s.stop();
        success(`Redone: ${entry.action} on ${entry.repo || "—"}`);
      } catch (err: any) {
        s.stop();
        error(`Redo failed: ${err.message}`);
      }
    });

  act
    .command("retry <id>")
    .description("Retry a failed activity")
    .action(async (id: string) => {
      const creds = requireToken();
      const octokit = createOctokit(creds.accessToken);

      const s = spinner("Loading activity…");
      s.start();
      try {
        const entries = await getActivity(500);
        const entry = entries.find((e) => e.id === id || e.id.startsWith(id));

        if (!entry) { s.stop(); error(`Activity not found: ${id}`); return; }
        if (!entry.failed) { s.stop(); error("This activity did not fail."); return; }
        if (!entry.retryPayload) { s.stop(); error("No retry payload available."); return; }

        s.text = "Retrying…";
        await markActivityRetried(entry.id);

        await logActivity("activity.retry", creds.login, entry.repo, entry.target,
          `Retried: ${entry.action}`, undefined, "app", undefined, undefined,
          { linkedActivityId: entry.id });

        s.stop();
        success(`Retry queued for: ${entry.action}`);
        info("Note: The actual operation must be re-executed manually in the CLI.");
      } catch (err: any) {
        s.stop();
        error(`Retry failed: ${err.message}`);
      }
    });
}
