# Webhooks on API Gateway and Lambda — design

**Date:** 2026-08-13

## Goal

Receive GitHub webhooks without an EC2 instance, and then delete the instance.

The work account's VPC has no internet gateway. Its default route goes to a
NAT/transit gateway, so egress works and inbound from the internet is
impossible. GitHub's deliveries fail with "failed to connect to host", and no
amount of security-group work fixes that — the security group is already
correct. API Gateway is public by nature and needs no VPC ingress, which removes
the problem rather than working around it.

Since the instance exists *only* to receive webhooks, it can then go, and with
it Docker, `scripts/deploy.sh`, the Elastic IP and the self-signed certificate.

This is a transport change. Same DynamoDB tables, same Secrets Manager secret,
same processing logic, same activity rows. Nothing about what the app records
changes.

## What is not changing

The desktop app. It runs its own backend on `localhost:4321` via
`desktop/src/bootstrap.ts` and `desktop/src/server.ts`, which are independent of
`backend/src/standalone.ts` — the only reference between them is a code comment.
The OAuth callback stays `http://localhost:4321/auth/callback`.

## Architecture

```
GitHub
  │  POST /webhooks/github        (four CIDRs, HMAC-signed)
  ▼
┌──────────────────────────┐
│  API Gateway (REST, v1)  │  resource policy: GitHub CIDRs only
│      Regional            │  throttled; access logs without bodies
└──────────────────────────┘
  │  proxy integration
  ▼
┌──────────────────────────┐   secret (cached)   ┌─────────────────┐
│  webhook-receiver        │◄───────────────────►│ Secrets Manager │
│  verify HMAC → enqueue   │                     └─────────────────┘
│  → 202                   │
└──────────────────────────┘
  │  SendMessage
  ▼
┌──────────────────────────┐
│  SQS (standard)          │──── 5 failures ───►┌─────────────┐
│  encrypted, TLS-only     │                    │     DLQ     │──► alarm
└──────────────────────────┘                    └─────────────┘
  │  event source mapping, batch 1, max concurrency 5
  ▼
┌──────────────────────────┐   claim / release   ┌──────────┐
│  webhook-worker          │◄───────────────────►│ DynamoDB │
│  claim → process → done  │   activity, alerts, │          │
└──────────────────────────┘   templates, graph  └──────────┘
```

Two functions rather than one, because it splits the privileges along the line
that matters. The function reachable from the internet can read one secret and
write to one queue. The function holding eleven tables, the GitHub App token and
the ability to apply templates to repositories is reachable only from a queue.
That property is worth an extra Lambda.

The path is **`/webhooks/github`**, dropping the `/api` prefix the Express route
carried. That prefix distinguished API routes from the frontend the instance
also served; this API serves one thing and has nothing to disambiguate from.
Since the URL is being retyped into GitHub's webhook settings either way, there
is no migration cost to getting it right. Used consistently throughout this
document.

### Why REST API and not HTTP API

HTTP APIs are cheaper and simpler, and do not support resource policies. The
[AWS comparison table][cmp] is explicit: resource policies are REST-only, as is
WAF. Keeping the GitHub IP allow-list is the requirement that decides this.

At this volume the price difference is around four-tenths of a cent per month
against an instance costing roughly fifteen dollars, so cost is not a factor
either way.

The endpoint type is **Regional**, not edge-optimised. There is no global
audience to accelerate — GitHub posts from four known ranges — and edge-optimised
adds a CloudFront layer for nothing.

[cmp]: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html

### The IP allow-list moves, it does not disappear

The resource policy carries the same four CIDRs the security group has today:

```
192.30.252.0/22   185.199.108.0/22   140.82.112.0/20   143.55.64.0/20
```

This is strictly better than the security group, because API Gateway evaluates
the policy before the integration is invoked — the code never runs for a request
from elsewhere, so it cannot be bypassed by a routing mistake.

It carries the same maintenance burden the security group already had: the list
comes from `https://api.github.com/meta` → `hooks`, and GitHub changes it
occasionally. Nothing here detects that. Deliveries would begin returning 403,
and the Activity page would go **Stale** within 72 hours. Documented in
`docs/operations/troubleshooting.md` rather than automated, which is the same
position as today.

## Code layout

The route body becomes a module the two handlers share:

| File | Contains |
|---|---|
| `backend/src/webhooks/verify.ts` | `verifyGitHubSignature(rawBody, sigHeader, secret)` — pure, no Express, no Lambda |
| `backend/src/webhooks/secret.ts` | Module-scope cached fetch of the webhook secret |
| `backend/src/webhooks/deliveryLock.ts` | Claim / complete / release against DynamoDB |
| `backend/src/webhooks/processDelivery.ts` | The route body, with the token passed in and its background work awaited |
| `backend/src/webhooks/receiver.ts` | API Gateway handler |
| `backend/src/webhooks/worker.ts` | SQS handler |

**Deleted:** `backend/src/routes/webhooks.ts` and its mount at `server.ts:98`.
It is imported in exactly one place and called by nothing else — the frontend's
webhook health comes from `/org/webhook-health`, which reads the activity table.

`processDelivery` takes the token as a parameter rather than calling
`getSystemToken()` internally. That is what makes it testable without
environment variables, and it is also the fix for the token lifecycle problem
below.

### Work that currently outlives the response must be awaited

"The route body" is not quite carried over unchanged, and the difference is the
easiest thing here to get wrong without noticing. Three calls in it are
deliberately not awaited, because on Express the process outlives the request:

| | |
|---|---|
| `webhooks.ts:279` | `refreshRepo(...).catch(...)` — compliance cache |
| `webhooks.ts:301` | `addRepoEdges(...).catch(...)` — graph edges for a new repo |
| `webhooks.ts:335` | `setTimeout(async () => { runScan… }, 1000)` — background scans |

In Lambda the container freezes the moment the handler resolves. An unawaited
promise may never settle and a one-second timer may never fire. Activity rows
and template auto-apply would keep working, because those *are* awaited — so
compliance refresh, new-repo graph edges and scanner runs would stop while
everything else looked healthy. A partial success is a worse failure than an
outage, because nothing reports it.

`processDelivery` therefore awaits all three, via `Promise.allSettled` so one
failure cannot suppress the other two. The existing `.catch()` handlers stay:
they are what turns a rejection into a logged line rather than a thrown error.

**Awaiting them must not let them fail the delivery.** All three swallow their
own errors today, and that property has to survive. If a flaky scanner could
throw out of `processDelivery`, the worker would release its claim, SQS would
redeliver, and the whole delivery would be reprocessed — re-applying templates
and writing a second set of `template.apply` rows, up to five times.
`Promise.allSettled` never rejects, which is why it is the right primitive here
rather than `Promise.all`.

**And it must not let them run long.** Swallowing errors does not help if the
enrichment simply takes too long: a pathological scan set pushes the invocation
past ten minutes, Lambda kills it, `completeDelivery` never runs, the lease
expires, and SQS redelivers into the same duplicate-template outcome by a
different route. The enrichment phase is therefore raced against a four-minute
ceiling, after which it is abandoned and the delivery is marked done regardless.

An abandoned scan costs a stale compliance cache until the next event for that
repository. An abandoned invocation costs a repository having its templates
applied twice. These are not close, and the ceiling is what keeps the cheap
failure the one that happens.

This is the direct cost of awaiting the work at all: what was unbounded
background time on a long-lived server is now inside a bounded invocation.
Awaiting it was still right — silently dropping it was worse — but bounded work
needs a bound.

The `setTimeout` wrapper is dropped rather than awaited. Its one-second delay
existed to let the HTTP response go out first, and in the worker there is no
response to get out of the way of.

This is the same class of problem as the `res.status(202)` split that motivated
the queue, just less visible — the response boundary was never the only place
work escaped the request.

## The three things most likely to go wrong

### 1. HMAC over raw bytes

The signature is computed over the exact bytes GitHub sent. API Gateway may
hand Lambda a base64-encoded body, and anything that parses and re-serialises
the payload before verification breaks every signature.

```ts
const raw = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8");
```

The HMAC is computed over `raw`, and nothing calls `JSON.parse` until the
signature has passed. After that the parsed object is what goes onto the queue,
so the raw bytes never need to survive a second hop — the worker never verifies
anything and never sees them.

Rejecting the direct API Gateway → SQS integration was mostly about this. That
shape requires a VTL mapping template to build the message, which is exactly
where raw bytes get mangled, and it would put unverified payloads in the queue.

Comparison stays `crypto.timingSafeEqual`, and an absent secret still returns
`false`. No secret means accept nothing.

### 2. Replay protection

`processedDeliveries` is an in-memory `Map`. On a long-lived server it works; it
does nothing across Lambda invocations.

It moves to DynamoDB, in the **worker** rather than the receiver. SQS standard
queues are at-least-once, so the worker needs deduplication regardless of
whether GitHub ever replays anything. Putting a second check in the receiver
would only save queue messages, and would add a second place capable of silently
swallowing a legitimate redelivery.

New table `github-control-hub-webhook-deliveries`, partition key `deliveryId`,
TTL attribute `ttl`.

**This one table is created by CDK**, unlike the other eleven, which
`scripts/setup-aws-account.sh` creates with `aws dynamodb create-table`. That
split is deliberate rather than an inconsistency: the setup script owns durable
application data, and keeping those tables outside CloudFormation is what stops
`cdk destroy` taking the activity log with it. This table holds nothing but
five-minute deduplication state, so it belongs with the infrastructure that
depends on it and carries `RemovalPolicy.DESTROY`.

The practical reason matters more than the principle. The setup script has
already run in both accounts and will not be run again, so a table added there
would simply not exist when the worker deployed. Every delivery would fail on a
`ResourceNotFoundException` from the claim, which presents as a
replay-protection bug rather than a missing table. Putting it in CDK means
`cdk deploy` produces a working system, which is the only property that makes
the rollout below safe.

```
claim     PutItem   ConditionExpression:
                      attribute_not_exists(deliveryId) OR expiresAt < :now
                    → state = "processing", expiresAt = now + 660   (a lease)

complete  PutItem   → state = "done", expiresAt = now + 900, ttl = now + 900

fail      DeleteItem, then rethrow → SQS redelivers → DLQ after 5 attempts
```

The lease is 660 seconds to match the queue's visibility timeout, so it outlives
the worker's own 600-second timeout — a lease equal to the function timeout
would expire at the exact moment a maximally slow invocation was still
finishing, letting a second worker claim a delivery the first had not released.

The `done` marker is 900 seconds, and the reason it is longer than the lease
rather than shorter is the one thing here that is easy to get backwards. The
obvious value is 300 seconds, matching the replay window the in-memory `Map`
used. That is wrong under SQS: a worker can process a delivery successfully and
have the subsequent message deletion not register, which is ordinary
at-least-once behaviour. The redelivery then arrives one visibility timeout
later — 660 seconds — and a 300-second marker has already expired, so the
delivery is claimed again and processed a second time. Templates applied twice.

The marker therefore has to outlive the visibility timeout, not the replay
window. The cost is that a manual redelivery from GitHub's UI is silently
ignored for fifteen minutes rather than five. That is a real change from today's
behaviour and the right way round: an ignored redelivery is a person waiting and
retrying, while a duplicated one rewrites a repository.

The condition treats a logically expired row as absent. This is the same
reasoning as the one-time auth codes in `routes/auth.ts` — DynamoDB's TTL sweep
is lazy, so expiry is checked in the condition rather than trusted to the
sweeper — expressed for a conditional put instead of a delete.

The lease is what makes a killed worker recoverable. Without it, a Lambda that
times out mid-delivery leaves a claim nothing will ever release, and that event
is lost permanently. With it, the claim expires after the function's own timeout
and the next SQS attempt takes it.

The `done` marker's five-minute TTL is deliberately the same window as today's
`DELIVERY_TTL_MS`, so a manual redelivery from GitHub's UI behaves exactly as it
does now.

### 3. The GitHub App token

`getSystemToken()` is synchronous and returns a module-singleton cache kept warm
by a `setTimeout`. Lambda freezes the container between invocations, so that
timer does not fire on schedule. A warm container would keep serving the cached
token until it expired, then silently fall back to `SYSTEM_GITHUB_TOKEN` —
auto-apply would stop with "No GitHub token available", intermittently, only on
warm containers.

The worker calls `await getSystemTokenAsync()` once per invocation and passes
the result into `processDelivery`. `getTokenAsync` already checks freshness and
deduplicates concurrent refreshes, so this is correct on both cold and warm
containers and makes the refresh timer irrelevant rather than depending on it.

The receiver never touches GitHub and never initialises the token manager.

## Ordering

The queue is standard, not FIFO. Two events for one repository can be processed
concurrently.

This is not a change. The EC2 did not serialise deliveries either: Express
handles concurrent requests, and the handler is `async` with roughly twenty
`await` points, so simultaneous deliveries already interleave. "Serial because
there is one box" was never true.

The race worth checking is `repository.created` running `addRepoEdges` while the
template's own branch creations fire `addBranchEdge`. It is benign —
`addRepoEdges` ends in `putEdgesBatch` with no delete-first, so it is an upsert
and both orderings converge on the same edge set.

The one genuine hazard is inversion between `createAlert` and
`autoResolveAlerts` for the same repository: protection deleted then immediately
re-created, or a repository publicized then privatized. Processed out of order,
the result is a critical alert that never clears. This hazard exists on the EC2
today and is unchanged by this work.

A FIFO queue with `MessageGroupId` set to the repository name would eliminate
it, and is rejected: it buys a guarantee the system has never had, at the cost
of head-of-line blocking it has never had. With five receive attempts against an
eleven-minute visibility timeout, one poison message would stall every
subsequent event for that repository for nearly an hour. Capping concurrency
narrows the inversion window as a side effect, which is the proportionate
response.

## Configuration

| | Receiver | Worker |
|---|---|---|
| Timeout | 8s | 10 min |
| Memory | 256 MB | 512 MB |
| Runtime | `NODEJS_24_X` | `NODEJS_24_X` |

| Queue | |
|---|---|
| Visibility timeout | 11 min |
| `maxReceiveCount` | 5 |
| Batch size | 1 |
| Event source `maxConcurrency` | 5 |
| Worker reserved concurrency | 5 |

The receiver's eight seconds is a ceiling, not a target — warm invocations are
tens of milliseconds, and a cold start plus the secret fetch is one to two
seconds. It sits below GitHub's ten-second timeout deliberately: past that point
nobody is listening for the response, so there is no value in still working.

The worker gets ten minutes — Lambda's maximum, and what `guardrailFn` already
uses. Five would have been enough for the five-second provisioning wait and four
`applyTemplate` attempts with 4s/8s/12s backoff, but awaiting the scanner runs
moves work that was previously unbounded background time on a long-lived server
into the invocation itself. Duration is billed as used, not as allocated, so the
larger ceiling costs nothing on the ordinary delivery that finishes in two
seconds.

### Concurrency is limited at the poller, not at the function

`createOctokit` sets `onRateLimit: () => false`. A throttled call does not
retry, it fails. A burst — bulk repository creation, a redelivery storm — would
otherwise spawn parallel workers that collectively exhaust the installation's
rate limit and fail rather than slow down.

The control for that is **maximum concurrency on the event source mapping**, not
reserved concurrency on the function. They are not interchangeable. Reserved
concurrency caps invocations, but the event source mapping would still scale its
polling toward the account default and have the surplus invocations throttled —
and a throttled invocation still increments the message's receive count. Left
that way, reserved concurrency would *cause* the DLQ problem it was meant to
prevent, sending messages to the dead-letter queue that no worker ever saw.

Maximum concurrency limits the poller instead, so surplus messages stay in the
queue with their receive count untouched. AWS is explicit that the function's
reserved concurrency must be greater than or equal to the event source's maximum
concurrency, so both are 5.

`maxReceiveCount` is 5 rather than 3 for the same reason, and AWS's own
guidance says so: a message can be received and returned without ever being
processed, so the count is sized for throttling rather than for processing
failures. It should not be tidied back down.

### The secret cache

Fetched once per container, cached fifteen minutes. Per delivery it would add
latency against GitHub's ten-second budget, cost a call per invocation, and make
every webhook depend on an API the work account restricts by SCP.

A cache that long would ordinarily mean up to fifteen minutes of rejected
deliveries after the webhook secret is rotated — and rejected deliveries are
lost, not queued. So a verification failure invalidates the cache and retries
once, with a sixty-second floor between refetches. That bounds a rotation to
roughly one lost delivery instead of fifteen minutes of them, and the floor plus
the resource policy means a stream of bad signatures cannot be turned into a
stream of Secrets Manager calls.

Fail-closed is unchanged: if the refetch also yields no secret, the delivery is
rejected.

Table names reach the worker as environment variables, following the pattern
`guardrailFn` already uses. Secrets are never environment variables.

## IAM

**Receiver.** `secretsmanager:GetSecretValue` on the one secret, and
`sqs:SendMessage` on the one queue. No DynamoDB, no STS, no Organizations, no
Lambda invoke. This is the only function exposed to the internet, and this list
is the point of splitting it out.

**Worker.** What the EC2 instance role holds today, minus `s3:GetObject` on the
deploy bucket, which existed only to receive Docker images.

The existing DynamoDB grant is already scoped to `table/${stackPrefix}-*`, so
the new deliveries table needs no policy change.

## Failure visibility

Today a failed auto-apply writes a failed activity row through
`updateActivityOutcome(..., failed: true)`, which surfaces in the app. That is
preserved exactly — it is inside `processDelivery` and moves with it.

What is new is the DLQ, and a queue nobody watches is a queue that quietly fills
up. `grep -n "Alarm" infra/*.ts` currently returns nothing, so the existing
guardrail DLQ has this gap too. Both get a CloudWatch alarm on
`ApproximateNumberOfMessagesVisible >= 1`.

Alarm actions are optional: `cdk deploy -c alertEmail=…` creates an SNS topic
and subscription. Without it the alarms still exist and still show in the
console. Requiring an email address to deploy would be worse than an alarm
somebody has to go and look at.

## Deletion

Removed once the new path is proven:

| | Why it goes |
|---|---|
| EC2 instance, security group, Elastic IP, instance role | The instance existed only for webhooks |
| UserData, self-signed certificate | Instance bootstrap |
| `Dockerfile`, `docker-compose.yml`, `.dockerignore` | `CMD` is `node …/dist/standalone.js`; only `deploy.sh` builds the image; CI builds Electron only |
| `scripts/deploy.sh` | Deploys the image to the instance |
| `backend/src/standalone.ts` | The instance's entry point |
| `backend/src/routes/webhooks.ts` | Replaced by the two handlers |
| Outputs `InstanceId`, `PublicIp`, `ConnectCommand` | Nothing to point at |

Nothing is lost. The instance also served the frontend, but the security group
allowed only GitHub's ranges, so no browser has ever reached it.

The test suites run `repro-*.ts` under `tsx` directly and never involve a
container, so deleting the Docker files costs no test coverage.

## Testing

New suite `repro-webhookdelivery.ts`:

- a correct signature verifies when the body arrives base64-encoded
- a correct signature verifies when the body arrives as UTF-8
- a tampered payload is rejected
- an absent secret rejects everything
- a malformed signature header is rejected rather than throwing
- a second claim on the same delivery id is refused
- a claim whose lease has expired can be re-taken
- a failed delivery releases its claim
- background work is awaited rather than abandoned when the handler resolves
- a rejecting background task does not fail the delivery
- background work that hangs is abandoned at the ceiling rather than running on

The last three guard the fire-and-forget problem above, and the last two matter
more than they look. A future edit swapping `Promise.allSettled` for
`Promise.all` would arm a redelivery loop that re-applies templates up to five
times, and nothing else in the suite would notice — the change reads like a
simplification. Removing the ceiling fails the same way through a timeout
instead of a rejection.

The first two are the reason this suite exists. Base64 handling is the single
most likely way this migration fails silently, and it fails in a way that looks
exactly like a wrong secret.

**`repro-appsec.ts`** currently reads `routes/webhooks.ts` by path and asserts
constant-time comparison and fail-closed-on-missing-secret. It repoints at
`webhooks/verify.ts` and gains an assertion that the receiver enqueues nothing
before verification returns true.

**`repro-leastprivilege.ts`** gains assertions that the receiver's role grants
no `dynamodb:` or `sts:` action, and that the API's resource policy names the
GitHub CIDRs.

Both are strengthened. Neither is weakened.

## Rollout

Two commits, because the deletion should not be load-bearing on the first
deploy being right.

1. Add the API Gateway path with the instance still standing. Deploy to
   personal (`774941662655`, us-east-1), where webhooks work today and a
   regression is visible immediately. Repoint the org's webhook URL; GitHub
   sends `ping`. Create a test repository and confirm the activity row, the
   auto-applied template, and the Activity page reading **Receiving events**.
2. Delete the instance and everything in the table above. Deploy to personal,
   then to work (`792424903548`, us-east-2).

The end state is one stack with no EC2 in either account.

### Repoint the webhook, do not add a second one

The obvious instinct for a safe cutover — leave the existing webhook pointing at
the instance and add a second one pointing at API Gateway — is wrong here, and
would do real damage.

GitHub treats them as two independent webhooks and gives each delivery its own
`X-GitHub-Delivery` id for the same underlying event. The deduplication lock is
keyed on that id, so it would not recognise the pair as duplicates. Both would
process: templates applied twice to a new repository, duplicate alerts,
duplicate activity rows.

Edit the existing webhook's URL. There is no window in which both receivers are
live.

### Verification is the app's own Activity page

`/org/webhook-health` derives from the activity table via `lastGitHubEvent()`,
not from whatever received the delivery. So the same signal that reports the
outage today reports the fix, with nothing new to build: **Receiving events**
means an activity row was written in the last 24 hours by whatever is now
handling webhooks.

The `ping` GitHub sends on saving the URL confirms only reachability and the
signature — it writes no activity row. Creating a test repository is what
exercises the whole path.

## Out of scope

- Detecting GitHub's IP ranges changing. Same position as today.
- Surfacing DLQ depth in the app's UI. The CloudWatch alarm is the mechanism.
- Any change to what events are handled or what they record.
- Custom domain for the API. The generated `execute-api` URL is what GitHub
  will be pointed at.
