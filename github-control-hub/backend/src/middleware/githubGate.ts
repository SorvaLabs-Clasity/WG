import { Request, Response, NextFunction } from "express";
import { homeAccountId } from "../aws-guardrails/accounts";

/**
 * Which AWS account the GitHub half of this app belongs to.
 *
 * An organization can reasonably want the AWS guardrails watching production
 * while everything to do with GitHub — the App's private key, the OAuth secrets,
 * the access graph, the activity log — lives only in a development account.
 * Nothing enforced that: the desktop app reads its secrets from whichever
 * account the operator signed into, so signing into production and opening the
 * Repos tab was a request for GitHub credentials in production.
 *
 * Set this to the account id where GitHub belongs. Everything except the AWS
 * tab then refuses anywhere else, and says why.
 *
 * Unset means unrestricted, which is what every existing install is: a gate
 * that switched itself on would lock people out of an app that was working
 * yesterday, and this is a deployment decision rather than a default.
 */
export const GITHUB_ACCOUNT_ID = process.env.GITHUB_ACCOUNT_ID || "";

/** Cached because it is a network call, and the answer cannot change mid-process. */
let cachedAccount: string | null = null;

/** Test seam, and a way to force a re-read after credentials change. */
export function __resetGithubGateForTests(): void {
  cachedAccount = null;
}

export interface GateVerdict {
  /** Whether the GitHub half of the app is available here. */
  allowed: boolean;
  /** The account this app is signed into, when it could be read. */
  account?: string;
  /** The account GitHub belongs to, when one is configured. */
  expected?: string;
  reason?: "unrestricted" | "match" | "wrong-account" | "unknown-account" | "no-credentials";
}

/**
 * Are there GitHub credentials in this account's secret at all?
 *
 * This is the condition that needs no configuration, and it is the one most
 * organizations actually mean. An account holding no GitHub App key and no
 * OAuth secret cannot do anything with GitHub — so a Repos tab there is a set
 * of screens that fail one at a time, each with its own error, none of which
 * says the real reason.
 *
 * Keeping GitHub out of an account is therefore done by keeping GitHub's
 * credentials out of it, which is the same sentence twice. Nothing to switch
 * on, and nothing to forget to switch on.
 */
function hasGithubCredentials(): boolean {
  return !!process.env.GITHUB_CLIENT_ID
    && !!process.env.GITHUB_CLIENT_SECRET
    && !!process.env.GITHUB_APP_ID;
}

/**
 * Whether GitHub features may be used against the account we are signed into.
 *
 * Fails **closed** on an unreadable account, but only when a restriction is
 * configured. Someone who has asked for GitHub to be confined to one account
 * has said that being unsure is not good enough; someone who has not asked for
 * anything keeps the app they had.
 */
export async function githubGate(): Promise<GateVerdict> {
  // Checked first, and needs no configuration: an account with no GitHub
  // credentials cannot use GitHub, whatever else is or is not set.
  if (!hasGithubCredentials()) return { allowed: false, reason: "no-credentials" };

  if (!GITHUB_ACCOUNT_ID) return { allowed: true, reason: "unrestricted" };

  if (cachedAccount === null) {
    try {
      cachedAccount = await homeAccountId();
    } catch {
      cachedAccount = "";
    }
  }

  if (!cachedAccount) {
    return { allowed: false, expected: GITHUB_ACCOUNT_ID, reason: "unknown-account" };
  }
  return cachedAccount === GITHUB_ACCOUNT_ID
    ? { allowed: true, account: cachedAccount, expected: GITHUB_ACCOUNT_ID, reason: "match" }
    : { allowed: false, account: cachedAccount, expected: GITHUB_ACCOUNT_ID, reason: "wrong-account" };
}

/**
 * Refuses every GitHub route when signed into the wrong account.
 *
 * Applied at the router level rather than left to the screens. A hidden tab is
 * a suggestion — the routes are reachable by anything that can talk to the
 * backend, and the point of confining GitHub to one account is not served by an
 * app that merely declines to draw the button.
 */
export async function githubGateMiddleware(
  _req: Request, res: Response, next: NextFunction,
): Promise<void> {
  const verdict = await githubGate();
  if (verdict.allowed) return next();

  const message =
    verdict.reason === "no-credentials"
      ? `This AWS account holds no GitHub credentials, so the GitHub half of this app is not ` +
        `available here. That is how GitHub is kept out of an account — the AWS tab works as ` +
        `normal, and Activity still shows what the guardrails did.`
      : verdict.reason === "unknown-account"
        ? `This app's GitHub features are limited to AWS account ${verdict.expected}, and the ` +
          `account you are signed into could not be read. Sign in again, or use the AWS tab, ` +
          `which is available in every account.`
        : `This app's GitHub features live in AWS account ${verdict.expected}. You are signed ` +
          `into ${verdict.account}, so only the AWS tab is available here — the GitHub side ` +
          `deliberately has no credentials, data or configuration in this account.`;

  res.status(403).json({
    code: verdict.reason === "no-credentials" ? "GITHUB_NOT_HERE" : "GITHUB_WRONG_ACCOUNT",
    error: message,
    account: verdict.account,
    expected: verdict.expected,
  });
}
