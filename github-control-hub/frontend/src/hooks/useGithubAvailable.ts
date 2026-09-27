import { useQuery } from "@tanstack/react-query";
import { fetchAuthStatus } from "../api/auth";

/**
 * Whether this account has GitHub at all: true, false, or undefined while the
 * answer is still coming.
 *
 * The same query, under the same key, the section line and Activity already
 * read, so asking here costs nothing. Things that only exist on the GitHub
 * half — the organization's settings, webhook health, the pull request warm-up
 * — wait for a yes: fetched on an AWS-only account they were each a refusal,
 * on every page, for a half of the app that account does not have.
 */
export function useGithubAvailable(): boolean | undefined {
  const { data } = useQuery({ queryKey: ["auth", "status"], queryFn: fetchAuthStatus, staleTime: 60_000 });
  if (!data) return undefined;
  return data.githubAccess?.allowed !== false;
}
