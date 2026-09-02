/**
 * The rows that stand for a repository with no findings.
 *
 * A repository that reports nothing means one of two things, and the table has
 * to be able to tell them apart: Dependabot is switched off, or it is on and
 * the repository is clean. Returning nothing for both made an unwatched
 * repository look like a safe one, which is the answer this screen most needs
 * not to give.
 *
 * Shared, because the tab and the alarm pass both build the same view and a
 * second copy of these would be a second definition of "clean".
 */
export function mockCleanAlert(repoName: string, orgName: string) {
  return {
    id: `clean-${repoName}`,
    repo: repoName,
    org: orgName,
    dependency: "No vulnerabilities found",
    severity: "low",
    cve: "",
    ecosystem: "",
    vulnerable_version: "",
    patched_version: null,
    detected_at: new Date().toISOString(),
    clean: true
  };
}

export function mockDisabledAlert(repoName: string, orgName: string) {
  return {
    id: `disabled-${repoName}`,
    repo: repoName,
    org: orgName,
    dependency: "Dependabot alerts disabled",
    severity: "low",
    cve: "",
    ecosystem: "",
    vulnerable_version: "",
    patched_version: null,
    detected_at: new Date().toISOString(),
    disabled: true
  };
}
