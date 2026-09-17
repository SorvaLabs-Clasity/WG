import type { RequestHandler } from "express";
import { accessForSelf } from "../permissions";
import {
  configuredAccounts, permitsInAccount, scopedKey, globalKeyFor, isAccountId,
} from "../permissions/accountScope";

/**
 * One permission, in front of one route.
 *
 * Shaped like the `requireControlHubAdmin` it will eventually replace, so that
 * reading a route file still tells you what it costs to call — the guard is
 * named on the route, not looked up in a table somewhere else. That is the
 * whole reason for choosing this over a central policy map: a route added with
 * no guard is a build failure rather than a lookup miss.
 *
 * **Off until a file exists.** With nothing written in the organization, every gate calls
 * `next()` and the existing team gates continue to decide. The flag is flipped
 * in stage 4, once the dry-run has said exactly who would lose what — deny by
 * default means switching this on is a cliff, and the cliff is somebody's
 * decision rather than a deploy's side effect.
 */

export const PERMISSION_DENIED = "PERMISSION_REQUIRED";

/**
 * Kept as an explicit force-on, for an operator who wants deny-by-default
 * before writing anything. It can no longer force enforcement *off*, which was
 * the hole: on the desktop build this backend runs inside the user's own
 * Electron process, so an environment variable was a lock whose key sat beside
 * it. `enforcementActive()` in `../permissions` is the one rule now.
 */
export const PERMISSIONS_ENABLED = (): boolean =>
  process.env.PERMISSIONS_ENABLED === "true";

function gate(keys: string[], needsAll: boolean): RequestHandler {
  return (req, res, next) => {
    /**
     * No environment check here any more. `access.inert` below carries it, and
     * it is decided by the file in the organization rather than by a variable
     * on whichever machine happens to be running this process — the desktop
     * build runs this backend inside the user's own Electron process, so a
     * local variable was a lock whose key sat beside it.
     *
     * An organization with no file is still inert, so this is not a change of
     * behaviour for anybody who has not adopted permissions.
     */

    // Always the caller's own token, through the function that can only ever
    // be about the caller themselves. Omitting it — or reaching for
    // `accessForOther`, which cannot even accept one — drops stage 2's subject
    // builder into the path that lists every team in the organization, which
    // is one GitHub call per team on every request.
    accessForSelf(req.user!.login, req.user!.accessToken)
      .then(access => {
        // No organization, no file, nothing to decide.
        if (access.inert) return next();

        /**
         * Could not ask, as opposed to "you may not". Answering 403 here would
         * tell somebody they had lost access they still have, and send them to
         * request something they already hold.
         */
        if (access.failure) {
          return res.status(503).json({
            code: "PERMISSIONS_UNAVAILABLE",
            error: `Permissions could not be read, so this cannot be allowed or refused. ${access.failure.detail}`,
          });
        }

        const held = needsAll
          ? keys.every(k => access.permissions.has(k))
          : keys.some(k => access.permissions.has(k));
        if (held) return next();

        res.status(403).json({
          code: PERMISSION_DENIED,
          permission: keys.join(" or "),
          error: `This needs the "${keys.join('" or "')}" permission, which you do not have.`,
        });
      })
      .catch(err => {
        // A throw is not a decision. Closed, and said as an outage.
        res.status(503).json({
          code: "PERMISSIONS_UNAVAILABLE",
          error: `Permissions could not be read: ${err?.message ?? err}`,
        });
      });
  };
}

/** The route needs this permission. */
export function requirePermission(key: string): RequestHandler {
  return gate([key], true);
}

/** The route needs at least one of these — for a screen reachable two ways. */
export function requireAnyPermission(...keys: string[]): RequestHandler {
  return gate(keys, false);
}

/**
 * Which AWS accounts this request is about.
 *
 * The guardrail routes name them in the body — `accountIds` for the sweep and
 * preview, `accountId` for a single remediation — and a request that names
 * none is asking about the whole estate.
 */
function accountsInRequest(req: any): string[] | "all" {
  const body: any = req.body ?? {};
  const named = [
    ...(Array.isArray(body.accountIds) ? body.accountIds : []),
    ...(typeof body.accountId === "string" ? [body.accountId] : []),
    ...(typeof req.query?.accountId === "string" ? [req.query.accountId] : []),
  ].filter(id => typeof id === "string" && isAccountId(id));

  return named.length > 0 ? [...new Set(named)] : "all";
}

/**
 * The route needs this permission **in every account it touches**.
 *
 * `suffix` is the per-account form — `remediate`, `rules.enforce`,
 * `findings.read` — and the global key it corresponds to (`aws.remediate`)
 * answers for every account, so somebody granted the global form is unaffected
 * by any of this.
 *
 * A request naming no account is asking about the whole estate, and is
 * therefore held to the whole estate: every configured account must permit it.
 * The alternative — treating "unspecified" as "the ones you happen to hold" —
 * turns a sweep into a silent partial sweep whose result looks complete, which
 * is worse than a refusal because nobody can see what is missing.
 *
 * With no accounts configured the estate is empty, so this reduces to the
 * global key and behaves exactly as the un-scoped gate did.
 */
export function requirePermissionInAccounts(suffix: string): RequestHandler {
  return (req, res, next) => {
    // As `gate` above: the file decides, not this machine's environment.
    accessForSelf(req.user!.login, req.user!.accessToken)
      .then(access => {
        if (access.inert) return next();
        if (access.failure) {
          return res.status(503).json({
            code: "PERMISSIONS_UNAVAILABLE",
            error: `Permissions could not be read, so this cannot be allowed or refused. ${access.failure.detail}`,
          });
        }

        const asked = accountsInRequest(req);
        const accounts = asked === "all" ? configuredAccounts() : asked;
        const has = (key: string) => access.permissions.has(key);

        // No accounts at all: nothing is scoped, so the global key decides.
        if (accounts.length === 0) {
          if (has(globalKeyFor(suffix))) return next();
          return res.status(403).json({
            code: PERMISSION_DENIED,
            permission: globalKeyFor(suffix),
            error: `This needs the "${globalKeyFor(suffix)}" permission, which you do not have.`,
          });
        }

        const refused = accounts.filter(id => !permitsInAccount(has, id, suffix));
        if (refused.length === 0) return next();

        res.status(403).json({
          code: PERMISSION_DENIED,
          permission: scopedKey(refused[0], suffix),
          accounts: refused,
          error: `This needs "${suffix}" in ${refused.length === 1 ? "account" : "accounts"} `
            + `${refused.join(", ")}, which you do not have. `
            + `"${globalKeyFor(suffix)}" would cover every account.`,
        });
      })
      .catch(err => {
        res.status(503).json({
          code: "PERMISSIONS_UNAVAILABLE",
          error: `Permissions could not be read: ${err?.message ?? err}`,
        });
      });
  };
}
