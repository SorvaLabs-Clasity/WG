import type { LoadedPermissions, LoadFailure } from "./store";

/**
 * A seam for tests, and only for tests.
 *
 * The engine is pure and already tested directly. What was not testable was the
 * *composition* — that `accessFor` reads the right person's teams with the right
 * token — because everything below it talks to GitHub. Stage 2 shipped a
 * Critical in exactly that composition (one person's teams attributed to
 * another), and its fix was guarded only by greps over the source text, which
 * would have passed had the token argument been swapped back.
 *
 * Deliberately a set of *functions* rather than a mocked Octokit: the thing
 * worth pinning is which login and which token each answer was derived from,
 * and a hook that takes those as arguments states that directly.
 *
 * Null in production. Nothing reads these unless a test has installed them.
 */
export interface TestHooks {
  loadFile?: () => LoadedPermissions | LoadFailure;
  /** Teams for the holder of this token. */
  ownTeams?: (token: string) => string[];
  /** Teams for a named login, read with the App token. */
  teamsOf?: (login: string) => string[];
  ownerOf?: (login: string) => boolean;
}

let hooks: TestHooks | null = null;

export function setPermissionsTestHooks(next: TestHooks | null): void {
  hooks = next;
}

export function testHooks(): TestHooks | null {
  return hooks;
}
