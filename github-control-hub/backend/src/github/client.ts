import { Octokit } from "octokit";

export function createOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}

export function getOrg(): string {
  const org = process.env.GITHUB_ORG;
  if (!org) throw new Error("GITHUB_ORG environment variable is required");
  return org;
}
