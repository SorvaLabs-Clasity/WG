/**
 * Deep links into the AWS console.
 *
 * Every guardrail finding names a real resource, and the next thing anyone
 * wants is to look at it. Built from the resource type and id rather than
 * stored, so a new rule kind only needs an entry here.
 */

/**
 * Set at build time by the migration script, from the region that install
 * actually uses. Empty when nothing said.
 *
 * It used to fall back to "us-east-1", which for a link is worse than useless:
 * the console opens, in the wrong region, showing nothing — and reads as the
 * resource having been deleted. Findings carry their own region now, so this
 * is only reached by something that has none, and the honest answer there is
 * no link at all.
 */
const DEFAULT_REGION: string =
  (import.meta.env.VITE_AWS_REGION as string | undefined) || "";

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
  // No region, no link. The caller renders nothing when this is null, which is
  // better than a link somewhere the resource is not.
  if (!r) return null;
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
