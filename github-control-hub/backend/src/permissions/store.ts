import { createOctokit, getSystemToken, getOrg } from "../github/client";
import { setConfiguredAccounts, configuredAccounts } from "./accountScope";
import { emptyFile, type PermissionsFile } from "./types";
import { fileProblems, isUsable } from "./validate";
import { testHooks } from "./testing";

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

/**
 * How long a *failure* is reused, which is not the same number.
 *
 * A minute was wrong: somebody who repairs the file by pushing directly to the
 * repository — the recovery path this whole design exists to leave open — would
 * watch the app go on rejecting it for up to a minute afterwards, with nothing
 * on screen to say the fix had landed. Five seconds is still enough to stop a
 * burst of requests each re-asking GitHub the same broken question, which is
 * the only thing caching a failure was ever for.
 */
const FAILURE_TTL_MS = 5_000;

export interface LoadedPermissions {
  file: PermissionsFile;
  /** The blob sha, needed to write without clobbering a concurrent edit. */
  sha: string | null;
  /**
   * Which first-run state this is, because they are not the same repair.
   *
   * `absent` means the repository is there and the file is not — offer to
   * initialise it. `no-repo` means there is no repository to hold it — offer to
   * create one. Reporting both as "absent" sent the admin screen to write a
   * file into a repository that does not exist.
   */
  source: "github" | "absent" | "no-repo";
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

/**
 * Reads stay on the App's token, and must.
 *
 * The gate in front of every request needs this file to decide whether the
 * caller may do anything at all — including callers with no read access to the
 * repository, which after "deny by default" is most people. Reading it with
 * the caller's own token would mean nobody could be gated until they could
 * read the rules that gate them.
 *
 * Two more consumers have no caller at all: `accessForOther`, which answers
 * for somebody who is not making the request, and the scheduled passes, which
 * run with nobody signed in.
 *
 * So: the App reads, the administrator writes. See `savePermissions`.
 */
export async function loadPermissions(now = Date.now()): Promise<LoadedPermissions | LoadFailure> {
  if (cache && now - cache.at < (isFailure(cache.value) ? FAILURE_TTL_MS : TTL_MS)) {
    return cache.value;
  }
  const value = await read();
  cache = { at: now, value };

  /**
   * Keep the account registry in step with the file.
   *
   * `aws.account.<id>.*` leaves exist only for accounts the engine knows
   * about, and every permission decision reads that list — so an account
   * declared in the file has to reach the registry before the next gate runs,
   * not only when the Admin tab asks for the vocabulary. This is the one
   * function every permission decision already goes through.
   *
   * Merged rather than replaced: `resolveAccounts` registers the account the
   * app runs in, which is not in the file and must not be dropped.
   */
  if (!isFailure(value)) {
    const declared = (value.file.awsAccounts ?? [])
      .map(a => a?.accountId)
      .filter((id): id is string => typeof id === "string");
    if (declared.length > 0) {
      setConfiguredAccounts([...configuredAccounts(), ...declared]);
    }
  }

  return value;
}

async function read(): Promise<LoadedPermissions | LoadFailure> {
  const hooked = testHooks()?.loadFile;
  if (hooked) return hooked();

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

  // Both inside the try: `getOrg()` throws when `GITHUB_ORG` is unset, and a
  // throw is a fail-OPEN path here — the caller distinguishes a rejected
  // promise from a returned failure, so an unset variable has to arrive as the
  // second.
  let data: any;
  let org: string;
  try {
    org = getOrg();
    const octokit = createOctokit(token, "Permissions");
    const res = await octokit.rest.repos.getContent({
      owner: org, repo: PERMISSIONS_REPO, path: PERMISSIONS_PATH,
    });
    data = res.data;
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    /**
     * A 404 from `getContent` is three different states wearing one hat: there
     * is no repository, there is a repository and no file, or the App can no
     * longer see the repository. They are three different repairs — create the
     * repository, initialise the file, reinstall the App — and returning
     * "absent" for all three made the third one look healthy: nobody granted
     * anything, no error anywhere, and nothing to tell anybody to look.
     *
     * One probe separates them.
     */
    if (status === 404) return await probeRepository(token);
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

/**
 * Which of the three 404s this was.
 *
 * `repos.get` answers the only part GitHub will answer: whether this token can
 * see the repository at all. It succeeding means the repository is there and
 * the file is not — the ordinary first run. Anything other than a 404 means we
 * could not ask, and the most likely reason is that the App's installation no
 * longer covers this repository, which has to read as a failure rather than as
 * an empty file: an empty file grants nobody anything and says nothing is
 * wrong.
 *
 * A 404 from the probe is reported as `no-repo`. GitHub deliberately answers
 * 404 rather than 403 for a repository a token may not see, so this cannot be
 * told apart from a repository that was created and then hidden from the App —
 * but the first run of every install passes through here, and refusing to name
 * it would leave the admin screen unable to offer the one thing that fixes it.
 */
async function probeRepository(token: string): Promise<LoadedPermissions | LoadFailure> {
  const lost = (detail: string): LoadFailure => ({
    reason: "unreachable",
    detail: `${detail} The App may have lost access to ${PERMISSIONS_REPO}.`,
  });

  try {
    const octokit = createOctokit(token, "Permissions");
    await octokit.rest.repos.get({ owner: getOrg(), repo: PERMISSIONS_REPO });
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    if (status === 404) return { file: emptyFile(), sha: null, source: "no-repo" };
    return lost(`${PERMISSIONS_REPO} could not be read: ${err?.message ?? String(err)}.`);
  }

  // The repository answered, so the file is simply not in it yet.
  return { file: emptyFile(), sha: null, source: "absent" };
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
  writerToken?: string,
): Promise<WriteResult> {
  if (!isUsable(next)) {
    const problems = fileProblems(next).map(p => `${p.where}: ${p.what}`);
    return { ok: false, reason: "invalid", detail: problems.join("; ") };
  }

  /**
   * The write goes out with the administrator's own token, not the App's.
   *
   * This is the rule the rest of the app already follows — "it must not let
   * anyone do something they could not do themselves on github.com" — and this
   * was the one write that broke it. Three things follow from fixing it:
   *
   * - The commit is authored by the person who made the change, so the git
   *   history that *is* the audit log names them rather than naming the App
   *   nine times.
   * - GitHub decides, natively and per-commit. Somebody removed from the admin
   *   team loses the ability to write the file at the moment they are removed,
   *   without the app being told or being correct.
   * - The organization's rulesets can grant a *team* push access instead of
   *   granting an App a blanket bypass. A team is a smaller, auditable set, and
   *   its membership is already the thing that gates this screen.
   *
   * Reads stay on the App's token deliberately — see `loadPermissions`. The
   * App needs Contents: Read here; it no longer needs write.
   */
  const token = writerToken ?? getSystemToken();
  if (!token) {
    return {
      ok: false, reason: "failed",
      detail: writerToken === undefined
        ? "The GitHub App's credentials are not loaded."
        : "You are not signed in to GitHub, so this change has nobody to attribute it to.",
    };
  }

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

    /**
     * No sha is a failure, not an empty string.
     *
     * The write sends `...(sha ? { sha } : {})`, and `""` is falsy — so an
     * empty sha round-tripped into the next save omits the sha entirely, and
     * that save overwrites a concurrent edit without GitHub ever objecting.
     * The one guard against two administrators discarding each other's work
     * would have been switched off by the value the last successful save
     * handed back. Saying so costs a reload; not saying so costs somebody's
     * edit, silently.
     */
    const written = (res.data as any)?.content?.sha;
    if (typeof written !== "string" || written.length === 0) {
      return {
        ok: false, reason: "failed",
        detail: "The save was accepted but GitHub returned no sha for it. "
          + "Reload before saving again, so the next save cannot overwrite a concurrent edit.",
      };
    }
    return { ok: true, sha: written };
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;

    /**
     * An empty repository is not a concurrent edit.
     *
     * The Contents API answers 409 for both, and mapping the pair to one
     * message told operators "somebody else saved while this was open" about a
     * repository that had never been written to at all — on the migration,
     * which is the first thing anybody runs. The advice it gave (reload and
     * re-apply) could not work, because there was nothing to reload and the
     * next attempt failed identically.
     *
     * GitHub says which it is in the message, so read it rather than guess.
     */
    const message = String(err?.message ?? "");
    if (status === 409 && /empty/i.test(message)) {
      return {
        ok: false, reason: "failed",
        detail: `The ${PERMISSIONS_REPO} repository has no commits yet, so there is no branch to write to. `
          + "Add any file to it on GitHub — a README is enough — and run this again.",
      };
    }

    /**
     * A ruleset refusal is not a concurrent edit either.
     *
     * Organization rulesets — "require a pull request before merging", most
     * often — refuse a direct commit with the same 409/422 the sha check uses.
     * Told "somebody else saved while this was open", an operator reloads,
     * tries again, and gets it again, because nothing about reloading changes
     * whether a rule allows the write. GitHub names the rule in the message;
     * passing it through is the difference between a dead end and a fix.
     */
    /**
     * With the administrator's own token doing the writing, "you may not" is a
     * live answer from GitHub rather than a misconfiguration — and it is the
     * one an operator will hit first, because granting the team push access is
     * a separate step from putting somebody on the team.
     */
    if (status === 403 || status === 404) {
      return {
        ok: false, reason: "failed",
        detail: `GitHub refused to let you write ${PERMISSIONS_REPO}. `
          + "Opening this screen needs team membership; committing the file needs push access "
          + "to that repository, which is granted on GitHub and not here. "
          + "Ask an organization owner to give the Control Hub admin team write access to it.",
      };
    }

    if (/rule|ruleset|protected branch|pull request/i.test(message)) {
      return {
        ok: false, reason: "failed",
        detail: `GitHub refused the commit: ${message} `
          + `Add the app to that ruleset's bypass list, or exclude ${PERMISSIONS_REPO} from it.`,
      };
    }

    if (status === 409 || status === 422) {
      return {
        ok: false, reason: "conflict",
        detail: "Somebody else saved while this was open. Reload and re-apply your change.",
      };
    }
    return { ok: false, reason: "failed", detail: err?.message ?? String(err) };
  }
}
