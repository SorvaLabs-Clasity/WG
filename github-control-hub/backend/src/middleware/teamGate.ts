import type { RequestHandler } from "express";
import {
  isControlHubAdmin, isAwsAdmin,
  CONTROL_HUB_ADMIN_TEAM, AWS_ADMIN_TEAM,
} from "../services/authorizationService";

/**
 * Whole-tab gates, as opposed to the per-action ones already scattered about.
 *
 * The difference is what they protect. A per-action gate stops somebody
 * *changing* the organization's settings; these stop somebody *reading* a
 * screen. That is a stronger claim and is applied only where the screen itself
 * is the sensitive thing: Access aggregates the organization's whole permission
 * map, and the AWS tab is an account somebody else administers.
 *
 * A `code` on the refusal so the client can tell "you may not see this" from
 * "this is broken", and name the team that would let you in. Without it every
 * gated screen looks like an outage.
 */

function gate(
  check: (login: string, token?: string) => Promise<boolean>,
  code: string,
  team: string,
  what: string,
): RequestHandler {
  return (req, res, next) => {
    check(req.user!.login, req.user!.accessToken)
      .then(allowed => {
        if (allowed) return next();
        res.status(403).json({
          code,
          team,
          error: `${what} is limited to the "${team}" team, and to organization owners.`,
        });
      })
      // Not a refusal. Being unable to ask GitHub is an outage, and answering
      // 403 would tell somebody they had lost access they still have.
      .catch(() => res.status(503).json({ error: "Could not verify team membership" }));
  };
}

export const CONTROL_HUB_ADMIN_REQUIRED = "CONTROL_HUB_ADMIN_REQUIRED";
export const AWS_ADMIN_REQUIRED = "AWS_ADMIN_REQUIRED";

export const requireControlHubAdmin = gate(
  isControlHubAdmin, CONTROL_HUB_ADMIN_REQUIRED, CONTROL_HUB_ADMIN_TEAM,
  "This screen");

export const requireAwsAdmin = gate(
  isAwsAdmin, AWS_ADMIN_REQUIRED, AWS_ADMIN_TEAM,
  "The AWS tab");
