/**
 * Deep links into the AWS console.
 *
 * Every guardrail finding names a real resource, and the next thing anyone
 * wants is to look at it. Built from the resource type and id rather than
 * stored, so a new rule kind only needs an entry here.
 */

const DEFAULT_REGION = "us-east-1";

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

    case "ec2:security-group":
      return `https://${r}.console.aws.amazon.com/ec2/home?region=${r}#SecurityGroup:groupId=${encodeURIComponent(id)}`;

    case "ec2:instance":
      return `https://${r}.console.aws.amazon.com/ec2/home?region=${r}#InstanceDetails:instanceId=${encodeURIComponent(id)}`;

    case "rds:db-instance":
      return `https://${r}.console.aws.amazon.com/rds/home?region=${r}#database:id=${encodeURIComponent(id)};is-cluster=false`;

    // Account-level settings — the "resource" is a page, not an object.
    case "ec2:account":
      return `https://${r}.console.aws.amazon.com/ec2/home?region=${r}#Settings:tab=dataProtectionAndSecurity`;

    case "iam:account":
      return "https://us-east-1.console.aws.amazon.com/iam/home#/account_settings";

    case "cloudtrail:account":
      return `https://${r}.console.aws.amazon.com/cloudtrailv2/home?region=${r}#/trails`;

    default:
      return null;
  }
}

/** What the link should say — "the bucket", "the log group", and so on. */
export function consoleLinkLabel(resourceType: string | undefined): string {
  switch (resourceType) {
    case "s3:bucket": return "Open bucket";
    case "logs:log-group": return "Open log group";
    case "ec2:security-group": return "Open security group";
    case "ec2:instance": return "Open instance";
    case "rds:db-instance": return "Open database";
    case "ec2:account": return "Open EC2 settings";
    case "iam:account": return "Open IAM settings";
    case "cloudtrail:account": return "Open CloudTrail";
    default: return "Open in AWS";
  }
}
