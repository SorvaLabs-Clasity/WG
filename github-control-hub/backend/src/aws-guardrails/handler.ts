import { run, RunOptions, RunResult } from "./engine";
import { listGuardrails, listAwsExclusions, putFindings, dropLegacyFindings } from "./store";
import { kindsForEvent } from "./catalog";
import { awsRegion } from "../utils/region";

/**
 * Lambda entry point. One handler behind all three triggers:
 *
 *   - EventBridge, on a CloudTrail creation event  -> narrow run for that resource
 *   - EventBridge, on a schedule                   -> full sweep
 *   - direct invoke from the app                   -> whatever the caller asked for
 *
 * They differ only in the RunOptions built here. Sharing one path is the point:
 * a manual run and an automatic one must never behave differently.
 */

interface DirectInvoke {
  source: "manual";
  ruleIds?: string[];
  resourceIds?: string[];
  accountIds?: string[];
  dryRun?: boolean;
}

interface EventBridgeEvent {
  source?: string;
  /** The account the event happened in. Present on every CloudTrail event. */
  account?: string;
  region?: string;
  "detail-type"?: string;
  detail?: {
    eventName?: string;
    requestParameters?: Record<string, any>;
    responseElements?: Record<string, any>;
  };
}

type Incoming = DirectInvoke | EventBridgeEvent;

export async function handler(event: Incoming): Promise<RunResult & { trigger: string }> {
  const [rules, exclusions] = await Promise.all([listGuardrails(), listAwsExclusions()]);

  let options: RunOptions = {};
  let trigger = "sweep";

  if (isDirect(event)) {
    trigger = "manual";
    options = {
      ruleIds: event.ruleIds, resourceIds: event.resourceIds,
      accountIds: event.accountIds, dryRun: event.dryRun,
    };
  } else if (event?.detail?.eventName) {
    const eventName = event.detail.eventName;
    const kinds = kindsForEvent(eventName);
    const resourceId = resourceIdFromEvent(event);

    if (kinds.length === 0) {
      return { trigger: `ignored:${eventName}`, findings: [], remediated: 0, violations: 0, excluded: 0, errors: [], accountsChecked: [] };
    }

    trigger = `event:${eventName}`;
    const wanted = new Set(kinds.map(k => k.kind));
    options = {
      ruleIds: rules.filter(r => wanted.has(r.kind) && r.applyOnCreate).map(r => r.id),
      // Without an id we still run the rule, just across everything of that type.
      resourceIds: resourceId ? [resourceId] : undefined,
      // One bucket changed in one account. Sweeping the whole estate to check
      // it would turn a routine PutBucketPolicy into a full multi-account pass,
      // and every remediation we perform fires one of these events itself.
      accountIds: event.account ? [event.account] : undefined,
    };

    if (options.ruleIds?.length === 0) {
      return { trigger: `no-rules:${eventName}`, findings: [], remediated: 0, violations: 0, excluded: 0, errors: [], accountsChecked: [] };
    }
  }

  const result = await run(rules, exclusions, options, async (entry) => {
    // Activity rows are written by the app's own table, shared with the GitHub
    // side so one feed covers both.
    await writeActivity(entry);
  });

  // A dry run must not overwrite stored findings with hypothetical ones.
  if (!options.dryRun) {
    await putFindings(result.findings);
    // Only after a full sweep: a narrow run has not rewritten the rows it would
    // be deleting, so doing this there would erase findings and replace them
    // with nothing.
    if (trigger === "sweep") {
      const dropped = await dropLegacyFindings();
      if (dropped) console.log(`[guardrails] removed ${dropped} findings from before accounts existed`);
    }
  }

  const where = (result.accountsChecked ?? []).map(a => `${a.name}:${a.regions.join("/")}`).join(",") || "none";
  console.log(`[guardrails] trigger=${trigger} accounts=${where} checked=${result.findings.length} violations=${result.violations} remediated=${result.remediated} excluded=${result.excluded} errors=${result.errors.length}`);
  return { ...result, trigger };
}

function isDirect(e: Incoming): e is DirectInvoke {
  return (e as DirectInvoke)?.source === "manual";
}

/** Pull the affected resource's identifier out of a CloudTrail event. */
function resourceIdFromEvent(event: EventBridgeEvent): string | undefined {
  const rp = event.detail?.requestParameters ?? {};
  return (
    rp.bucketName ||  // Create/Put/DeleteBucketPolicy
    rp.logGroupName   // Create/Put/DeleteRetentionPolicy
  );
}

/** Kept in step with ACTIVITY_RETENTION_MONTHS in services/activityService.ts. */
const RETENTION_MONTHS = Number(process.env.ACTIVITY_RETENTION_MONTHS) || 13;

function expiryFor(iso: string): number {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + RETENTION_MONTHS);
  return Math.floor(d.getTime() / 1000);
}

const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE || `${process.env.STACK_NAME || "github-control-hub"}-activity`;

async function writeActivity(entry: {
  ruleId: string; ruleName: string; resourceId: string; description: string;
  accountId: string; accountName: string; region: string;
  failed: boolean; error?: string; undo?: { action: string; params: Record<string, any> };
}): Promise<void> {
  try {
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient, PutCommand } = await import("@aws-sdk/lib-dynamodb");
    const client = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: awsRegion() }),
      { marshallOptions: { removeUndefinedValues: true } }
    );
    const timestamp = new Date().toISOString();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await client.send(new PutCommand({
      TableName: ACTIVITY_TABLE,
      Item: {
        pk: "ACTIVITY",
        sk: `${timestamp}#${id}`,
        id,
        source: "app",
        action: "aws.guardrail",
        // The account is in the actor rather than a new column: the feed is
        // shared with the GitHub side, and "which account" is only meaningful
        // on these rows.
        actor: `system (aws guardrail, ${entry.accountName})`,
        repo: entry.resourceId,
        target: entry.ruleName,
        details: `${entry.description} — ${entry.accountName} (${entry.accountId}), ${entry.region}`,
        timestamp,
        ...(entry.failed && { failed: true }),
        ...(entry.error && { errorMessage: entry.error }),
        ...(entry.undo && { undoPayload: entry.undo }),
        // Same retention as rows the app writes. Inlined rather than imported
        // because this file is bundled into the Lambda on its own, and a row
        // without the stamp is a row that never expires.
        ttl: expiryFor(timestamp),
      },
    }));
  } catch (err: any) {
    // Never let activity logging sink a remediation that already succeeded.
    console.warn(`[guardrails] activity write failed: ${err?.message ?? err}`);
  }
}
