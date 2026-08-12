const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

export function getClientId(): string {
  const id = process.env.GITHUB_CLIENT_ID;
  if (!id) throw new Error("GITHUB_CLIENT_ID is required");
  return id;
}

function getClientSecret(): string {
  const secret = process.env.GITHUB_CLIENT_SECRET;
  if (!secret) throw new Error("GITHUB_CLIENT_SECRET is required");
  return secret;
}

/** GitHub usernames: alphanumeric and single hyphens, up to 39 characters. */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * `login` names the account to sign in as.
 *
 * Without it GitHub uses whatever session the browser already holds, which is
 * not necessarily the account this app last used — so a button reading
 * "Continue with alice" could sign you in as bob, silently, because GitHub was
 * never told which was meant. With it, GitHub switches accounts or asks,
 * instead of quietly answering a different question.
 */
export function buildAuthorizationUrl(state: string, login?: string): string {
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: `${process.env.BACKEND_URL || "http://localhost:4000"}/auth/callback`,
    scope: "repo read:org",
    state,
  });
  if (login && LOGIN_RE.test(login)) params.set("login", login);
  return `${GITHUB_AUTH_URL}?${params}`;
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      code,
    }),
  });

  if (!res.ok) throw new Error("Failed to exchange code for token");

  const data = (await res.json()) as { access_token?: string; error?: string };
  if (data.error || !data.access_token) {
    throw new Error(data.error ?? "No access_token in response");
  }

  return data.access_token;
}
