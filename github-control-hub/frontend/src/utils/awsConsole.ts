/**
 * Deep links into the AWS console.
 *
 * Every guardrail finding names a real resource, and the next thing anyone
 * wants is to look at it. Built from the resource type and id rather than
 * stored, so a new rule kind only needs an entry here.
 */

/**
 * Used only when a finding carries no region of its own. Every other
 * "us-east-1" in this codebase is a fallback for AWS_REGION; this one built
 * links to the wrong console entirely in another region.
 */
const DEFAULT_REGION: string =
  (import.meta.env.VITE_AWS_REGION as string | undefined) || "us-east-1";

/**
 * CloudWatch's console encodes log group names twice — a `/` becomes `$252F`,
 * not `%2F`. Getting this wrong lands you on an empty page rather than an
 * obvious error, which is worse.
 */
function cloudwatchSegment(name: string): string {
  return encodeURIComponent(name).replace(/%/g, "$25");
}

export function awsConsoleUrl(resourceType: string | undefined, resourceId: string, region?: string): string | null {
  const r = region || DEFAULT_REGION;
  const id = resourceId;

  switch (resourceType) {
    case "s3:bucket":
      return `https://s3.console.aws.amazon.com/s3/buckets/${encodeURIComponent(id)}?region=${r}&tab=permissions`;

    case "logs:log-group":
      return `https://${r}.console.aws.amazon.com/cloudwatch/home?region=${r}#logsV2:log-groups/log-group/${cloudwatchSegment(id)}`;

    default:
      return null;
  }
}

/** What the link should say — "the bucket", "the log group", and so on. */
export function consoleLinkLabel(resourceType: string | undefined): string {
  switch (resourceType) {
    case "s3:bucket": return "Open bucket";
    case "logs:log-group": return "Open log group";
    default: return "Open in AWS";
  }
}
