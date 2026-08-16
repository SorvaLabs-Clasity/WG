/**
 * What exists in this AWS account, and what points at what.
 *
 * Read with the **operator's own credentials**, on demand, in the desktop
 * process. Not the guardrail role, not a Lambda, not a cross-account assume:
 * somebody signed in with permission to see a queue is exactly the person
 * asking whether deleting it is safe, and reading as them means this feature
 * needs no new grant and no approval from anybody.
 *
 * Every call below is a `List*` or `Describe*`, which AWS does not charge for.
 * The whole feature's marginal AWS bill is zero.
 *
 * ## The property that matters more than any other
 *
 * **A service that cannot be read is `unknown`, never zero.**
 *
 * The question this answers is "what breaks if I delete this". An answer of
 * "nothing references it" produced by an AccessDenied is not a smaller answer,
 * it is a wrong one — and it is wrong in the direction that deletes production.
 * Every provider therefore reports read failure as a first-class outcome, and
 * the assembled verdict refuses to call anything low-risk while any provider is
 * unread.
 */

/** Where a resource lives, in the only two coordinates that matter here. */
export interface ResourceId {
  /** `sqs`, `lambda`, `s3`, … — the AWS service, lower case. */
  service: string;
  /** The name a person would type. Not the ARN. */
  name: string;
  /** Full ARN when the API gives one; some resources have none. */
  arn?: string;
  region?: string;
}

export interface Resource extends ResourceId {
  /** Anything worth showing without a second call. */
  detail?: Record<string, unknown>;
  /**
   * Other things this resource is known by, and searchable as.
   *
   * A security group's name is `default` and nobody ever refers to it that
   * way — they have `sg-0d311ce245b2a84a4`, out of a console URL or an error
   * message. Searching only the name meant pasting the id found nothing, which
   * reads as the resource not existing.
   */
  ids?: string[];
}

/**
 * One thing pointing at another.
 *
 * Directional on purpose: an event-source mapping means the Lambda depends on
 * the queue, and deleting the queue breaks the Lambda rather than the reverse.
 * A blast radius that loses the direction cannot tell "this will break" from
 * "this will be orphaned".
 */
export interface Relationship {
  /** The thing that would break. */
  from: ResourceId;
  /** Where to go and look at it. Null when it cannot be built truthfully. */
  fromUrl?: string | null;
  /** The thing being asked about. */
  to: ResourceId;
  /** `event-source`, `iam-policy`, `env-var`, `subscription`, … */
  kind: string;
  /** One line, for the row in the UI. */
  detail: string;
}

/**
 * What a provider managed to read.
 *
 * `ok: false` is not an empty result. It carries why, so the UI can say
 * "Lambda could not be read — your credentials lack lambda:ListFunctions"
 * rather than implying nothing was found.
 */
export interface ProviderResult<T> {
  ok: boolean;
  service: string;
  items: T[];
  error?: string;
}

export interface Provider {
  service: string;
  /** Everything of this kind in the account. */
  list(): Promise<ProviderResult<Resource>>;
  /**
   * Which of this service's resources point at `target`.
   *
   * Given the whole inventory so a provider can answer without re-listing —
   * finding the Lambdas that consume a queue needs the Lambda list, and making
   * each provider fetch it again would multiply the calls by the number of
   * services asked.
   */
  referencesTo?(target: ResourceId, inventory: Inventory): Promise<ProviderResult<Relationship>>;
}

export interface Inventory {
  /** service -> what was read, including failures. */
  byService: Map<string, ProviderResult<Resource>>;
  /** Every resource successfully read, flattened. */
  all: Resource[];
  /** Services that could not be read at all. */
  unreadable: Array<{ service: string; error: string }>;
}

/** An error a caller can act on, rather than a stack trace. */
export function describeAwsError(err: any): string {
  const name = err?.name ?? err?.Code ?? "";
  const message = err?.message ?? String(err);
  if (/AccessDenied|UnauthorizedOperation|not authorized/i.test(name + message)) {
    // The single most likely failure, and the one with a concrete fix.
    //
    // AWS words this as "is not authorized to perform: lambda:ListFunctions".
    // The first version of this looked for "performing:", which never appears,
    // so every denial fell through to the generic sentence and the one useful
    // detail — the action to grant — was thrown away.
    const action = /to perform:?\s*([a-z0-9-]+:[A-Za-z*]+)/i.exec(message)?.[1]
      ?? /\b([a-z0-9-]+:[A-Z][A-Za-z]*)\b/.exec(message)?.[1];
    return action
      ? `Your AWS credentials are not allowed to call ${action}`
      : "Your AWS credentials are not allowed to read this service";
  }
  if (/ExpiredToken|InvalidClientTokenId|credentials/i.test(name + message)) {
    return "Your AWS session has expired — sign in again";
  }
  if (/Throttl|TooManyRequests|Rate exceeded/i.test(name + message)) {
    return "AWS is rate limiting this account; try again shortly";
  }
  if (/OptInRequired|not subscribed|region/i.test(name + message)) {
    return "This service is not enabled in this region";
  }
  return message.slice(0, 200);
}

/**
 * Run a provider's read, turning any throw into a reported failure.
 *
 * Deliberately not a try/catch at each call site: one forgotten catch is one
 * service that reports zero when it meant "I could not look", which is the
 * failure this whole module is shaped around.
 */
export async function readProvider<T>(
  service: string, read: () => Promise<T[]>,
): Promise<ProviderResult<T>> {
  try {
    return { ok: true, service, items: await read() };
  } catch (err) {
    return { ok: false, service, items: [], error: describeAwsError(err) };
  }
}

/**
 * Read every provider, in parallel, keeping the failures and merging the
 * overlap.
 *
 * Two kinds of provider feed this: a handful that know one service deeply, and
 * one that knows every taggable service shallowly. They overlap, so the same
 * queue can arrive twice — once with its URL, its relationships and its
 * configuration, once as a bare ARN.
 *
 * **First wins**, and the specific providers are listed first, so the richer
 * description is the one kept. Showing a resource twice would be worse than
 * either: it makes a list look wrong, and it makes a count meaningless.
 */
export async function buildInventory(providers: Provider[]): Promise<Inventory> {
  const results = await Promise.all(providers.map(p => p.list()));
  const byService = new Map(results.map(r => [r.service, r]));

  const seen = new Set<string>();
  const all: Resource[] = [];
  for (const r of results) {
    for (const item of r.items) {
      // Keyed on the ARN where there is one, since that is the only identifier
      // two providers are guaranteed to agree on. Otherwise on service and
      // name, which is unique within a service.
      const key = (item.arn ?? `${item.service}/${item.name}`).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(item);
    }
  }

  return {
    byService,
    all,
    unreadable: results
      .filter(r => !r.ok)
      .map(r => ({ service: r.service, error: r.error ?? "unknown error" })),
  };
}

/**
 * Everything in the inventory whose identity contains the query.
 *
 * Matching is deliberately loose — somebody looking a resource up has a name
 * from a config file, a log line or a colleague, and it may be the bare name, a
 * full ARN, or a fragment of either. An exact-match box would fail on the most
 * common input, which is a name pasted with its ARN prefix still attached.
 */
/**
 * Words people use for a service that are not its provider name.
 *
 * `ec2-sg` is what this codebase calls them; "security group" is what everybody
 * else calls them, and a search box that does not know the second is a search
 * box that fails on the obvious query.
 */
const SERVICE_WORDS: Record<string, string> = {
  "ec2-sg": "security group firewall sg",
  "logs": "cloudwatch log group logging",
  "sqs": "queue",
  "s3": "bucket storage",
  "dynamodb": "table database",
  "rds": "database db postgres mysql",
  "iam": "role permission",
  "lambda": "function",
};

export function matchResources(inventory: Inventory, query: string): Resource[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  // An ARN was pasted: the last segment is the name, and matching on that finds
  // the resource even when the account or region in the pasted ARN is wrong.
  const tail = q.includes(":") ? q.split(":").pop()!.split("/").pop()! : q;

  const scored = inventory.all
    .map(r => {
      const name = r.name.toLowerCase();
      const arn = (r.arn ?? "").toLowerCase();
      const ids = (r.ids ?? []).map(i => i.toLowerCase());

      if (arn && arn === q) return { r, score: 0 };
      // An exact id beats a fuzzy name: somebody who pasted `sg-0d311…` wants
      // that resource and nothing else.
      if (ids.includes(q)) return { r, score: 0 };
      if (name === q || name === tail) return { r, score: 1 };
      if (arn.includes(q)) return { r, score: 2 };
      if (ids.some(i => i.includes(q))) return { r, score: 2 };
      if (name.startsWith(tail)) return { r, score: 3 };
      if (name.includes(tail)) return { r, score: 4 };
      // The service itself, so "security" or "lambda" lists that kind. A person
      // who does not remember a name still knows what sort of thing it was.
      if (r.service.toLowerCase().includes(q) || SERVICE_WORDS[r.service]?.includes(q)) {
        return { r, score: 5 };
      }
      return null;
    })
    .filter((x): x is { r: Resource; score: number } => x !== null);

  return scored
    .sort((a, b) => a.score - b.score || a.r.name.localeCompare(b.r.name))
    .map(x => x.r);
}

/**
 * Every identifier worth searching source for.
 *
 * A queue is named in Terraform by its name, in a Lambda's environment by its
 * URL, and in an IAM policy by its ARN — three strings for one resource, and
 * searching only one of them finds a third of the references.
 */
/**
 * The logical id inside a CloudFormation physical name, or null.
 *
 * Deliberately strict. A loose pattern would shorten ordinary names that happen
 * to contain hyphens — `payments-events-dlq` is not a stack, a logical id and a
 * hash — and a wrongly shortened term matches the wrong files, which is worse
 * than matching none.
 */
export function logicalIdFrom(name: string): string | null {
  // {Stack}-{LogicalId}{8 hex}-{13+ mixed-case random}
  const m = /^[A-Za-z0-9]+-([A-Za-z0-9]*?)[0-9A-F]{8}-[A-Za-z0-9]{12,}$/.exec(name);
  const id = m?.[1];
  return id && id.length >= 3 ? id : null;
}

export function searchTermsFor(r: Resource): string[] {
  const terms = new Set<string>([r.name]);
  if (r.arn) terms.add(r.arn);

  // The name with a generated suffix removed.
  //
  // Source almost never contains the full name of a resource whose name is
  // built at deploy time. A bucket called `acme-audit-log-123456789012` appears
  // in Terraform as `"acme-audit-log-${data.aws_caller_identity.current.id}"`
  // and in CDK as a template literal — so searching the literal finds nothing
  // and the report says, with confidence, that no source refers to it.
  //
  // Found by running this against a real account: the app's own audit bucket,
  // which the codebase creates and documents, came back with zero references
  // because its name ends in the account id.
  // A CloudFormation or CDK physical name, reduced to the logical id.
  //
  // CloudFormation names resources `{Stack}-{LogicalId}{8 hex}-{13 random}`, so
  // the queue this codebase declares as `WebhookQueue` exists in AWS as
  // `GitHubControlHub-WebhookQueueA9D318EA-xGZdeHQei9vh`. Source contains the
  // logical id and never the physical name, so searching the physical name
  // finds nothing — and every CDK-managed resource in an account reports as
  // referenced by nobody.
  //
  // Found by running a blast radius against a real queue that two Lambdas
  // plainly consume and that the codebase plainly declares, and watching it
  // report zero source references.
  const logical = logicalIdFrom(r.name);
  if (logical) terms.add(logical);

  let base = r.name;
  for (const suffix of [
    /[-_]\d{12}$/,                                             // account id
    /[-_](us|eu|ap|sa|ca|me|af)-[a-z]+-\d$/i,                  // region
    /[-_](prod|production|staging|stage|dev|test|qa)$/i,        // environment
  ]) {
    const next = base.replace(suffix, "");
    if (next !== base && next.length >= 3) {
      terms.add(next);
      base = next;
    }
  }
  return [...terms].filter(t => t.length >= 3);
}

/**
 * A link to the resource in the AWS console.
 *
 * Built rather than fetched — AWS returns no console URL for anything, and the
 * shapes are stable and documented. The point is that "1 Lambda consumes this"
 * is a fact somebody then has to go and act on, and making them search the
 * console for a name they were just shown is the difference between a report
 * and a tool.
 *
 * Returns null rather than guessing when the region is unknown or the service
 * has no obvious console page. A link to the wrong region shows an empty page
 * and reads as "this no longer exists", which is worse than no link.
 */
export function consoleUrl(r: ResourceId, detail?: Record<string, unknown>): string | null {
  const region = r.region;
  const base = (path: string) => `https://${region}.console.aws.amazon.com${path}`;

  switch (r.service) {
    case "lambda":
      return region ? base(`/lambda/home?region=${region}#/functions/${encodeURIComponent(r.name)}`) : null;
    case "sqs": {
      const url = detail?.url;
      return region && typeof url === "string"
        ? base(`/sqs/v3/home?region=${region}#/queues/${encodeURIComponent(url)}`)
        : null;
    }
    case "dynamodb":
      return region
        ? base(`/dynamodbv2/home?region=${region}#table?name=${encodeURIComponent(r.name)}`)
        : null;
    case "s3":
      // S3's console is global and does not take a region in the path.
      return `https://s3.console.aws.amazon.com/s3/buckets/${encodeURIComponent(r.name)}`;
    case "iam":
      // IAM is global too.
      return `https://console.aws.amazon.com/iam/home#/roles/${encodeURIComponent(r.name)}`;
    case "ec2-sg": {
      const id = detail?.groupId;
      return region && typeof id === "string"
        ? base(`/ec2/home?region=${region}#SecurityGroup:groupId=${id}`)
        : null;
    }
    case "logs":
      return region
        ? base(`/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encodeURIComponent(r.name).replace(/%2F/g, "$252F")}`)
        : null;
    case "rds":
      return region
        ? base(`/rds/home?region=${region}#database:id=${encodeURIComponent(r.name)}`)
        : null;
    default:
      return null;
  }
}
