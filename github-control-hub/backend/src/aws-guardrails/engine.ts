import { Guardrail, AwsExclusionList, Finding, ResourceSnapshot, AwsAccount, Scope } from "./types";
import { getRuleKind, evaluateResource } from "./catalog";
import { isExcluded } from "./exclusions";
import { COLLECTORS } from "./collectors";
import { remediate, canRemediate } from "./remediators";
import { resolveAccounts, credentialsFor, scopesFor } from "./accounts";

export interface RunOptions {
  /** Limit to these rules. Omitted means every enabled rule. */
  ruleIds?: string[];
  /** Limit to these resource ids. Omitted means everything of the rule's type. */
  resourceIds?: string[];
  /** Limit to these accounts. Omitted means every enabled account. */
  accountIds?: string[];
  /** Evaluate and report without writing, whatever the rule's mode says. */
  dryRun?: boolean;
}

export interface RunResult {
  findings: Finding[];
  remediated: number;
  violations: number;
  excluded: number;
  errors: string[];
  /** Accounts actually visited, so a caller can tell a clean sweep from an empty one. */
  accountsChecked?: { accountId: string; name: string; regions: string[] }[];
  /**
   * Resources in regions nobody added to the account. Not violations and not
   * errors — things that were never looked at, which a compliance report has to
   * say out loud or it is quietly claiming they are fine.
   */
  unswept?: { accountId: string; accountName: string; region: string; count: number }[];
}

export interface RunDeps {
  /** Test seam. Production passes nothing and the real AWS calls are used. */
  collectors?: typeof COLLECTORS;
  remediate?: typeof remediate;
  canRemediate?: typeof canRemediate;
  resolveAccounts?: typeof resolveAccounts;
  credentialsFor?: typeof credentialsFor;
}

/** Does this rule apply to this account? No list means every account. */
export function ruleAppliesTo(rule: Guardrail, accountId: string): boolean {
  return !rule.accounts?.length || rule.accounts.includes(accountId);
}

/**
 * Evaluate rules against live AWS state, remediating where the rule says to.
 *
 * This is the single implementation behind all three triggers — creation event,
 * scheduled sweep, and manual run. They differ only in the options passed in.
 * Keeping one path is deliberate: the GitHub side showed what happens when the
 * automatic and manual routes drift apart.
 *
 * The outer loop is accounts. An account that cannot be reached — a role
 * deleted, a trust policy rewritten — is reported and the sweep carries on:
 * losing sight of dev is not a reason to stop checking prod, and one broken
 * role silently ending every sweep is exactly how a tool comes to report a
 * clean estate it stopped looking at months ago.
 */
export async function run(
  rules: Guardrail[],
  exclusionLists: AwsExclusionList[],
  options: RunOptions = {},
  onActivity?: (entry: {
    ruleId: string; ruleName: string; resourceId: string; description: string;
    accountId: string; accountName: string; region: string;
    failed: boolean; error?: string; undo?: { action: string; params: Record<string, any> };
  }) => Promise<void>,
  deps: RunDeps = {}
): Promise<RunResult> {
  const collectorsFor = deps.collectors ?? COLLECTORS;
  const doRemediate = deps.remediate ?? remediate;
  const isRemediable = deps.canRemediate ?? canRemediate;
  const getAccounts = deps.resolveAccounts ?? resolveAccounts;
  const getCredentials = deps.credentialsFor ?? credentialsFor;

  const result: RunResult = {
    findings: [], remediated: 0, violations: 0, excluded: 0, errors: [],
    accountsChecked: [], unswept: [],
  };

  let accounts: AwsAccount[];
  try {
    accounts = await getAccounts();
  } catch (err: any) {
    result.errors.push(`Could not read the account list: ${err?.message ?? err}`);
    return result;
  }

  const wanted = options.accountIds?.length
    ? accounts.filter(a => options.accountIds!.includes(a.accountId))
    : accounts;

  for (const account of wanted.filter(a => a.enabled)) {
    let credentials;
    try {
      credentials = await getCredentials(account);
    } catch (err: any) {
      // Named, not swallowed: an account silently missing from a compliance
      // report is indistinguishable from an account with nothing wrong in it.
      result.errors.push(`${account.name} (${account.accountId}): ${err?.message ?? err}`);
      continue;
    }

    const regions = scopesFor([account]).map(s => s.region);
    result.accountsChecked!.push({ accountId: account.accountId, name: account.name, regions });

    for (const region of regions) {
      const scope: Scope = {
        accountId: account.accountId, accountName: account.name, region, credentials,
      };
      await runScope(scope, account, rules, exclusionLists, options, result, onActivity, {
        collectorsFor, doRemediate, isRemediable,
      });
    }
  }

  return result;
}

async function runScope(
  scope: Scope,
  account: AwsAccount,
  rules: Guardrail[],
  exclusionLists: AwsExclusionList[],
  options: RunOptions,
  result: RunResult,
  onActivity: Parameters<typeof run>[3],
  impl: {
    collectorsFor: typeof COLLECTORS;
    doRemediate: typeof remediate;
    isRemediable: typeof canRemediate;
  },
): Promise<void> {
  const where = `${account.name} (${scope.region})`;

  const active = rules.filter(r =>
    r.enabled &&
    (!options.ruleIds?.length || options.ruleIds.includes(r.id)) &&
    ruleAppliesTo(r, account.accountId)
  );
  if (active.length === 0) return;

  // One collect per resource type, shared by every rule of that type — otherwise
  // eight S3 rules would mean eight full passes over every bucket. Scoped to
  // this account and region, since a snapshot from one says nothing about another.
  const snapshots = new Map<string, ResourceSnapshot[]>();

  for (const rule of active) {
    const kind = getRuleKind(rule.kind);
    if (!kind) {
      result.errors.push(`Rule "${rule.name}" has unknown kind "${rule.kind}"`);
      continue;
    }

    if (!snapshots.has(kind.resourceType)) {
      const collector = impl.collectorsFor[kind.resourceType];
      if (!collector) {
        result.errors.push(`No collector for resource type "${kind.resourceType}"`);
        snapshots.set(kind.resourceType, []);
      } else {
        try {
          const collected = await collector(scope, options.resourceIds);
          snapshots.set(kind.resourceType, collected.resources);
          for (const u of collected.unswept ?? []) {
            // A collector reports everything outside the region it was asked
            // about. Regions the account already sweeps are not blind spots —
            // their own pass covers them.
            if (account.regions.includes(u.region)) continue;
            const already = result.unswept!.find(x =>
              x.accountId === scope.accountId && x.region === u.region);
            if (already) already.count = Math.max(already.count, u.count);
            else result.unswept!.push({
              accountId: scope.accountId, accountName: scope.accountName,
              region: u.region, count: u.count,
            });
          }
        } catch (err: any) {
          result.errors.push(`${where}: collecting ${kind.resourceType}: ${err?.message ?? err}`);
          snapshots.set(kind.resourceType, []);
        }
      }
    }

    const lists = exclusionLists.filter(l => rule.exclusionLists?.includes(l.id));
    const resources = snapshots.get(kind.resourceType) ?? [];
    const stamp = {
      region: scope.region, accountId: scope.accountId, accountName: scope.accountName,
    };

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
          excluded: true, excludedBy: exclusion.reason, remediated: false, checkedAt, ...stamp,
        });
        continue;
      }

      const evaluation = evaluateResource(rule.kind, resource, rule.params ?? {});
      const finding: Finding = {
        ruleId: rule.id, ruleName: rule.name, kind: rule.kind,
        resourceId: resource.id, resourceType: resource.type,
        verdict: evaluation.verdict, summary: evaluation.summary,
        ...(evaluation.fix && { proposedFix: evaluation.fix.description }),
        excluded: false, remediated: false, checkedAt, ...stamp,
      };

      if (evaluation.verdict !== "violation") {
        result.findings.push(finding);
        continue;
      }

      result.violations++;

      const shouldFix = rule.mode === "enforce" && !options.dryRun && impl.isRemediable(rule.kind);
      if (!shouldFix) {
        result.findings.push(finding);
        continue;
      }

      try {
        const outcome = await impl.doRemediate(rule.kind, resource, rule.params ?? {}, scope);
        finding.remediated = outcome.changed;
        finding.summary = outcome.changed ? outcome.description : finding.summary;
        if (outcome.changed) {
          result.remediated++;
          await onActivity?.({
            ruleId: rule.id, ruleName: rule.name, resourceId: resource.id,
            description: outcome.description, failed: false, undo: outcome.undo, ...stamp,
          });
        }
      } catch (err: any) {
        const message = err?.message ?? String(err);
        finding.error = message;
        result.errors.push(`${where} [${resource.id}] ${rule.name}: ${message}`);
        await onActivity?.({
          ruleId: rule.id, ruleName: rule.name, resourceId: resource.id,
          description: `Failed to remediate ${resource.id} for "${rule.name}"`,
          failed: true, error: message, ...stamp,
        });
      }

      result.findings.push(finding);
    }
  }
}
