import type { RequestHandler } from "express";
import { accessForSelf } from "../permissions";

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
