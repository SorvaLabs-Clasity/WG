import type {
  Inventory, ProviderResult, Relationship, Resource, ResourceId,
} from "./awsInventoryService";
import { searchTermsFor } from "./awsInventoryService";

/**
 * What breaks if this is deleted.
 *
 * Two halves, and the second is the one AWS cannot give you:
 *
 *   - **AWS relationships** — the Lambda whose event source is this queue, the
 *     database behind this security group. Authoritative, and it is what is
 *     true right now.
 *   - **Source references** — the Terraform module that declares it, the four
 *     repositories with its ARN in a config file, the deploy script that names
 *     it. This is what tells you *who owns the change* and *what has to be
 *     edited*, which no AWS API knows.
 *
 * A resource with no AWS relationships and eleven source references is not
 * safe to delete; it is a resource whose consumers are wired up in a way AWS
 * cannot see, and deleting it breaks a deploy rather than a runtime.
 */

/** A place in source that names the resource. */
export interface SourceRef {
  repo: string;
  path: string;
  url: string;
  /** `terraform`, `cloudformation`, `cdk`, `kubernetes`, `config`, `code`, `docs`. */
  kind: SourceKind;
  /** Which of the resource's identifiers matched here. */
  term: string;
}

export type SourceKind =
  | "terraform" | "cloudformation" | "cdk" | "kubernetes"
  | "ci" | "config" | "code" | "docs";

/**
 * What a file is, from its path.
 *
 * The kind is what turns a list of hits into a judgement. Ten mentions in
 * markdown is documentation drift; one mention in a Terraform module is the
 * thing that will recreate the resource on the next apply, and one in a deploy
 * pipeline is what breaks at 3am.
 */
export function classifyPath(path: string): SourceKind {
  const p = path.toLowerCase();
  if (/\.tf$|\.tfvars$|\.hcl$/.test(p)) return "terraform";
  if (/(^|\/)(template|cloudformation)[^/]*\.(ya?ml|json)$/.test(p)) return "cloudformation";
  if (/cdk|\bstack\.ts$|-stack\.ts$/.test(p)) return "cdk";
  if (/(^|\/)(k8s|kubernetes|helm|charts)\//.test(p) || /\.(ya?ml)$/.test(p) && /deployment|service|ingress/.test(p)) return "kubernetes";
  if (/(^|\/)\.github\/workflows\//.test(p) || /(buildspec|\.gitlab-ci|jenkinsfile|\.circleci)/.test(p)) return "ci";
  if (/\.(md|mdx|txt|rst adoc)$/.test(p) || /(^|\/)docs?\//.test(p)) return "docs";
  if (/\.(json|ya?ml|toml|ini|env|properties)$/.test(p)) return "config";
  return "code";
}

/**
 * How much a reference of this kind matters when the resource is removed.
 *
 * Ordered by what happens next, not by how "technical" the file is. Something
 * that recreates or reconfigures the resource outranks something that merely
 * mentions it, and documentation outranks nothing at all — it is the reason a
 * runbook sends somebody to a queue that no longer exists.
 */
const KIND_WEIGHT: Record<SourceKind, number> = {
  terraform: 5, cloudformation: 5, cdk: 5,
  ci: 4, kubernetes: 4,
  code: 3, config: 2, docs: 1,
};

/**
 * The weight at which a resource is high risk on source alone.
 *
 * Eight, so that an infrastructure declaration (5) plus any real use of it —
 * application code (3), a pipeline (4), a manifest (4) — reaches it, while an
 * infrastructure declaration on its own does not. That distinction is the whole
 * calibration: nearly every managed resource is declared somewhere, so treating
 * a declaration alone as high would mark the entire account high and the level
 * would stop meaning anything. A declaration *plus* a consumer is a different
 * claim, and it is the one worth stopping for.
 */
const HIGH_WEIGHT = 8;

/** Below this, nothing found is worth more than a glance. */
const MEDIUM_WEIGHT = 4;

/**
 * What an AWS relationship is worth, on the same scale as a source reference.
 *
 * A live event-source mapping alone clears the high threshold, because
 * something is reading from this *right now* and deleting it breaks a running
 * system in seconds rather than on the next deploy. The rest are worth about as
 * much as an infrastructure declaration: real, and not instantaneous.
 */
const REL_WEIGHT: Record<string, number> = {
  "event-source": 10,
  "env-var": 5,
  "execution-role": 5,
  "security-group": 5,
  default: 4,
};

export type RiskLevel = "high" | "medium" | "low" | "unknown";

export interface BlastRadius {
  target: Resource;
  /** AWS things that would break, deduplicated. */
  relationships: Relationship[];
  /** Places in source that name it. */
  sourceRefs: SourceRef[];
  /** Distinct repositories touched. */
  repos: string[];
  /** Repositories whose *infrastructure* declares it. */
  managedBy: string[];
  risk: RiskLevel;
  /** Plain sentences, in the order a person would want to read them. */
  findings: string[];
  /**
   * What could not be read.
   *
   * Non-empty means the answer is incomplete, and the risk is `unknown`
   * whatever the counts say. "Nothing references this" from a failed read is
   * the one wrong answer this feature must never give.
   */
  unread: Array<{ source: string; error: string }>;
}

export interface BlastDeps {
  inventory: Inventory;
  /** AWS-side relationships, already gathered per provider. */
  awsRefs: ProviderResult<Relationship>[];
  /** Source search, one call per identifier. */
  searchSource: (term: string) => Promise<ProviderResult<SourceRef>>;
}

export async function assessBlastRadius(
  target: Resource, deps: BlastDeps,
): Promise<BlastRadius> {
  const unread: Array<{ source: string; error: string }> = [];

  for (const u of deps.inventory.unreadable) {
    unread.push({ source: `AWS ${u.service}`, error: u.error });
  }
  for (const r of deps.awsRefs) {
    if (!r.ok) unread.push({ source: `AWS ${r.service}`, error: r.error ?? "unknown error" });
  }

  // One search per identifier the resource is known by. Deduplicated on
  // repo+path, because the same file naming both the name and the ARN is one
  // place to edit, not two.
  const seen = new Set<string>();
  const sourceRefs: SourceRef[] = [];
  for (const term of searchTermsFor(target)) {
    const result = await deps.searchSource(term);
    if (!result.ok) {
      unread.push({ source: `source search for "${term}"`, error: result.error ?? "unknown error" });
      continue;
    }
    for (const ref of result.items) {
      const key = `${ref.repo}:${ref.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sourceRefs.push(ref);
    }
  }

  const relationships = dedupeRelationships(deps.awsRefs.flatMap(r => r.items));
  const repos = [...new Set(sourceRefs.map(r => r.repo))].sort();
  const managedBy = [...new Set(
    sourceRefs.filter(r => ["terraform", "cloudformation", "cdk"].includes(r.kind)).map(r => r.repo),
  )].sort();

  return {
    target,
    relationships,
    sourceRefs,
    repos,
    managedBy,
    risk: scoreRisk(relationships, sourceRefs, unread),
    findings: describe(target, relationships, sourceRefs, repos, managedBy, unread),
    unread,
  };
}

/** One row per (thing, reason). The same Lambda can depend two ways and both matter. */
export function dedupeRelationships(rels: Relationship[]): Relationship[] {
  const seen = new Set<string>();
  const out: Relationship[] = [];
  for (const r of rels) {
    const key = `${r.from.service}:${r.from.name}:${r.kind}:${r.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.sort((a, b) =>
    a.from.service.localeCompare(b.from.service) || a.from.name.localeCompare(b.from.name));
}

/**
 * The verdict.
 *
 * `unknown` beats everything. A partial read cannot produce "low" — the whole
 * point of the feature is that somebody is about to delete something, and
 * "nothing found" produced by an AccessDenied is the answer that causes the
 * outage this is meant to prevent.
 */
export function scoreRisk(
  relationships: Relationship[], refs: SourceRef[],
  unread: Array<{ source: string; error: string }>,
): RiskLevel {
  if (unread.length > 0) return "unknown";

  // One scale for both halves, so a live consumer and a Terraform file can be
  // weighed against each other rather than short-circuiting past one another.
  //
  // The first version returned high for *any* relationship, which made the
  // rules above it — live consumer, three or more — unreachable. Branches that
  // cannot fire are branches nobody can weaken, and a mutation proved it by
  // deleting the live-consumer rule with every test still passing.
  const weight =
    relationships.reduce((n, r) => n + (REL_WEIGHT[r.kind] ?? REL_WEIGHT.default), 0)
    + refs.reduce((n, r) => n + KIND_WEIGHT[r.kind], 0);

  if (weight >= HIGH_WEIGHT) return "high";
  if (weight >= MEDIUM_WEIGHT) return "medium";
  return "low";
}

function plural(n: number, one: string, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}

function describe(
  target: Resource, rels: Relationship[], refs: SourceRef[],
  repos: string[], managedBy: string[],
  unread: Array<{ source: string; error: string }>,
): string[] {
  const out: string[] = [];

  const consumers = rels.filter(r => r.kind === "event-source");
  if (consumers.length) {
    out.push(`${plural(consumers.length, "Lambda")} consume messages from this right now.`);
  }
  const byKind = new Map<string, number>();
  for (const r of rels) if (r.kind !== "event-source") {
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  }
  for (const [kind, n] of byKind) {
    out.push(`${plural(n, "resource")} reference it by ${kind.replace(/-/g, " ")}.`);
  }

  if (managedBy.length) {
    // The most actionable sentence in the whole report: deleting this by hand
    // does not remove it, it puts the account and the code out of step.
    out.push(
      `Declared as infrastructure in ${managedBy.join(", ")} — deleting it in the console will `
      + `not stick, and the next apply will recreate it or fail.`,
    );
  }

  const other = repos.filter(r => !managedBy.includes(r));
  if (other.length) {
    out.push(`Named in ${plural(other.length, "other repository", "other repositories")}: ${other.join(", ")}.`);
  }

  const ci = refs.filter(r => r.kind === "ci");
  if (ci.length) {
    out.push(`${plural(ci.length, "pipeline")} name it — a delete breaks a deploy, not just a runtime.`);
  }

  if (!rels.length && !refs.length && !unread.length) {
    out.push("Nothing in this account and nothing in your source refers to it.");
  }

  for (const u of unread) {
    out.push(`Could not read ${u.source}: ${u.error}. This report is incomplete.`);
  }
  return out;
}
