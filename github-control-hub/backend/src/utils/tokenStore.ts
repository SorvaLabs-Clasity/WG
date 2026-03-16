/**
 * Server-side store for GitHub access tokens.
 * Tokens are keyed by githubId and never sent to the client (kept out of JWTs).
 */
const tokens = new Map<number, string>();

export function storeToken(githubId: number, accessToken: string): void {
  tokens.set(githubId, accessToken);
}

export function getToken(githubId: number): string | undefined {
  return tokens.get(githubId);
}

export function removeToken(githubId: number): void {
  tokens.delete(githubId);
}
