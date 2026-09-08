/**
 * Reading a Renovate Dependency Dashboard issue.
 *
 * Self-hosted Renovate is a job that runs and exits: no service, no API. The
 * hosted Mend app has a web dashboard; a self-hosted bot has none. What it does
 * have is this issue, one per repository, and everything worth knowing is in
 * it — updates it tried and could not make, updates it is holding back,
 * updates waiting on a person, and every dependency it can see. None of that is
 * visible from the pull request list, where a repository erroring on every run
 * looks exactly like one with nothing to do.
 *
 * **Keyed on the HTML comment markers, not the section headings.** Renovate
 * writes markers like `<!-- unlimit-branch=renovate/axios-1.x -->` and then
 * reads them back to learn which box somebody ticked, which makes them a
 * machine contract it cannot casually change. The headings above them are
 * prose: seventeen of them, worded for people, reworded between releases.
 * Keying on a heading would break this on a Renovate upgrade, and it would
 * break *quietly*, in the direction that looks like a repository with nothing
 * pending.
 *
 * The marker carries the action too, so the category is derived from it rather
 * than from position in the document. An item under a heading this file has
 * never heard of still lands in the right bucket.
 */

/** The per-branch actions Renovate offers, exactly as it writes them. */
export type DashboardAction =
  | "unlimit"       // Rate-Limited
  | "retry"         // Errored
  | "unschedule"    // Awaiting Schedule
  | "approve"       // Pending Approval
  | "approvePr"     // PR Creation Approval Required
  | "approveGroup"  // Group Size Not Met
  | "unpend"        // Pending Status Checks, Pending Branch Automerge
  | "other"         // Other Branches
  | "rebase"        // Open
  | "recreate";     // PR Closed or Edited (Blocked)

export type DashboardCategory =
  | "rate-limited" | "errored" | "awaiting-schedule" | "pending-approval"
  | "pr-approval-required" | "group-size-not-met" | "pending-checks"
  | "other" | "open" | "blocked";

/**
 * Every marker Renovate reads back, and what each one means.
 *
 * Taken from its own dependency-dashboard source rather than from the rendered
 * issue, because the rendered issue is the part that changes.
 */
const ACTIONS: Record<DashboardAction, DashboardCategory> = {
  unlimit: "rate-limited",
  retry: "errored",
  unschedule: "awaiting-schedule",
  // Three different situations that all read as "approval" in prose. Collapsing
  // them would send somebody to tick a box that is not in that section.
  approve: "pending-approval",
  approvePr: "pr-approval-required",
  approveGroup: "group-size-not-met",
  unpend: "pending-checks",
  other: "other",
  rebase: "open",
  recreate: "blocked",
};

export function categoryOf(action: DashboardAction): DashboardCategory {
  return ACTIONS[action];
}

/** The whole-dashboard checkboxes, which act on everything rather than a branch. */
const BULK = [
  "create-all-rate-limited-prs",
  "approve-all-pending-prs",
  "create-all-awaiting-schedule-prs",
  "rebase-all-open-prs",
  "create-config-migration-pr",
  "manual job",
];

export interface DashboardItem {
  action: DashboardAction;
  category: DashboardCategory;
  /** The branch this acts on. Always present: a bulk box is not an item. */
  branch: string;
  title: string;
  /** Where the line links to a pull request, its number. */
  prNumber?: number;
  /** Already ticked, so Renovate has been asked and has not run yet. */
  checked: boolean;
}

export interface DetectedManifest {
  ecosystem: string;
  manifest: string;
  packages: string[];
}

export interface ParsedDashboard {
  items: DashboardItem[];
  bulk: { marker: string; checked: boolean }[];
  /** Every dependency Renovate can see, or null where it lists none. */
  detected: DetectedManifest[] | null;
}

const ACTION_NAMES = Object.keys(ACTIONS) as DashboardAction[];

/**
 * One dashboard, or null where the body is not one.
 *
 * Null rather than an empty dashboard, and the distinction carries weight: a
 * repository with no dashboard and a repository whose dashboard could not be
 * read are opposite claims, and only one of them means "nothing pending".
 */
export function parseDependencyDashboard(body?: string | null): ParsedDashboard | null {
  if (!body) return null;

  const items: DashboardItem[] = [];
  const bulk: { marker: string; checked: boolean }[] = [];

  for (const line of body.split("\n")) {
    const box = /^\s*[-*]\s*\[( |x|X)\]\s*<!--\s*([^>]*?)\s*-->\s*(.*)$/.exec(line);
    if (!box) continue;

    const checked = box[1].toLowerCase() === "x";
    const marker = box[2];
    const rest = box[3].trim();

    const named = /^([A-Za-z]+)-branch=(.+)$/.exec(marker);
    if (named) {
      const action = ACTION_NAMES.find(a => a === named[1]);
      // A marker shape this file does not know is skipped rather than guessed
      // into a category. Renovate adding an eleventh action should show as one
      // missing row, not as rows in the wrong bucket.
      if (!action) continue;

      // The Open section links its title at the pull request it would rebase.
      const link = /^\[([^\]]+)\]\((?:\.\.\/)?pull\/(\d+)\)/.exec(rest);
      items.push({
        action,
        category: ACTIONS[action],
        branch: named[2].trim(),
        title: (link ? link[1] : rest).replace(/\*\*/g, "").trim(),
        ...(link ? { prNumber: Number(link[2]) } : {}),
        checked,
      });
      continue;
    }

    if (BULK.includes(marker)) bulk.push({ marker, checked });
  }

  const detected = parseDetected(body);

  // Prose with no markers and no inventory is not a dashboard.
  if (items.length === 0 && bulk.length === 0 && !detected) return null;

  return { items, bulk, detected };
}

/**
 * The detected-dependencies inventory.
 *
 * Nested `<details>`: an ecosystem holds manifests, and a manifest holds
 * packages as backticked list items. Read by tracking the two summary depths
 * rather than by matching the whole block, because the block is thousands of
 * lines on a large repository and a single regex over it is the sort of thing
 * that stops matching when one blank line moves.
 */
function parseDetected(body: string): DetectedManifest[] | null {
  const start = body.search(/^##+\s*Detected dependencies\s*$/m);
  if (start === -1) return null;

  const out: DetectedManifest[] = [];
  let ecosystem = "";
  let manifest = "";
  let packages: string[] = [];

  const flush = () => {
    if (manifest) out.push({ ecosystem, manifest, packages });
    manifest = "";
    packages = [];
  };

  for (const line of body.slice(start).split("\n")) {
    const summary = /<summary>(.*?)<\/summary>/.exec(line);
    if (summary) {
      const label = summary[1].trim();
      // The outer summary is the ecosystem, the inner one a manifest path. A
      // manifest is the one with a dot or a slash in it; an ecosystem is a
      // bare word. Renovate nests them, and nothing in the markup says which
      // is which.
      if (/[./]/.test(label)) {
        flush();
        manifest = label;
      } else {
        flush();
        ecosystem = label;
      }
      continue;
    }

    const pkg = /^\s*[-*]\s*`([^`]+)`/.exec(line);
    if (pkg && manifest) packages.push(pkg[1].trim());
  }
  flush();

  return out.length > 0 ? out : null;
}

/**
 * Tick one checkbox in a dashboard body, returning the new body.
 *
 * This is how Renovate is instructed: it re-reads its own issue on the next
 * run, sees which boxes are ticked, and acts. There is no other channel for a
 * self-hosted bot, so "retry this errored update" really is an edit to a
 * Markdown file.
 *
 * Which makes precision the whole job. The body also holds the dependency
 * inventory, the repository's problems, and every other pending update, and it
 * is rewritten wholesale by the update call. Anything this function disturbs
 * beyond the one line is either lost or silently instructs Renovate to do
 * something nobody asked for.
 *
 * Returns null when the marker is not there or is already ticked. Both mean the
 * write should not happen: rewriting a body to make no change is a needless
 * edit on somebody's issue, and an already-ticked box is a request Renovate has
 * not got to yet.
 */
export function tickDashboardBox(body: string, marker: string): string | null {
  const lines = body.split("\n");
  let hit = -1;

  for (let i = 0; i < lines.length; i++) {
    const box = /^(\s*[-*]\s*\[)( |x|X)(\]\s*<!--\s*)([^>]*?)(\s*-->.*)$/.exec(lines[i]);
    if (!box || box[4] !== marker) continue;
    // Already ticked: Renovate has been asked and has not run yet.
    if (box[2].toLowerCase() === "x") return null;
    hit = i;
    break;
  }

  if (hit === -1) return null;

  // Rebuilt from the captured pieces, so the line keeps its own indentation,
  // bullet character and spacing. A normalised line would be a diff on
  // somebody's issue for no reason, and on a body Renovate rewrites it would
  // churn every run.
  lines[hit] = lines[hit].replace(
    /^(\s*[-*]\s*\[) (\]\s*<!--\s*[^>]*?\s*-->)/,
    "$1x$2");

  return lines.join("\n");
}
