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
  /** A pull request from an earlier run is still open. */
  | "already-open"
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
  /**
   * The file landed, and will still produce nothing.
   *
   * A dependabot.yml does not switch security updates on. GitHub lists the
   * repository setting as a prerequisite for the file, not an alternative to
   * it: the file controls how updates are grouped, the setting controls
   * whether there are any. Writing one to a repository whose switch is off is
   * a silent no-op, and the person who pressed the button has every reason to
   * think it worked.
   */
  warning?: string;
}

export interface RolloutSummary {
  results: RolloutResult[];
  opened: number;
  /** Reruns that found the earlier pull request still open. */
  alreadyOpen: number;
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

/**
 * Whether to write the file to our branch, and with what sha.
 *
 * Separated out because the interesting cases are all states a *rerun* finds,
 * and none of them are reachable in a test that has to talk to GitHub. Closing
 * a pull request leaves its branch behind, so pressing the button again arrives
 * here with the file already present.
 *
 * `existing` is what is on our branch now, or null where there is nothing.
 */
export function planBranchWrite(
  content: string,
  existing: { sha?: string; content?: string } | null,
): { write: boolean; sha?: string } {
  if (!existing) return { write: true };

  // Nothing to change. Writing anyway is a commit with no difference in it,
  // on somebody's branch, on every run forever. Newlines are normalised
  // because a branch that has been through a client which rewrites them would
  // otherwise never compare equal.
  if (existing.content) {
    const onBranch = Buffer.from(existing.content, "base64").toString("utf8");
    const same = onBranch.replace(/\r\n/g, "\n") === content.replace(/\r\n/g, "\n");
    if (same) return { write: false };
  }

  // Present, and either different or unreadable. A sha is required to replace
  // a file that exists, and without one GitHub answers `Invalid request. "sha"
  // wasn't supplied`, which is what a rerun used to fail with.
  return { write: true, sha: existing.sha };
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

  /**
   * The file's current sha on **our** branch, where an earlier run left one.
   *
   * GitHub requires it to replace a file that exists, and without it a second
   * run failed on every repository the first had reached, with an error naming
   * a missing API parameter rather than the situation:
   *
   *   Invalid request. "sha" wasn't supplied.
   *
   * Read from `BRANCH` specifically, never from the default branch. A sha is
   * what turns a write into an overwrite, and on the default branch the file
   * it would overwrite is somebody else's. Here it is our own from ten minutes
   * ago.
   */
  let onBranch: { sha?: string; content?: string } | null = null;
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: org, repo, path: PATH, ref: BRANCH,
    });
    onBranch = Array.isArray(data)
      ? { sha: undefined, content: undefined }
      : { sha: (data as any)?.sha, content: (data as any)?.content };
  } catch (err: any) {
    // 404 is the normal case: a branch we just created has no such file.
    const status = err?.status ?? err?.response?.status;
    if (status !== 404) throw err;
  }

  const plan = planBranchWrite(content, onBranch);
  if (plan.write) {
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: org, repo, path: PATH, branch: BRANCH,
      message: "Enable grouped Dependabot security updates",
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(plan.sha ? { sha: plan.sha } : {}),
    });
  }

  /**
   * A pull request from an earlier run, if there is one.
   *
   * Creating a second from the same branch is refused by GitHub anyway, and
   * the one already open is the useful answer: it is where the change is.
   */
  const { data: open } = await octokit.rest.pulls.list({
    owner: org, repo, head: `${org}:${BRANCH}`, state: "open",
  });
  if (open?.length) {
    return { repo, outcome: "already-open", url: open[0].html_url };
  }

  try {
    return await createPr(octokit, org, repo, base);
  } catch (err: any) {
    // "A pull request already exists for org:branch". GitHub is telling us the
    // answer; showing its refusal instead would be showing an API error for a
    // situation the person can act on.
    if (!/already exists/i.test(String(err?.message ?? ""))) throw err;
    const { data: any_ } = await octokit.rest.pulls.list({
      owner: org, repo, head: `${org}:${BRANCH}`, state: "all",
    });
    const found = (any_ ?? [])[0];
    if (!found) throw err;
    return { repo, outcome: "already-open", url: found.html_url };
  }
}

async function createPr(
  octokit: any, org: string, repo: string, base: string,
): Promise<RolloutResult> {
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
  opts: {
    onProgress?: (done: number, total: number) => void;
    /**
     * Repositories known to have security updates switched off. Only those
     * read as off: a repository nobody could read is not one of them, and
     * warning about it would be a claim nobody established.
     */
    fixesOff?: Set<string>;
  } = {},
): Promise<RolloutSummary> {
  const queue = [...new Set(repos)];
  const results: RolloutResult[] = [];
  let done = 0;

  const worker = async () => {
    for (;;) {
      const repo = queue.shift();
      if (!repo) return;
      const result = await rolloutOne(octokit, org, repo, alertsByRepo.get(repo) ?? [], mode);
      // Said on success, because that is the case somebody walks away from.
      if (opts.fixesOff?.has(repo)
          && (result.outcome === "opened" || result.outcome === "committed"
              || result.outcome === "already-open")) {
        result.warning = "Security updates are switched off here, so this file will "
          + "produce nothing until they are on. The file controls how fixes are "
          + "grouped; the setting controls whether there are any.";
      }
      results.push(result);
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
    alreadyOpen: results.filter(r => r.outcome === "already-open").length,
    committed: results.filter(r => r.outcome === "committed").length,
    skipped: results.filter(r => r.outcome === "already-configured" || r.outcome === "no-ecosystem").length,
    failed: results.filter(r => r.outcome === "failed").length,
  };
}
