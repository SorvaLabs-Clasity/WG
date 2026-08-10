import { Guardrail, AwsExclusionList, Finding, ResourceSnapshot } from "./types";
import { getRuleKind, evaluateResource } from "./catalog";
import { isExcluded } from "./exclusions";
import { COLLECTORS } from "./collectors";
import { remediate, canRemediate } from "./remediators";

export interface RunOptions {
  /** Limit to these rules. Omitted means every enabled rule. */
  ruleIds?: string[];
  /** Limit to these resource ids. Omitted means everything of the rule's type. */
  resourceIds?: string[];
  /** Evaluate and report without writing, whatever the rule's mode says. */
  dryRun?: boolean;
}

export interface RunResult {
  findings: Finding[];
  remediated: number;
  violations: number;
  excluded: number;
  errors: string[];
}

export interface RunDeps {
  /** Test seam. Production passes nothing and the real AWS calls are used. */
  collectors?: typeof COLLECTORS;
  remediate?: typeof remediate;
  canRemediate?: typeof canRemediate;
}

/**
 * Evaluate rules against live AWS state, remediating where the rule says to.
 *
 * This is the single implementation behind all three triggers — creation event,
 * scheduled sweep, and manual run. They differ only in the options passed in.
 * Keeping one path is deliberate: the GitHub side showed what happens when the
 * automatic and manual routes drift apart.
 */
export async function run(
  rules: Guardrail[],
  exclusionLists: AwsExclusionList[],
  options: RunOptions = {},
  onActivity?: (entry: {
    ruleId: string; ruleName: string; resourceId: string; description: string;
    failed: boolean; error?: string; undo?: { action: string; params: Record<string, any> };
  }) => Promise<void>,
  deps: RunDeps = {}
): Promise<RunResult> {
  const collectorsFor = deps.collectors ?? COLLECTORS;
  const doRemediate = deps.remediate ?? remediate;
  const isRemediable = deps.canRemediate ?? canRemediate;
  const result: RunResult = { findings: [], remediated: 0, violations: 0, excluded: 0, errors: [] };

  const active = rules.filter(r =>
    r.enabled && (!options.ruleIds?.length || options.ruleIds.includes(r.id))
  );

  // One collect per resource type, shared by every rule of that type — otherwise
  // eight S3 rules would mean eight full passes over every bucket.
  const snapshots = new Map<string, ResourceSnapshot[]>();

  for (const rule of active) {
    const kind = getRuleKind(rule.kind);
    if (!kind) {
      result.errors.push(`Rule "${rule.name}" has unknown kind "${rule.kind}"`);
      continue;
    }

    if (!snapshots.has(kind.resourceType)) {
      const collector = collectorsFor[kind.resourceType];
      if (!collector) {
        result.errors.push(`No collector for resource type "${kind.resourceType}"`);
        snapshots.set(kind.resourceType, []);
      } else {
        try {
          snapshots.set(kind.resourceType, await collector(options.resourceIds));
        } catch (err: any) {
          result.errors.push(`Collecting ${kind.resourceType}: ${err?.message ?? err}`);
          snapshots.set(kind.resourceType, []);
        }
      }
    }

    const lists = exclusionLists.filter(l => rule.exclusionLists?.includes(l.id));
    const resources = snapshots.get(kind.resourceType) ?? [];

    for (const resource of resources) {
      if (options.resourceIds?.length && !options.resourceIds.includes(resource.id)) continue;

      const checkedAt = new Date().toISOString();
      const exclusion = isExcluded(resource, lists);
      if (exclusion.excluded) {
        result.excluded++;
        result.findings.push({
          ruleId: rule.id, ruleName: rule.name, kind: rule.kind,
          resourceId: resource.id, resourceType: resource.type,
          verdict: "not_applicable", summary: `Excluded — ${exclusion.reason}`,
          excluded: true, excludedBy: exclusion.reason, remediated: false, checkedAt,
        });
        continue;
      }

      const evaluation = evaluateResource(rule.kind, resource, rule.params ?? {});
      const finding: Finding = {
        ruleId: rule.id, ruleName: rule.name, kind: rule.kind,
        resourceId: resource.id, resourceType: resource.type,
        verdict: evaluation.verdict, summary: evaluation.summary,
        excluded: false, remediated: false, checkedAt,
      };

      if (evaluation.verdict !== "violation") {
        result.findings.push(finding);
        continue;
      }

      result.violations++;

      const shouldFix = rule.mode === "enforce" && !options.dryRun && isRemediable(rule.kind);
      if (!shouldFix) {
        result.findings.push(finding);
        continue;
      }

      try {
        const outcome = await doRemediate(rule.kind, resource, rule.params ?? {});
        finding.remediated = outcome.changed;
        finding.summary = outcome.changed ? outcome.description : finding.summary;
        if (outcome.changed) {
          result.remediated++;
          await onActivity?.({
            ruleId: rule.id, ruleName: rule.name, resourceId: resource.id,
            description: outcome.description, failed: false, undo: outcome.undo,
          });
        }
      } catch (err: any) {
        const message = err?.message ?? String(err);
        finding.error = message;
        result.errors.push(`[${resource.id}] ${rule.name}: ${message}`);
        await onActivity?.({
          ruleId: rule.id, ruleName: rule.name, resourceId: resource.id,
          description: `Failed to remediate ${resource.id} for "${rule.name}"`,
          failed: true, error: message,
        });
      }

      result.findings.push(finding);
    }
  }

  return result;
}
