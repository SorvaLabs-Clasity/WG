/**
 * Creating an AWS SSO profile from the app, without a terminal.
 *
 * `aws configure sso` already does this, and it is a wizard in a terminal. The
 * people most likely to be handed this app — somebody asked to look after an
 * organization's GitHub settings — are not necessarily the people comfortable
 * editing `~/.aws/config` by hand, and getting one line of it wrong produces an
 * error that names none of what is wrong.
 *
 * The hard part is not writing the file. It is that a person setting this up
 * knows their sign-in URL and nothing else: not the twelve-digit account number,
 * not the exact role name. Both are required in the file, and both are exactly
 * the sort of thing somebody guesses wrong.
 *
 * So this asks AWS. It is the same device-authorization flow the CLI uses:
 * register a client, ask AWS to start an authorization, send the person to their
 * browser to approve it, and then read back the accounts and roles they actually
 * have. They pick from a list rather than typing an account number.
 *
 * **No SDK.** These are plain REST endpoints — the OIDC ones are unauthenticated
 * by design, because they run before anybody has credentials, and the portal
 * ones take a bearer token rather than a signed request. `fetch` covers all of
 * it, which keeps two more packages out of a bundle that ships to desktops.
 */

/**
 * "Keep waiting", in both spellings AWS uses.
 *
 * This endpoint is RFC 8628 — the OAuth device flow — so over the wire it
 * answers with OAuth's own codes: `authorization_pending`, `slow_down`. The
 * AWS SDK surfaces those as exception classes named
 * `AuthorizationPendingException` and `SlowDownException`, and the API
 * reference lists the class names, which is where a wrong assumption comes
 * from. Only the SDK ever sees those names; calling the endpoint directly gets
 * the snake_case form.
 *
 * Matching the class names alone meant "the person has not clicked yet" — the
 * ordinary answer to the first several polls — was treated as a failure, and
 * the screen waited for ever for a poll that had already given up.
 *
 * Both are accepted rather than one, because being wrong here is invisible:
 * everything looks fine until somebody actually tries to sign in.
 */
const KEEP_WAITING = new Set([
  "authorization_pending", "AuthorizationPendingException",
  "slow_down", "SlowDownException",
]);

/** "That request is too old to finish" — a real failure, and a specific one. */
const EXPIRED = new Set(["expired_token", "ExpiredTokenException"]);

export interface DeviceAuthorization {
  clientId: string;
  clientSecret: string;
  deviceCode: string;
  /** The URL to open. Carries the code, so nobody has to type one in. */
  verificationUriComplete: string;
  /** Shown as a fallback, for when the browser opens somewhere unexpected. */
  userCode: string;
  /** Seconds between polls, as AWS asks. */
  interval: number;
  expiresAt: number;
}

export interface SsoAccount {
  accountId: string;
  accountName: string;
  emailAddress?: string;
  roles: string[];
}

const oidc = (region: string) => `https://oidc.${region}.amazonaws.com`;
const portal = (region: string) => `https://portal.sso.${region}.amazonaws.com`;

/**
 * A start URL, as far as we are willing to believe one.
 *
 * Checked because it is about to be written into a config file and handed to
 * the AWS CLI. Anything but an https URL on an AWS sign-in domain is refused
 * rather than passed along.
 */
export function isValidStartUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:") return false;
  return /(^|\.)awsapps\.com$/.test(parsed.hostname)
    || /(^|\.)signin\.aws$/.test(parsed.hostname)
    || /(^|\.)amazonaws\.com$/.test(parsed.hostname);
}

/** An AWS region, shaped like one. Written into a config file, so checked. */
export function isValidRegion(region: string): boolean {
  return /^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region);
}

/** Twelve digits, and nothing else. */
export function isValidAccountId(id: string): boolean {
  return /^\d{12}$/.test(id);
}

/**
 * A role name as IAM writes them.
 *
 * Deliberately narrower than the config file's own syntax: a value containing a
 * newline or a `[` would not be a broken profile, it would be a *different*
 * profile silently appended to the file.
 */
export function isValidRoleName(name: string): boolean {
  return /^[\w+=,.@-]{1,64}$/.test(name);
}

async function post(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* keep the raw text below */ }
  if (!res.ok) {
    const err: any = new Error(parsed.error_description || parsed.message || text || `HTTP ${res.status}`);
    err.code = parsed.error || parsed.__type?.split("#").pop();
    err.status = res.status;
    throw err;
  }
  return parsed;
}

/**
 * Step one: ask AWS to start an authorization, and get a URL to send them to.
 *
 * The client registration is anonymous and throwaway — it identifies this
 * installation to AWS for the duration of one sign-in and is not stored.
 */
export async function startDeviceAuthorization(
  startUrl: string, ssoRegion: string,
): Promise<DeviceAuthorization> {
  const reg = await post(`${oidc(ssoRegion)}/client/register`, {
    clientName: "github-control-hub",
    clientType: "public",
  });

  const auth = await post(`${oidc(ssoRegion)}/device_authorization`, {
    clientId: reg.clientId,
    clientSecret: reg.clientSecret,
    startUrl,
  });

  return {
    clientId: reg.clientId,
    clientSecret: reg.clientSecret,
    deviceCode: auth.deviceCode,
    verificationUriComplete: auth.verificationUriComplete,
    userCode: auth.userCode,
    // AWS's own floor. A missing interval means poll slowly, not quickly.
    interval: Math.max(1, Number(auth.interval) || 5),
    expiresAt: Date.now() + (Number(auth.expiresIn) || 600) * 1000,
  };
}

/**
 * Step two: has the person approved it yet?
 *
 * Returns null while they have not, which is the ordinary case for the first
 * several calls — this is a person switching to a browser, reading a page and
 * clicking a button. Only a real failure throws.
 */
export async function pollForToken(auth: {
  clientId: string; clientSecret: string; deviceCode: string; ssoRegion: string;
}): Promise<string | null> {
  try {
    const token = await post(`${oidc(auth.ssoRegion)}/token`, {
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      deviceCode: auth.deviceCode,
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
    });
    return token.accessToken ?? null;
  } catch (err: any) {
    // Not yet approved, and being asked to slow down, are both "keep waiting".
    if (KEEP_WAITING.has(err.code)) return null;
    if (EXPIRED.has(err.code)) {
      const expired: any = new Error(
        "That sign-in request expired before it was approved. Start again.");
      expired.expired = true;
      throw expired;
    }
    throw err;
  }
}

async function getJson(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { "x-amz-sso_bearer_token": token } });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).pathname}`);
  return res.json();
}

/**
 * Step three: what can this person actually reach?
 *
 * Every account, and within each the roles they hold. This is the whole reason
 * the flow exists — it is the part somebody cannot answer from memory, and the
 * part they would otherwise have to find in the AWS console and copy by hand.
 *
 * Paged, because an organization with more than a screenful of accounts is
 * exactly the kind that has this problem.
 */
export async function listAccountsAndRoles(
  token: string, ssoRegion: string,
): Promise<SsoAccount[]> {
  const accounts: SsoAccount[] = [];
  let nextToken: string | undefined;

  do {
    const url = new URL(`${portal(ssoRegion)}/assignment/accounts`);
    url.searchParams.set("max_result", "100");
    if (nextToken) url.searchParams.set("next_token", nextToken);
    const page = await getJson(url.toString(), token);

    for (const a of page.accountList ?? []) {
      const roles: string[] = [];
      let roleNext: string | undefined;
      do {
        const rurl = new URL(`${portal(ssoRegion)}/assignment/roles`);
        rurl.searchParams.set("account_id", a.accountId);
        rurl.searchParams.set("max_result", "100");
        if (roleNext) rurl.searchParams.set("next_token", roleNext);
        const rolePage = await getJson(rurl.toString(), token);
        for (const r of rolePage.roleList ?? []) if (r.roleName) roles.push(r.roleName);
        roleNext = rolePage.nextToken;
      } while (roleNext);

      accounts.push({
        accountId: a.accountId,
        accountName: a.accountName ?? a.accountId,
        emailAddress: a.emailAddress,
        roles,
      });
    }
    nextToken = page.nextToken;
  } while (nextToken);

  return accounts;
}

/**
 * The profile, rendered as the AWS CLI expects to read it.
 *
 * Written in the modern `sso-session` form rather than the older one where every
 * profile repeats the start URL. Two profiles for two accounts under the same
 * sign-in then share one session, which is also what makes `aws sso login`
 * authorize both at once.
 */
export function renderProfile(p: {
  profileName: string; sessionName: string; startUrl: string;
  ssoRegion: string; accountId: string; roleName: string; region: string;
}): string {
  return [
    ``,
    `[sso-session ${p.sessionName}]`,
    `sso_start_url = ${p.startUrl}`,
    `sso_region = ${p.ssoRegion}`,
    `sso_registration_scopes = sso:account:access`,
    ``,
    `[profile ${p.profileName}]`,
    `sso_session = ${p.sessionName}`,
    `sso_account_id = ${p.accountId}`,
    `sso_role_name = ${p.roleName}`,
    `region = ${p.region}`,
    ``,
  ].join("\n");
}

/** Whether `~/.aws/config` already defines this profile or session. */
export function alreadyDefined(config: string, header: string): boolean {
  return new RegExp(`^\\s*\\[${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`, "m")
    .test(config);
}

/**
 * Make the AWS SDK re-read `~/.aws/config`.
 *
 * The SDK parses that file once per process and keeps the result in a
 * module-level cache keyed by path — `filePromises` in `@smithy/core/config`.
 * Nothing invalidates it, because nothing normally needs to: a config file is
 * not expected to change underneath a running program.
 *
 * This app changes it. A profile written by the step above lands on disk, the
 * AWS CLI signs in against it perfectly well from its own process, and the
 * running app goes on resolving credentials from a parse taken before the
 * profile existed — so `AWS_PROFILE=<new>` resolves to a profile the SDK
 * believes is not there. That is the whole of the "created it, signed in, and
 * Verify does nothing, but it works after a restart" report: restarting was
 * clearing this cache.
 *
 * One read with `ignoreCache` both re-reads and *replaces* the cached promise,
 * so ordinary cached lookups afterwards see the new content too.
 *
 * Failure is deliberately not fatal. The profile is already written and correct
 * by the time this runs; if the SDK ever moves this module (it has moved once,
 * from `@smithy/shared-ini-file-loader`) the cost is a restart, which is what
 * people did before this existed — not a lost profile.
 */
export async function refreshAwsConfigCache(): Promise<boolean> {
  try {
    const { loadSharedConfigFiles } = await import("@smithy/core/config");
    await loadSharedConfigFiles({ ignoreCache: true });
    return true;
  } catch (err: any) {
    console.warn(
      "[sso] Could not refresh the AWS config cache; a new profile may need an "
      + "app restart to be usable:", err?.message ?? err);
    return false;
  }
}
