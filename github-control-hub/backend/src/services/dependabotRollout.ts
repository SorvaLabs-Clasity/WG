import { buildDependabotConfig } from "./dependabotConfig";

/**
 * Putting the Dependabot configuration into repositories.
 *
 * Everything here writes to somebody's repository, which makes it different in
 * kind from the rest of this codebase, and the rules follow from that:
 *
 * - A repository that already has a dependabot.yml is skipped, never merged
 *   into and never replaced. Somebody wrote that file, possibly to exclude a
 *   dependency deliberately, and silently overwriting it would be the worst
 *   thing this feature could do.
 * - A repository whose alerts name no configurable ecosystem is skipped, not
 *   given an empty file.
 * - Writes are paced. These are the writes GitHub applies secondary rate
 *   limits to, and a burst is refused rather than queued.
 * - Every outcome is reported per repository. "It ran" is not an answer when
 *   the thing it ran was a write to sixty-six repositories.
 */

const BRANCH = "control-hub/dependabot-security-updates";
const PATH = ".github/dependabot.yml";
const CONCURRENCY = 2;
const GAP_MS = 400;
const MAX_ATTEMPTS = 4;

export type RolloutMode = "pr" | "commit";

export type RolloutOutcome =
  | "opened"
  | "committed"
  | "already-configured"
  | "no-ecosystem"
  | "failed";

export interface RolloutResult {
  repo: string;
  outcome: RolloutOutcome;
  /** The pull request, where one was opened. */
  url?: string;
  detail?: string;
}

export interface RolloutSummary {
  results: RolloutResult[];
  opened: number;
  committed: number;
  skipped: number;
  failed: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function isSecondaryLimit(err: any): boolean {
  const status = err?.status ?? err?.response?.status;
  const message = String(err?.message ?? "");
  return status === 403 && /secondary rate limit|abuse detection/i.test(message);
}

function retryAfterMs(err: any, attempt: number): number {
  const header = Number(err?.response?.headers?.["retry-after"]);
  if (Number.isFinite(header)) return Math.min(30_000, Math.max(1_000, header * 1000));
  return Math.min(15_000, 1_000 * 2 ** attempt);
}

/**
 * Whether this repository already has a configuration.
 *
 * Read rather than assumed, and read at the moment of writing rather than
 * taken from the stored sweep: the sweep can be half an hour old, and half an
 * hour is long enough for somebody to have added one.
 *
 * A read that fails is treated as "already configured", so the repository is
 * skipped. Erring towards skipping means a repository that needed the file
 * does not get it, which somebody can see and rerun. Erring the other way
 * means overwriting a file we could not read.
 */
async function hasConfig(octokit: any, org: string, repo: string): Promise<boolean> {
  for (const path of [PATH, ".github/dependabot.yaml"]) {
    try {
      await octokit.rest.repos.getContent({ owner: org, repo, path });
      return true;
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      // 404 is the answer we want: no file. Anything else is a question we
      // could not ask, and is not read as an absence.
      if (status !== 404) return true;
    }
  }
  return false;
}

async function writeToBranch(
  octokit: any, org: string, repo: string, content: string, mode: RolloutMode,
): Promise<RolloutResult> {
  const { data: repoInfo } = await octokit.rest.repos.get({ owner: org, repo });
  const base = repoInfo.default_branch;

  if (mode === "commit") {
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: org, repo, path: PATH, branch: base,
      message: "Enable grouped Dependabot security updates",
      content: Buffer.from(content, "utf8").toString("base64"),
    });
    return { repo, outcome: "committed" };
  }

  const { data: ref } = await octokit.rest.git.getRef({
    owner: org, repo, ref: `heads/${base}`,
  });

  // A branch left behind by an earlier run is reused rather than colliding.
  try {
    await octokit.rest.git.createRef({
      owner: org, repo, ref: `refs/heads/${BRANCH}`, sha: ref.object.sha,
    });
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    if (status !== 422) throw err;
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner: org, repo, path: PATH, branch: BRANCH,
    message: "Enable grouped Dependabot security updates",
    content: Buffer.from(content, "utf8").toString("base64"),
  });

  const { data: pr } = await octokit.rest.pulls.create({
    owner: org, repo, head: BRANCH, base,
    title: "Enable grouped Dependabot security updates",
    body:
      "This repository has open Dependabot alerts with available patches and no "
      + "pull requests fixing them. The repository setting alone had not produced "
      + "them.\n\n"
      + "Turning on grouped security updates is the one thing GitHub documents as "
      + "immediately retrying every open alert that has a patch. Merging this "
      + "should start those pull requests arriving, grouped into one per manifest "
      + "rather than one per alert.\n\n"
      + "Version updates stay off (`open-pull-requests-limit: 0`), so this adds no "
      + "routine upgrade noise. Every entry was derived from an alert this "
      + "repository actually raised.\n\n"
      + "Opened by GitHub Control Hub.",
  });

  return { repo, outcome: "opened", url: pr.html_url };
}

/**
 * One repository, with its own alerts deciding what its configuration says.
 */
async function rolloutOne(
  octokit: any, org: string, repo: string,
  alerts: { ecosystem?: string; manifest_path?: string | null }[],
  mode: RolloutMode,
): Promise<RolloutResult> {
  if (await hasConfig(octokit, org, repo)) {
    return { repo, outcome: "already-configured" };
  }

  const content = buildDependabotConfig(alerts);
  if (!content) {
    return {
      repo, outcome: "no-ecosystem",
      detail: "None of its alerts name an ecosystem Dependabot can be configured for",
    };
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await writeToBranch(octokit, org, repo, content, mode);
    } catch (err: any) {
      // A secondary limit is GitHub asking to wait, so it is waited out. Any
      // other refusal will refuse again however long we wait: a repository
      // nobody can write to, an archived one, a branch that is protected.
      if (!isSecondaryLimit(err) || attempt === MAX_ATTEMPTS - 1) {
        // The expected refusal on a commit, and the reason the re-trigger
        // exists. "422" on its own at the end of a run of sixty-six tells
        // nobody what to do next.
        const message = String(err?.message ?? err);
        const protectedBranch = mode === "commit"
          && (err?.status === 409 || err?.status === 422 || /protected/i.test(message));
        return {
          repo, outcome: "failed",
          detail: protectedBranch
            ? "Its default branch is protected, so it cannot be committed to directly. "
              + "Open a config pull request for this one instead."
            : message,
        };
      }
      await sleep(retryAfterMs(err, attempt));
    }
  }
  return { repo, outcome: "failed", detail: "Gave up after repeated rate limiting" };
}

export async function runDependabotRollout(
  octokit: any,
  org: string,
  repos: string[],
  alertsByRepo: Map<string, { ecosystem?: string; manifest_path?: string | null }[]>,
  mode: RolloutMode,
  opts: { onProgress?: (done: number, total: number) => void } = {},
): Promise<RolloutSummary> {
  const queue = [...new Set(repos)];
  const results: RolloutResult[] = [];
  let done = 0;

  const worker = async () => {
    for (;;) {
      const repo = queue.shift();
      if (!repo) return;
      results.push(await rolloutOne(octokit, org, repo, alertsByRepo.get(repo) ?? [], mode));
      done++;
      opts.onProgress?.(done, repos.length);
      // Deliberate even on success: the limit that refuses these is about the
      // rate of writes, not their outcome.
      await sleep(GAP_MS);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  return {
    results,
    opened: results.filter(r => r.outcome === "opened").length,
    committed: results.filter(r => r.outcome === "committed").length,
    skipped: results.filter(r => r.outcome === "already-configured" || r.outcome === "no-ecosystem").length,
    failed: results.filter(r => r.outcome === "failed").length,
  };
}
