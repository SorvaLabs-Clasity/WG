import { rankExperts, type ExpertRow, type Contribution } from "./expertiseService";
import type { SourceRef } from "./blastRadiusService";

/**
 * Who has actually worked on an AWS resource.
 *
 * Not who has permission to touch it, and not who is on the team that owns the
 * account — who has edited the files that define and use it. That is a
 * different and much more useful set of people at three in the morning.
 *
 * The blast radius already found where a resource is named. This reads the
 * commit history of exactly those files, which is why it costs no code search
 * of its own: the expensive half was already paid for.
 *
 * ## Why the file, not the repository
 *
 * Ranking by repository would credit everybody who has ever committed to the
 * monorepo. The person who wrote `terraform/sqs.tf` is the answer; the person
 * who changed a stylesheet in the same repository is not, and burying the first
 * under fifty of the second is the same as not answering.
 */

export interface ResourceExpert extends ExpertRow {
  /** The files this person actually touched, so the ranking can be checked. */
  files: Array<{ repo: string; path: string; kind: SourceRef["kind"] }>;
}

export interface ResourceExpertsDeps {
  /** Commits touching one path in one repository. */
  listCommits: (repo: string, path: string) => Promise<Array<{ login?: string; at?: string }>>;
}

/**
 * How many referencing files to read history for.
 *
 * Each is one GitHub request against the core allowance — plentiful, but a
 * resource named in ninety files would spend ninety of them for an answer the
 * first dozen already gave. Ordered by what the file *is* before it is cut, so
 * the twelve read are the twelve that matter.
 */
export const MAX_FILES_READ = 12;

/**
 * Which files are worth reading history for, most telling first.
 *
 * Whoever wrote the Terraform that declares a resource knows more about it than
 * whoever imported its name into a service, who in turn knows more than
 * whoever mentioned it in a runbook. When the cap bites, it should bite the
 * bottom of that list.
 */
const KIND_RANK: Record<SourceRef["kind"], number> = {
  terraform: 0, cloudformation: 0, cdk: 0,
  ci: 1, kubernetes: 1,
  code: 2, config: 3, docs: 4,
};

export function rankFilesToRead(refs: SourceRef[]): SourceRef[] {
  return [...refs]
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]
      || a.repo.localeCompare(b.repo)
      || a.path.localeCompare(b.path))
    .slice(0, MAX_FILES_READ);
}

export interface ResourceExpertsResult {
  experts: ResourceExpert[];
  /** Files whose history was read, so the answer can be checked. */
  filesRead: Array<{ repo: string; path: string; kind: SourceRef["kind"] }>;
  /** Files that reference the resource but were not read, because of the cap. */
  filesSkipped: number;
  /**
   * Files whose history could not be read.
   *
   * Reported rather than dropped, for the same reason as everywhere else in
   * this feature: a shorter list of people looks exactly like a smaller set of
   * people, and here it would send somebody to the wrong person.
   */
  degraded: Array<{ repo: string; path: string; error: string }>;
}

export async function expertsForResource(
  refs: SourceRef[], deps: ResourceExpertsDeps, now = Date.now(),
): Promise<ResourceExpertsResult> {
  const toRead = rankFilesToRead(refs);
  const degraded: ResourceExpertsResult["degraded"] = [];

  // Who touched which file, kept alongside the contributions so the answer can
  // show its working. A name with no evidence is a name nobody acts on.
  const filesByLogin = new Map<string, ResourceExpert["files"]>();
  const contributions: Contribution[] = [];

  const perFile = await Promise.all(toRead.map(async ref => {
    try {
      return { ref, commits: await deps.listCommits(ref.repo, ref.path) };
    } catch (err: any) {
      degraded.push({
        repo: ref.repo, path: ref.path,
        error: (err?.message ?? "could not read history").slice(0, 120),
      });
      return { ref, commits: [] };
    }
  }));

  for (const { ref, commits } of perFile) {
    for (const c of commits) {
      if (!c.login || !c.at) continue;
      contributions.push({ login: c.login, signal: "commit", at: c.at });
      const list = filesByLogin.get(c.login) ?? [];
      // One row per file per person, however many times they touched it — the
      // count is already in `commits`, and repeating the path adds nothing.
      if (!list.some(f => f.repo === ref.repo && f.path === ref.path)) {
        list.push({ repo: ref.repo, path: ref.path, kind: ref.kind });
        filesByLogin.set(c.login, list);
      }
    }
  }

  const experts = rankExperts(contributions, now).map(e => ({
    ...e,
    files: filesByLogin.get(e.login) ?? [],
  }));

  return {
    experts,
    filesRead: toRead.map(r => ({ repo: r.repo, path: r.path, kind: r.kind })),
    filesSkipped: Math.max(0, refs.length - toRead.length),
    degraded,
  };
}
