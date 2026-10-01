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

/**
 * The organization's name, for building GitHub links.
 *
 * From the same status answer as above, which needs no permission. My work,
 * Overview and the Renovate panel read it from the organization's settings
 * instead, which need `org.config.read` — so a person given any of those
 * screens without that permission collected a refusal on every load, for a
 * name that is not a secret.
 */
export function useOrgName(): string {
  const { data } = useQuery({ queryKey: ["auth", "status"], queryFn: fetchAuthStatus, staleTime: 60_000 });
  return data?.github?.org ?? "";
}
