import { createOctokit, getSystemToken, getOrg } from "../github/client";
import { emptyFile, type PermissionsFile } from "./types";
import { fileProblems, isUsable } from "./validate";

/**
 * Where the permissions live, and how they are read.
 *
 * A private repository in the organization, holding one JSON file. The
 * repository's own ruleset is the security boundary — only the App may commit —
 * and its git history is the audit log. That was chosen deliberately over
 * keeping the authority in DynamoDB: the file is reviewable, diffable and
 * recoverable by hand, which matters most on the day the app is the thing that
 * is broken.
 *
 * Read with the **App token**, never the caller's. The repository is private
 * and most callers cannot see it; reading it as them would make a person's
 * permissions depend on their access to the repository that stores permissions,
 * which is a circle.
 *
 * **There is no cached fallback.** Any failure yields nothing for everybody
 * except organization owners, who are exempt in the engine. Serving a
 * last-known-good copy was considered and rejected: a cached grant is a grant
 * nobody can revoke, and somebody removing a permission during an incident has
 * to be able to believe it took effect. The sixty-second TTL below is the whole
 * window in which a revocation can still be honoured — bounded and stated,
 * rather than however long an outage lasts.
 */

export const PERMISSIONS_REPO = process.env.PERMISSIONS_REPO || "control-hub-permissions";
export const PERMISSIONS_PATH = process.env.PERMISSIONS_PATH || "permissions.json";

/** How long a successful read is reused. Matches the team-membership cache. */
const TTL_MS = 60_000;

export interface LoadedPermissions {
  file: PermissionsFile;
  /** The blob sha, needed to write without clobbering a concurrent edit. */
  sha: string | null;
  /** `absent` means the repo is there and the file is not — an ordinary first-run state. */
  source: "github" | "absent";
}

export interface LoadFailure {
  reason: "aws-only" | "no-token" | "unreachable" | "unparseable" | "invalid";
  detail: string;
  /** Present for `invalid`: what the validator objected to, for the admin screen. */
  problems?: string[];
}

export function isFailure(r: LoadedPermissions | LoadFailure): r is LoadFailure {
  return (r as LoadFailure).reason !== undefined;
}

/**
 * GitHub's contents API returns base64 wrapped at 60 characters. `Buffer.from`
 * tolerates the newlines, but stripping them is cheap and makes the intent
 * legible rather than depending on that tolerance.
 */
export function decodeFileContent(base64: string): string {
  return Buffer.from(base64.replace(/\s+/g, ""), "base64").toString("utf8");
}

let cache: { at: number; value: LoadedPermissions | LoadFailure } | null = null;

/** Drop the cached read. Called after every write, so a change is live at once. */
export function forgetPermissions(): void {
  cache = null;
}

export async function loadPermissions(now = Date.now()): Promise<LoadedPermissions | LoadFailure> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const value = await read();
  cache = { at: now, value };
  return value;
}

async function read(): Promise<LoadedPermissions | LoadFailure> {
  // An AWS-only install has no GitHub organization and no repository to hold a
  // file. The system is inert there; stage 3's gate reads this reason and lets
  // everything through.
  if (process.env.AWS_ONLY === "true") {
    return { reason: "aws-only", detail: "This deployment has no GitHub organization." };
  }

  const token = getSystemToken();
  if (!token) {
    return { reason: "no-token", detail: "The GitHub App's credentials are not loaded." };
  }

  const octokit = createOctokit(token, "Permissions");
  let data: any;
  try {
    const res = await octokit.rest.repos.getContent({
      owner: getOrg(), repo: PERMISSIONS_REPO, path: PERMISSIONS_PATH,
    });
    data = res.data;
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    // 404 is either "no repository" or "no file". Both are ordinary first-run
    // states and both mean nobody has been granted anything yet, which is the
    // correct default rather than an error.
    if (status === 404) {
      return { file: emptyFile(), sha: null, source: "absent" };
    }
    return { reason: "unreachable", detail: err?.message ?? String(err) };
  }

  if (Array.isArray(data) || typeof data?.content !== "string") {
    return { reason: "unparseable", detail: `${PERMISSIONS_PATH} is not a file.` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeFileContent(data.content));
  } catch (err: any) {
    return { reason: "unparseable", detail: err?.message ?? "not valid JSON" };
  }

  if (!isUsable(parsed)) {
    const problems = fileProblems(parsed).map(p => `${p.where}: ${p.what}`);
    return {
      reason: "invalid",
      detail: `${PERMISSIONS_PATH} cannot be used: ${problems[0]}`,
      problems,
    };
  }

  return { file: parsed, sha: data.sha ?? null, source: "github" };
}

export type WriteResult =
  | { ok: true; sha: string }
  | { ok: false; reason: "conflict" | "invalid" | "failed"; detail: string };

/**
 * The commit message, which is the audit log.
 *
 * Git history is the record of who changed whose permissions and when — chosen
 * over a separate audit table precisely because it cannot be edited from inside
 * the app. So the message has to carry the actor: the committer is the App for
 * every commit, and without the actor named in the body the history says only
 * that something changed.
 */
export function commitMessageFor(actor: string, summary: string): string {
  return `${summary}\n\nBy ${actor} via Control Hub`;
}

/**
 * Save the file, refusing rather than clobbering.
 *
 * `sha` is the blob the editor loaded. GitHub rejects the write if the file has
 * moved on, which is what stops two administrators on the same screen from
 * silently discarding each other's work — the second one is told, re-reads, and
 * re-applies.
 *
 * The file is validated *before* it is written. Writing one that cannot be read
 * back is how an administrator locks the organization out of the screen that
 * would fix it, and the validator is the same one the reader uses, so the two
 * cannot disagree about what is acceptable.
 */
export async function savePermissions(
  next: PermissionsFile, sha: string | null, actor: string, summary: string,
): Promise<WriteResult> {
  if (!isUsable(next)) {
    const problems = fileProblems(next).map(p => `${p.where}: ${p.what}`);
    return { ok: false, reason: "invalid", detail: problems.join("; ") };
  }

  const token = getSystemToken();
  if (!token) return { ok: false, reason: "failed", detail: "The GitHub App's credentials are not loaded." };

  const body = JSON.stringify(next, null, 2) + "\n";
  try {
    const octokit = createOctokit(token, "Permissions");
    const res = await octokit.rest.repos.createOrUpdateFileContents({
      owner: getOrg(),
      repo: PERMISSIONS_REPO,
      path: PERMISSIONS_PATH,
      message: commitMessageFor(actor, summary),
      content: Buffer.from(body, "utf8").toString("base64"),
      ...(sha ? { sha: sha } : {}),
    });
    // The change is live immediately rather than up to a minute later, which is
    // the difference between a screen that reflects your edit and one that
    // appears to have ignored it.
    forgetPermissions();
    return { ok: true, sha: (res.data as any)?.content?.sha ?? "" };
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    if (status === 409 || status === 422) {
      return {
        ok: false, reason: "conflict",
        detail: "Somebody else saved while this was open. Reload and re-apply your change.",
      };
    }
    return { ok: false, reason: "failed", detail: err?.message ?? String(err) };
  }
}
