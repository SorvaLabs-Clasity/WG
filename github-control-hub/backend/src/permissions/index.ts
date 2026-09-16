import { loadPermissions, isFailure, type LoadFailure } from "./store";
import { subjectFor } from "./subject";
import { permissionsFor, type PermissionSet } from "./evaluate";
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
}

export async function accessFor(login: string, userToken?: string): Promise<Access> {
  const [loaded, subject] = await Promise.all([
    loadPermissions(),
    subjectFor(login, userToken),
  ]);

  if (isFailure(loaded)) {
    return {
      permissions: permissionsFor(emptyFile(), subject),
      inert: loaded.reason === "aws-only",
      failure: loaded,
      unknownNodes: [],
    };
  }

  return {
    permissions: permissionsFor(loaded.file, subject),
    inert: false,
    failure: null,
    unknownNodes: unknownNodesIn(loaded.file),
  };
}
