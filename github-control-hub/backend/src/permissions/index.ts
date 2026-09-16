import { loadPermissions, isFailure, type LoadFailure, type LoadedPermissions } from "./store";
import { subjectFor } from "./subject";
import { permissionsFor, allPermissions, type PermissionSet } from "./evaluate";
import { unknownNodesIn } from "./validate";
import { emptyFile } from "./types";

export * from "./types";
export { PERMISSIONS, isLeaf, isKnownNode, leavesUnder } from "./vocabulary";
export { forgetPermissions, savePermissions, loadPermissions, isFailure } from "./store";
export { forgetSubjects, subjectFor } from "./subject";
export { fileProblems, unknownNodesIn, isUsable } from "./validate";

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

export async function accessFor(
  login: string,
  /**
   * A token belonging to `login` **itself**, if the caller holds one.
   *
   * Never somebody else's: it is used for `GET /user/teams`, which answers for
   * whoever holds the token rather than for the login passed alongside it.
   * Asking about another person — the admin screen's dry-run diff does exactly
   * that — means omitting this, and the App token answers by name instead.
   */
  userToken?: string,
): Promise<Access> {
  try {
    const [loaded, subject] = await Promise.all([
      loadPermissions(),
      subjectFor(login, { ownToken: userToken }),
    ]);

    if (isFailure(loaded)) {
      const inert = loaded.reason === "aws-only";
      return {
        // Inert means *inert*, not "denied with a note attached". An AWS-only
        // install has no organization, no file and nothing to decide, so every
        // check passes — the same set an owner holds, from the same function,
        // so the two cannot drift apart as the vocabulary grows.
        permissions: inert
          ? allPermissions("inert", "this deployment has no GitHub organization")
          : permissionsFor(emptyFile(), subject),
        inert,
        failure: loaded,
        unknownNodes: [],
        source: null,
        sha: null,
      };
    }

    return {
      permissions: permissionsFor(loaded.file, subject),
      inert: false,
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
