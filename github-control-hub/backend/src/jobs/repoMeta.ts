/**
 * The one definition of what a `repo_meta` row holds.
 *
 * Two jobs write this row: the daily full rebuild and the thirty-minute
 * light pass. Both write it as a **whole item**, because a `PutRequest` in a
 * batch write replaces the row rather than merging into it. That makes the
 * field lists a contract between them rather than two independent lists: any
 * field one writes and the other does not is silently erased on the other's
 * next pass.
 *
 * That is not hypothetical. A field was once added to the full rebuild alone
 * and would have been erased every thirty minutes by the light pass, which
 * writes the same row without it.
 *
 * So both callers build the row here. A field added below is a field both
 * writers keep.
 */

/** Every field a `repo_meta` row carries, from one repository listing entry. */
export function buildRepoMeta(repo: any): Record<string, any> {
  return {
    visibility: repo.visibility ?? (repo.private ? "private" : "public"),
    archived: !!repo.archived,
    fork: !!repo.fork,
    pushedAt: repo.pushed_at ?? null,
    // So a repository nobody has ever pushed to can still be judged against an
    // age. Comes free with the listing.
    createdAt: repo.created_at ?? null,
    defaultBranch: repo.default_branch ?? "main",
    // Every one of these is a control an auditor asks about by name, and
    // "unknown" is not the same answer as "disabled".
    secretScanning: repo.security_and_analysis?.secret_scanning?.status ?? "unknown",
    pushProtection: repo.security_and_analysis?.secret_scanning_push_protection?.status ?? "unknown",
  };
}
