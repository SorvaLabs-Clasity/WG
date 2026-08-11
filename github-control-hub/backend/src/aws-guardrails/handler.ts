import { run, RunOptions, RunResult } from "./engine";
import { listGuardrails, listAwsExclusions, putFindings } from "./store";
import { kindsForEvent } from "./catalog";

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
  dryRun?: boolean;
}

interface EventBridgeEvent {
  source?: string;
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
    options = { ruleIds: event.ruleIds, resourceIds: event.resourceIds, dryRun: event.dryRun };
  } else if (event?.detail?.eventName) {
    const eventName = event.detail.eventName;
    const kinds = kindsForEvent(eventName);
    const resourceId = resourceIdFromEvent(event);

    if (kinds.length === 0) {
      return { trigger: `ignored:${eventName}`, findings: [], remediated: 0, violations: 0, excluded: 0, errors: [] };
    }

    trigger = `event:${eventName}`;
    const wanted = new Set(kinds.map(k => k.kind));
    options = {
      ruleIds: rules.filter(r => wanted.has(r.kind) && r.applyOnCreate).map(r => r.id),
      // Without an id we still run the rule, just across everything of that type.
      resourceIds: resourceId ? [resourceId] : undefined,
    };

    if (options.ruleIds?.length === 0) {
      return { trigger: `no-rules:${eventName}`, findings: [], remediated: 0, violations: 0, excluded: 0, errors: [] };
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
  }

  console.log(`[guardrails] trigger=${trigger} checked=${result.findings.length} violations=${result.violations} remediated=${result.remediated} excluded=${result.excluded} errors=${result.errors.length}`);
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

const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE || `${process.env.STACK_NAME || "github-control-hub"}-activity`;

async function writeActivity(entry: {
  ruleId: string; ruleName: string; resourceId: string; description: string;
  failed: boolean; error?: string; undo?: { action: string; params: Record<string, any> };
}): Promise<void> {
  try {
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient, PutCommand } = await import("@aws-sdk/lib-dynamodb");
    const client = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" }),
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
        actor: "system (aws guardrail)",
        repo: entry.resourceId,
        target: entry.ruleName,
        details: entry.description,
        timestamp,
        ...(entry.failed && { failed: true }),
        ...(entry.error && { errorMessage: entry.error }),
        ...(entry.undo && { undoPayload: entry.undo }),
      },
    }));
  } catch (err: any) {
    // Never let activity logging sink a remediation that already succeeded.
    console.warn(`[guardrails] activity write failed: ${err?.message ?? err}`);
  }
}
