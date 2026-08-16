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

/** Read every provider, in parallel, and keep the failures. */
export async function buildInventory(providers: Provider[]): Promise<Inventory> {
  const results = await Promise.all(providers.map(p => p.list()));
  const byService = new Map(results.map(r => [r.service, r]));
  return {
    byService,
    all: results.flatMap(r => r.items),
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
      if (arn && arn === q) return { r, score: 0 };
      if (name === q || name === tail) return { r, score: 1 };
      if (arn.includes(q)) return { r, score: 2 };
      if (name.startsWith(tail)) return { r, score: 3 };
      if (name.includes(tail)) return { r, score: 4 };
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
export function searchTermsFor(r: Resource): string[] {
  const terms = new Set<string>([r.name]);
  if (r.arn) terms.add(r.arn);
  // The bare name without a common environment suffix, so `payments-events-prod`
  // also finds the module that builds it as `payments-events-${var.env}`.
  const stripped = r.name.replace(/[-_](prod|production|staging|stage|dev|test)$/i, "");
  if (stripped !== r.name) terms.add(stripped);
  return [...terms].filter(t => t.length >= 3);
}
