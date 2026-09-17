import { loadPermissions, isFailure, type LoadFailure, type LoadedPermissions } from "./store";
import { subjectFor } from "./subject";
import { permissionsFor, allPermissions, type PermissionSet, type Subject } from "./evaluate";
import { unknownNodesIn } from "./validate";
import { emptyFile } from "./types";

export * from "./types";
export { PERMISSIONS, isLeaf, isKnownNode, leavesUnder } from "./vocabulary";
export {
  currentVocabulary, setConfiguredAccounts, configuredAccounts, isKnownNodeNow,
  leavesUnderNow, permitsInAccount, scopedKey, accountNode, accountOf,
  isAccountId, globalKeyFor, SCOPED_SUFFIXES,
} from "./accountScope";
export { forgetPermissions, savePermissions, loadPermissions, isFailure } from "./store";
export { forgetSubjects, subjectFor } from "./subject";
export { fileProblems, unknownNodesIn, isUsable } from "./validate";
export { changeClasses, CHANGE_CLASS, ALL_CHANGE_CLASSES } from "./changeClasses";
export { explainPreset, type Explanation } from "./evaluate";

/**
 * What one person may do, all the way from GitHub.
 *
 * The single function the rest of the app calls. Everything below it is
 * replaceable; this signature is not.
 */
export interface Access {
  permissions: PermissionSet;
  /**
   * True on an AWS-only install, where there is no GitHub organization and no
   * repository to hold a file. The gate lets everything through — anything else
   * would make an AWS deployment depend on a GitHub feature it does not have.
   *
   * `permissions` already answers true to everything there, so a caller that
   * never reads this flag still behaves correctly. That is the point: one
   * forgotten `|| inert` in any of the gates would otherwise break every AWS
   * install, and there are far too many gates to rely on remembering.
   */
  inert: boolean;
  /**
   * Why the file could not be used, when it could not. The permissions above
   * are then empty, and an organization owner still gets in — the exemption
   * lives in the engine and the subject is read from GitHub, not from the file
   * that just failed.
   */
  failure: LoadFailure | null;
  /** Nodes the file names that this version of the app does not have. */
  unknownNodes: string[];
  /**
   * Where the file came from: `github`, `absent` (the repository is there and
   * the file is not) or `no-repo`. Null when the read failed. The admin screen
   * offers a different repair for each, so it needs to be told which.
   */
  source: LoadedPermissions["source"] | null;
  /** The blob sha this answer was read from, to save against without clobbering. */
  sha: string | null;
}

/**
 * Shared machinery behind both `accessForSelf` and `accessForOther`.
 *
 * Neither of those calls the other, and neither takes a token it could
 * forward to the wrong place. This is where the two answers are actually
 * assembled, once the caller above has already committed — by which function
 * it called — to whose token, if any, is in play. `subject` is already the
 * in-flight `subjectFor(...)` promise from that caller, so it runs concurrently
 * with `loadPermissions()` exactly as before.
 */
async function access(login: string, subject: Promise<Subject>): Promise<Access> {
  try {
    const [loaded, resolvedSubject] = await Promise.all([loadPermissions(), subject]);

    if (isFailure(loaded)) {
      const inert = loaded.reason === "aws-only";
      return {
        // Inert means *inert*, not "denied with a note attached". An AWS-only
        // install has no organization, no file and nothing to decide, so every
        // check passes — the same set an owner holds, from the same function,
        // so the two cannot drift apart as the vocabulary grows.
        permissions: inert
          ? allPermissions("inert", "this deployment has no GitHub organization")
          : permissionsFor(emptyFile(), resolvedSubject),
        inert,
        failure: loaded,
        unknownNodes: [],
        source: null,
        sha: null,
      };
    }

    /**
     * **The file is the switch.**
     *
     * Enforcement used to depend on `PERMISSIONS_ENABLED`, an environment
     * variable — and the desktop build runs this backend inside the Electron
     * process on the user's own machine, so the person being restricted owned
     * the process doing the restricting. Not setting it, which is the default,
     * turned every gate into `return next()`. Permissions were a real boundary
     * only on the hosted deployment.
     *
     * A file committed to the organization cannot be unset locally. Every
     * install reads the same one, so enforcement begins everywhere at once,
     * the moment an operator commits a file that says something.
     *
     * "Says something" is the whole test. A missing repository and a missing
     * file both load as an empty file (`source` "no-repo" / "absent"), so an
     * organization that has never adopted this is inert exactly as before —
     * and committing an empty file cannot lock everybody out of the screen
     * that would fix it.
     *
     * `PERMISSIONS_ENABLED=true` still forces enforcement on, for an operator
     * who wants deny-by-default before writing anything. It can no longer turn
     * it *off*, which was the hole.
     */
    const empty = Object.keys(loaded.file.people ?? {}).length === 0
      && Object.keys(loaded.file.presets ?? {}).length === 0
      && Object.keys(loaded.file.teams ?? {}).length === 0;
    const inert = empty && process.env.PERMISSIONS_ENABLED !== "true";

    return {
      permissions: inert
        ? allPermissions("inert", "no permissions file has been written yet")
        : permissionsFor(loaded.file, resolvedSubject),
      inert,
      failure: null,
      unknownNodes: unknownNodesIn(loaded.file),
      source: loaded.source,
      sha: loaded.sha,
    };
  } catch (err: any) {
    /**
     * Nothing below may reject. Every caller of this is a gate, and a gate that
     * throws is handled somewhere else — by an error middleware, by a `catch`
     * that logs and carries on — which is a different code path from the one
     * that denies. An unexpected throw therefore has to arrive as a closed
     * answer with a reason, not as a rejection for somebody else to interpret.
     */
    return {
      permissions: permissionsFor(emptyFile(), { login, teamSlugs: [], isOrgOwner: false }),
      inert: false,
      failure: { reason: "unreachable", detail: err?.message ?? String(err) },
      unknownNodes: [],
      source: null,
      sha: null,
    };
  }
}

/**
 * What the signed-in caller may do, on their own request.
 *
 * `ownToken` must belong to `login` **itself**: it is used for `GET
 * /user/teams`, which answers for whoever holds the token rather than for the
 * login passed alongside it. There is no way to call this about somebody
 * else — that is `accessForOther`, below, which takes no token at all.
 */
export async function accessForSelf(login: string, ownToken: string): Promise<Access> {
  return access(login, subjectFor(login, { ownToken }));
}

/**
 * What somebody *else* may do — the admin screen's dry-run diff, and nowhere
 * on the request path. Takes no token, so there is nothing to misuse: their
 * teams are resolved by name, with the App token, not attributed from
 * whatever token the caller happens to be holding.
 */
export async function accessForOther(login: string): Promise<Access> {
  return access(login, subjectFor(login));
}


/**
 * Is enforcement live for this organization?
 *
 * One rule, in one place, so the gate, the admin router, the activity feed and
 * the client's own banner cannot disagree about it. A file that says something
 * means yes; a missing repository, a missing file, or an empty one means no.
 * `PERMISSIONS_ENABLED=true` forces yes and can no longer force no.
 *
 * A read failure answers **true**: the gates fail closed on an unreadable
 * file, and a helper that answered "not enforcing" there would quietly reopen
 * everything during an outage — the exact hole this whole change closes.
 */
export async function enforcementActive(): Promise<boolean> {
  if (process.env.PERMISSIONS_ENABLED === "true") return true;
  const loaded = await loadPermissions();
  if (isFailure(loaded)) return loaded.reason !== "aws-only";
  return Object.keys(loaded.file.people ?? {}).length > 0
    || Object.keys(loaded.file.presets ?? {}).length > 0
    || Object.keys(loaded.file.teams ?? {}).length > 0;
}
