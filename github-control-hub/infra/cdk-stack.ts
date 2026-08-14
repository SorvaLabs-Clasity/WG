import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as logs from "aws-cdk-lib/aws-logs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";

// From https://api.github.com/meta → hooks. Nothing here detects a change:
// deliveries would begin returning 403 and the app's Activity page would read
// Stale within 72 hours. See docs/operations/troubleshooting.md.
//
// This is the API Gateway resource policy's IP allow-list — the only thing
// that still reads it now that there is no security group to share it with.
const GITHUB_WEBHOOK_CIDRS = [
  "192.30.252.0/22",
  "185.199.108.0/22",
  "140.82.112.0/20",
  "143.55.64.0/20",
];

/**
 * GitHub's IPv6 hook ranges.
 *
 * Kept separate because IAM will not accept a mixed list: `aws:SourceIp` with
 * IPv4 CIDRs and `aws:SourceIpv6`... in fact both go in aws:SourceIp, but an
 * IPv6 request compared only against IPv4 ranges matches nothing, so
 * NotIpAddress evaluates true and the request is denied. Publishing hooks over
 * IPv6 would have failed every delivery with a 403 that looks exactly like a
 * stale allow-list.
 */
const GITHUB_WEBHOOK_CIDRS_V6 = [
  "2a0a:a440::/29",
  "2606:50c0::/32",
];

interface GitHubControlHubProps extends cdk.StackProps {
  /** Secrets Manager secret name. Defaults to "github-control-hub/secrets" */
  secretName?: string;
  /**
   * Where the webhook HMAC secret lives, on its own.
   * Defaults to "github-control-hub/webhook-secret".
   *
   * Separate from the bundle above on purpose — see the receiver's grant.
   */
  webhookSecretName?: string;
  /** DynamoDB table prefix. Defaults to "github-control-hub" */
  stackPrefix?: string;
}

export class GitHubControlHubStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GitHubControlHubProps = {}) {
    super(scope, id, props);

    const secretName = props.secretName ?? "github-control-hub/secrets";
    const webhookSecretName = props.webhookSecretName ?? "github-control-hub/webhook-secret";
    const stackPrefix = props.stackPrefix ?? "github-control-hub";

    // The only role this app may ever assume, anywhere.
    //
    // Named exactly, and the grants below are scoped to this name alone. The
    // roles AWS creates by default in organisation member accounts —
    // OrganizationAccountAccessRole, AWSControlTowerExecution — carry
    // AdministratorAccess, and this app is deliberately unable to assume them.
    // Convenience is not worth an application in a production account holding
    // administrator anywhere.
    const guardrailRoleName = `${stackPrefix}-guardrail-access`;

    // ── AWS guardrails ──
    // Enforcement runs here, in Lambda, rather than on a server: it needs no
    // inbound connectivity at all, so there is nothing for anyone to reach.
    const guardrailDlq = new sqs.Queue(this, "GuardrailDlq", {
      retentionPeriod: cdk.Duration.days(14),
      // Failed invocations carry the event that caused them, which names
      // accounts and resources. Encrypted with an AWS-managed key: it costs
      // nothing and means the queue is not the one unencrypted thing here.
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      // Anything talking to this queue does so over TLS or not at all.
      enforceSSL: true,
    });

    const guardrailFn = new NodejsFunction(this, "GuardrailEnforcer", {
      functionName: `${stackPrefix}-guardrail-enforcer`,
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, "..", "backend", "src", "aws-guardrails", "handler.ts"),
      handler: "handler",
      // The entry lives in the backend, one level up from this stack. CDK
      // requires it to sit under projectRoot, so projectRoot is the workspace
      // rather than infra/ — bundling from the app's own source tree is the
      // point, since it is what stops the deployed function drifting from the
      // code it was built from.
      projectRoot: path.join(__dirname, ".."),
      depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
      // A full sweep walks every bucket, log group, instance and DB in the
      // account, each needing several describe calls.
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      environment: {
        STACK_NAME: stackPrefix,
        GUARDRAILS_TABLE: `${stackPrefix}-aws-guardrails`,
        GUARDRAIL_EXCLUSIONS_TABLE: `${stackPrefix}-aws-exclusions`,
        GUARDRAIL_FINDINGS_TABLE: `${stackPrefix}-aws-findings`,
        ORG_CONFIG_TABLE: `${stackPrefix}-org-config`,
        GUARDRAIL_ROLE_NAME: guardrailRoleName,
        ACTIVITY_TABLE: `${stackPrefix}-activity`,
      },
      deadLetterQueue: guardrailDlq,
      bundling: {
        // The SDK is bundled rather than taken from the runtime.
        //
        // Managed runtimes have shipped AWS SDK v3, and leaning on that keeps
        // the artifact small — at the cost of running against whichever
        // version AWS happens to ship, which can change under you without any
        // deploy. Bundling removes that variable entirely and makes the
        // function correct on any runtime. It costs about two megabytes and a
        // fraction of a second of cold start, on a function that runs every
        // fifteen minutes and then makes hundreds of AWS calls.
        externalModules: [],
        minify: false,
        sourceMap: true,
      },
    });

    // Reads. Six actions, all of them Describe/List/Get on configuration.
    //
    // Nothing here can read the contents of anything: s3:GetObject is absent,
    // logs:GetLogEvents is absent. The app sees whether a bucket has a policy,
    // never what is in the bucket.
    //
    // "*" is not a choice made here. ListAllMyBuckets and DescribeLogGroups
    // are account-wide operations that IAM does not let you scope, and the
    // remaining Gets have to reach whichever resource turns out to exist.
    guardrailFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "ReadConfigurationOnly",
      actions: [
        "s3:ListAllMyBuckets", "s3:GetBucketLocation", "s3:GetBucketPolicy", "s3:GetBucketTagging",
        "logs:DescribeLogGroups", "logs:ListTagsForResource",
      ],
      resources: ["*"],
    }));

    {
      // Three actions. Not s3:* and not logs:*, so a later version of this app
      // cannot quietly start doing something this account never agreed to
      // without the policy visibly changing.
      //
      // Granted unconditionally. It used to sit behind `-c enforce=true`, so a
      // deploy that forgot the flag produced an app whose rules reported
      // violations and never fixed them — the feature half-working, silently,
      // until somebody noticed weeks later that nothing had changed.
      //
      // Whether a rule acts is already a decision, made per rule in the AWS
      // tab, visible there, and defaulting to report. That is the right place
      // for it: a second gate in IAM only duplicated the choice somewhere
      // nobody could see it.
      guardrailFn.addToRolePolicy(new iam.PolicyStatement({
        sid: "RemediateThreeThings",
        actions: [
          "s3:PutBucketPolicy",
          "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy",
        ],
        resources: ["*"],
      }));
    }

    // Reaching other accounts. The role name is fixed rather than "*" so this
    // grant cannot be pointed at an arbitrary role someone happens to name in
    // the accounts table — the target account still has to trust us back, but
    // there is no reason for this side to be wider than it needs to be.
    guardrailFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "AssumeGuardrailRoleInOtherAccounts",
      actions: ["sts:AssumeRole"],
      // Exactly one role name. Deploy it across the organisation with
      // scripts/deploy-guardrail-role-org-wide.sh, which uses a StackSet — one
      // command, every account, including accounts created later.
      resources: [`arn:aws:iam::*:role/${guardrailRoleName}`],
    }));

    guardrailFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "ReadAccountKeys",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${stackPrefix}/aws-account/*`],
    }));

    // Which account we are in. Findings are stamped with it, so without this
    // every finding in the home account is labelled "unknown".
    guardrailFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "WhoAmI",
      actions: ["sts:GetCallerIdentity"],
      resources: ["*"],
    }));

    guardrailFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "GuardrailTables",
      actions: [
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
        "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:Query", "dynamodb:BatchWriteItem",
      ],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${stackPrefix}-*`],
    }));

    // Creation events. These only exist if a CloudTrail trail logs management
    // events in this region; without one, the scheduled sweep below is the only
    // path and a new resource waits up to its interval to be checked.
    new events.Rule(this, "GuardrailCreateEvents", {
      description: "Run guardrails when a covered resource is created or drifts",
      eventPattern: {
        source: ["aws.s3", "aws.logs"],
        detailType: ["AWS API Call via CloudTrail"],
        detail: {
          // Creation is not the only moment worth reacting to. Someone
          // loosening an existing resource is the more common way an account
          // drifts, and waiting a sweep interval to notice reads as the app
          // being broken. Our own remediation re-triggers this, but the second
          // run finds the resource compliant and writes nothing, so it stops.
          eventName: [
            "CreateBucket", "PutBucketPolicy", "DeleteBucketPolicy",
            "CreateLogGroup", "PutRetentionPolicy", "DeleteRetentionPolicy",
          ],
        },
      },
      targets: [new targets.LambdaFunction(guardrailFn, { deadLetterQueue: guardrailDlq })],
    });

    // The sweep is the floor, not an optimisation: it catches drift, covers
    // anything the event path missed, and works with no trail at all.
    new events.Rule(this, "GuardrailSweep", {
      description: "Periodic guardrail sweep across the account",
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(guardrailFn, { deadLetterQueue: guardrailDlq })],
    });

    // ── Webhooks ──
    //
    // The instance this replaces could not be reached at all in the work
    // account: that VPC has no internet gateway, so inbound from the internet
    // is impossible however the security group is written. API Gateway needs
    // no VPC ingress.

    // The only table CDK owns. The other eleven are created by
    // scripts/setup-aws-account.sh and deliberately stay outside
    // CloudFormation, so `cdk destroy` cannot take the activity log with it.
    // This one holds five-minute deduplication state and nothing else.
    const deliveriesTable = new dynamodb.Table(this, "WebhookDeliveries", {
      tableName: `${stackPrefix}-webhook-deliveries`,
      partitionKey: { name: "deliveryId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const webhookDlq = new sqs.Queue(this, "WebhookDlq", {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    const webhookQueue = new sqs.Queue(this, "WebhookQueue", {
      // Must exceed the worker's own timeout.
      visibilityTimeout: cdk.Duration.minutes(11),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: {
        queue: webhookDlq,
        // Sized for throttling, not for processing failures: a throttled
        // invocation still increments a message's receive count, so a burst
        // could otherwise send messages to the DLQ that no worker ever saw.
        // AWS's own guidance is a minimum of five. Do not tidy this down.
        maxReceiveCount: 5,
      },
    });

    const webhookBundling = {
      externalModules: [],
      minify: false,
      sourceMap: true,
      // @octokit/auth-app is installed into the asset rather than bundled.
      //
      // github/client.ts loads it through require.resolve() plus a dynamic
      // import built with `new Function`, which is how it dodges tsc rewriting
      // the import into a require for an ESM-only package. esbuild cannot see
      // through that either, so it bundles nothing — and require.resolve then
      // fails at runtime with "Cannot find module '@octokit/auth-app'". The
      // symptom is quiet: the App token manager fails to initialise, every
      // invocation degrades to SYSTEM_GITHUB_TOKEN, and the app runs on a PAT's
      // 5,000 requests an hour instead of the App's 12,500.
      //
      // esbuild warns about exactly this ("should be marked as external for use
      // with require.resolve") during synth.
      //
      // Marking it external is NOT the fix, and was tried: `octokit` itself
      // requires @octokit/auth-app internally, so leaving it external puts a
      // bare require() of an ESM-only package in the bundle and the whole
      // function dies at init with ERR_REQUIRE_ESM. Bundling it — the setting
      // below — at least keeps octokit working; only client.ts's
      // require.resolve path fails, and getSystemTokenAsync degrades to
      // SYSTEM_GITHUB_TOKEN. The real fix belongs in client.ts, not here.
    };

    const receiverFn = new NodejsFunction(this, "WebhookReceiver", {
      functionName: `${stackPrefix}-webhook-receiver`,
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, "..", "backend", "src", "webhooks", "receiver.ts"),
      handler: "handler",
      projectRoot: path.join(__dirname, ".."),
      depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
      // Below GitHub's ten-second timeout on purpose: past that nobody is
      // listening for the response, so there is no value in still working.
      timeout: cdk.Duration.seconds(8),
      memorySize: 256,
      environment: {
        STACK_NAME: stackPrefix,
        // Not SECRET_NAME. This function has no business knowing where the
        // application bundle lives, and cannot read it if it did.
        WEBHOOK_SECRET_NAME: webhookSecretName,
        WEBHOOK_QUEUE_URL: webhookQueue.queueUrl,
      },
      bundling: webhookBundling,
    });

    // Two grants, and that is the whole of it. This function is the only thing
    // here reachable from the internet.
    //
    // The grant is the webhook secret alone, not the application bundle. The
    // receiver must touch unverified bytes to verify them — it base64-decodes
    // and HMACs a body no one has authenticated yet — and no review proves
    // that path free of bugs forever. So the question that matters is not
    // whether it can be broken but what breaking it yields. Against the
    // bundle it yielded GITHUB_APP_PRIVATE_KEY and the whole organisation
    // with it; against this secret it yields the ability to check signatures.
    //
    // The two wildcards must stay disjoint: "…/secrets*" cannot match
    // "…/webhook-secret*" and vice versa, which is why the latter is not
    // named something like "secrets-webhook".
    receiverFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "ReadWebhookSecret",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${webhookSecretName}*`],
    }));
    webhookQueue.grantSendMessages(receiverFn);

    const workerFn = new NodejsFunction(this, "WebhookWorker", {
      functionName: `${stackPrefix}-webhook-worker`,
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, "..", "backend", "src", "webhooks", "worker.ts"),
      handler: "handler",
      projectRoot: path.join(__dirname, ".."),
      depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
      // A single invocation can chain a compliance refresh, graph edge
      // updates and scanner runs — background work that used to be unbounded
      // on a long-lived server and now happens inside the invocation. Lambda
      // bills by duration actually used, so a high ceiling here costs nothing
      // when the work finishes early and only matters on the rare delivery
      // that needs it.
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      // No reserved concurrency, deliberately.
      //
      // Reserving would be the belt to the event source's braces, and AWS asks
      // that a reservation be at least the event source's maximum concurrency.
      // But a reservation is carved out of the account's pool, and Lambda
      // refuses to leave fewer than 10 unreserved executions behind. An account
      // on the default quota of 10 therefore cannot reserve anything at all —
      // the deploy fails with "decreases account's UnreservedConcurrentExecution
      // below its minimum value of [10]".
      //
      // Nothing is lost. The cap that matters is maxConcurrency on the event
      // source below: it limits the poller, so surplus messages wait in the
      // queue with their receive count untouched, which is the property that
      // keeps a burst out of the dead-letter queue. A reservation would only
      // have guaranteed this function a share of the pool.
      environment: {
        STACK_NAME: stackPrefix,
        SECRET_NAME: secretName,
        ACTIVITY_TABLE: `${stackPrefix}-activity`,
        SCANNERS_TABLE: `${stackPrefix}-scanners`,
        ALERTS_TABLE: `${stackPrefix}-alerts`,
        ORG_CONFIG_TABLE: `${stackPrefix}-org-config`,
        GRAPH_EDGES_TABLE: `${stackPrefix}-graph-edges`,
        COMPLIANCE_CACHE_TABLE: `${stackPrefix}-compliance-cache`,
        WEBHOOK_DELIVERIES_TABLE: deliveriesTable.tableName,
        // The worker emails security alerts as it records them, so it reads
        // the toggle and the group from here.
        ALARMS_TABLE: `${stackPrefix}-alarms`,
      },
      bundling: webhookBundling,
    });

    workerFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "ReadAppSecrets",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${secretName}*`],
    }));

    // Publish only, and only to this app's own topics.
    //
    // The name prefix is the boundary: topics are created as
    // `${stackPrefix}-notify-<slug>`, so this grant cannot reach a topic
    // belonging to anything else in the account, and cannot subscribe anyone
    // to anything. Adding recipients happens in the desktop app, under the
    // operator's own credentials.
    const notifyTopics = `arn:aws:sns:${this.region}:${this.account}:${stackPrefix}-notify-*`;
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "PublishAlarmEmails",
      actions: ["sns:Publish"],
      resources: [notifyTopics],
    }));

    workerFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "AppTables",
      actions: [
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
        "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:Query",
        "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
      ],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${stackPrefix}-*`],
    }));

    // Limited at the poller rather than at the function. Reserved concurrency
    // alone would let the event source keep scaling its polling and have the
    // surplus invocations throttled — and a throttled invocation still
    // increments the message's receive count, so the setting meant to protect
    // GitHub's rate limit would instead fill the dead-letter queue with
    // messages no worker ever saw.
    //
    // The rate limit is the reason any cap exists: createOctokit sets
    // onRateLimit to false, so a throttled GitHub call fails rather than
    // retrying.
    workerFn.addEventSource(new SqsEventSource(webhookQueue, {
      batchSize: 1,
      maxConcurrency: 5,
    }));

    // ── widget alarms ───────────────────────────────────────────────────
    //
    // Reachable only from EventBridge. It reads whichever widgets have a due
    // alarm, compares the value against the alarm's condition, and publishes
    // to that alarm's topic when the state changes.
    const alarmFn = new NodejsFunction(this, "AlarmEvaluator", {
      functionName: `${stackPrefix}-alarm-evaluator`,
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, "..", "backend", "src", "alarms", "handler.ts"),
      handler: "handler",
      projectRoot: path.join(__dirname, ".."),
      depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
      // A pass walks the org's Dependabot alerts once and runs a graph query
      // per non-Dependabot alarm. Nothing is waiting on the answer, and Lambda
      // bills for time actually used, so the ceiling is set for the slow case
      // rather than the usual one.
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        STACK_NAME: stackPrefix,
        SECRET_NAME: secretName,
        ALARMS_TABLE: `${stackPrefix}-alarms`,
        WIDGETS_TABLE: `${stackPrefix}-widgets`,
        ACTIVITY_TABLE: `${stackPrefix}-activity`,
        ALERTS_TABLE: `${stackPrefix}-alerts`,
        SCANNERS_TABLE: `${stackPrefix}-scanners`,
        ORG_CONFIG_TABLE: `${stackPrefix}-org-config`,
        GRAPH_EDGES_TABLE: `${stackPrefix}-graph-edges`,
        COMPLIANCE_CACHE_TABLE: `${stackPrefix}-compliance-cache`,
      },
      bundling: webhookBundling,
    });

    alarmFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "ReadAppSecrets",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${secretName}*`],
    }));

    // Reads widely, writes to one table.
    //
    // Evaluating an alarm means reading widgets, graph edges and the
    // compliance cache; the only thing it ever writes is the alarm's own
    // runtime state. Granting writes across the prefix would have let a
    // scheduled job with no user in front of it modify the activity log — the
    // record used to reconstruct what happened, including to itself.
    alarmFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "AppTablesRead",
      actions: [
        "dynamodb:GetItem", "dynamodb:Scan", "dynamodb:Query", "dynamodb:BatchGetItem",
      ],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${stackPrefix}-*`],
    }));

    alarmFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "AlarmStateWrite",
      actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${stackPrefix}-alarms`],
    }));

    alarmFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "PublishAlarmEmails",
      actions: ["sns:Publish"],
      resources: [notifyTopics],
    }));

    // Fifteen minutes, and the only schedule in the feature.
    //
    // Alarms that read Dependabot are due hourly instead, which the evaluator
    // decides per alarm rather than with a second rule — GitHub only rescans
    // when advisories are published, so asking four times an hour spends rate
    // limit to receive the same answer four times. Keeping it one rule means
    // changing that tiering is a constant in the code, not a deploy.
    new events.Rule(this, "AlarmSchedule", {
      ruleName: `${stackPrefix}-alarm-schedule`,
      description: "Evaluates widget alarms that are due",
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(alarmFn)],
    });

    const apiLogGroup = new logs.LogGroup(this, "WebhookApiAccessLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const webhookApi = new apigateway.RestApi(this, "WebhookApi", {
      restApiName: `${stackPrefix}-webhooks`,
      description: "GitHub webhook receiver",
      // REST rather than HTTP API for one reason: HTTP APIs do not support
      // resource policies, and the IP allow-list is the resource policy.
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: {
        stageName: "prod",
        throttlingRateLimit: 20,
        throttlingBurstLimit: 40,
        accessLogDestination: new apigateway.LogGroupLogDestination(apiLogGroup),
        // Deliberately no body. Payloads name repositories, people and teams.
        accessLogFormat: apigateway.AccessLogFormat.custom(JSON.stringify({
          requestId: apigateway.AccessLogField.contextRequestId(),
          sourceIp: apigateway.AccessLogField.contextIdentitySourceIp(),
          status: apigateway.AccessLogField.contextStatus(),
          latency: apigateway.AccessLogField.contextResponseLatency(),
        })),
      },
      // The allow-list the security group used to hold. Better here: API
      // Gateway evaluates this before the integration runs, so the code never
      // executes for a request from anywhere else.
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
            // Both families in one list. An IPv6 request compared only against
            // IPv4 ranges matches nothing, so NotIpAddress evaluates true and
            // the delivery is denied — a 403 indistinguishable from a stale
            // allow-list, on an endpoint that had been working until GitHub
            // resolved AAAA.
            conditions: {
              NotIpAddress: { "aws:SourceIp": [...GITHUB_WEBHOOK_CIDRS, ...GITHUB_WEBHOOK_CIDRS_V6] },
            },
          }),
        ],
      }),
    });

    // ── WAF in front of the webhook API ──
    //
    // The resource policy above is the control that matters: only GitHub's
    // published ranges reach the integration at all, and the receiver verifies
    // an HMAC before anything is queued. This is defence in depth on top.
    //
    // Deliberately NOT the AWS common rule set. Two of its rules would reject
    // legitimate deliveries: SizeRestrictions_BODY caps bodies at 8 KB, and
    // GitHub payloads routinely exceed that, while the XSS and SQLi body rules
    // inspect content that on a webhook is somebody's code, branch name or
    // commit message. A managed rule group that blocks real traffic is worse
    // than no rule group, because the failure is silent at the edge and never
    // reaches a log this app reads.
    //
    // What is here instead is a rate limit that cannot false-positive on
    // payload content: a ceiling per source address, well above anything
    // GitHub sends, that stops a compromised or misbehaving source from
    // driving the queue.
    const webhookWaf = new wafv2.CfnWebACL(this, "WebhookWaf", {
      name: `${stackPrefix}-webhook`,
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${stackPrefix}-webhook-waf`,
        sampledRequestsEnabled: false,   // samples would retain payload fragments
      },
      rules: [{
        name: "RatePerSourceIp",
        priority: 0,
        // 2,000 requests in five minutes from one address. GitHub delivering a
        // burst for a large organisation stays far below this; a source
        // sustaining more than six a second is not delivering webhooks.
        statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: "IP" } },
        action: { block: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `${stackPrefix}-webhook-waf-rate`,
          sampledRequestsEnabled: false,
        },
      }],
    });

    new wafv2.CfnWebACLAssociation(this, "WebhookWafAssociation", {
      // Built as a string rather than with formatArn. An API Gateway stage ARN
      // has a leading slash before the resource — arn:…:apigateway:region::/restapis/…
      // — and formatArn joins account and resource with a single colon, which
      // produces "::restapis/…" and is rejected as malformed.
      resourceArn: `arn:${cdk.Aws.PARTITION}:apigateway:${this.region}::/restapis/${webhookApi.restApiId}/stages/${webhookApi.deploymentStage.stageName}`,
      webAclArn: webhookWaf.attrArn,
    });

    webhookApi.root
      .addResource("webhooks")
      .addResource("github")
      .addMethod("POST", new apigateway.LambdaIntegration(receiverFn), {
        // Both headers are required to be *present*, and API Gateway rejects
        // the request with 400 before the integration runs if either is
        // missing. GitHub sends both on every delivery.
        //
        // This is not authentication and does not pretend to be — presence is
        // not validity, and the signature is still verified against the body in
        // the receiver. What it buys is that a request with no signature at all
        // never becomes a Lambda invocation.
        requestParameters: {
          "method.request.header.X-Hub-Signature-256": true,
          "method.request.header.X-GitHub-Event": true,
        },
        requestValidatorOptions: {
          requestValidatorName: `${stackPrefix}-webhook-headers`,
          validateRequestParameters: true,
          // Bodies are not validated. A schema here would have to describe
          // every event GitHub sends, would reject anything they add, and
          // would be a second place to keep in step with their API.
          validateRequestBody: false,
        },
      });

    // A queue nobody watches is a queue that quietly fills up. The guardrail
    // DLQ had this gap too, so it gets one as well.
    const alarmTopic = this.node.tryGetContext("alertEmail")
      ? new sns.Topic(this, "AlarmTopic", { displayName: `${stackPrefix} alarms` })
      : undefined;
    if (alarmTopic) {
      alarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(this.node.tryGetContext("alertEmail")),
      );
    }

    for (const [id, queue, description] of [
      ["WebhookDlqAlarm", webhookDlq, "A webhook delivery failed five times and was dead-lettered"],
      ["GuardrailDlqAlarm", guardrailDlq, "A guardrail invocation failed and was dead-lettered"],
    ] as Array<[string, sqs.Queue, string]>) {
      const alarm = new cloudwatch.Alarm(this, id, {
        metric: queue.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
          statistic: "Maximum",
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      if (alarmTopic) alarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
    }

    // ── Enterprise audit log ──
    //
    // GitHub streams the enterprise audit log here as gzipped newline-delimited
    // JSON. Nothing in this stack can make that happen — an enterprise owner
    // configures streaming in GitHub's UI and points it at this bucket. Until
    // they do, everything below sits idle and costs nothing.
    //
    // Streaming rather than polling the audit log API: the API is rate limited
    // to 1,750 requests an hour and its history is capped, while a bucket keeps
    // everything for as long as the lifecycle rule below says.
    // Some organisations run a Config rule that applies a TLS-only bucket
    // policy the moment a bucket appears. That control and enforceSSL want the
    // same thing and cannot both have it: CloudFormation creates the bucket,
    // the remediation writes its policy within seconds, and CloudFormation's
    // own CreateBucketPolicy then fails with "the bucket policy already
    // exists". The stack rolls back, RETAIN keeps the bucket and the
    // remediation's policy, and every retry replays the same race — there is
    // no number of attempts that wins it.
    //
    // The guardrail owns bucket policies here; see the audit bucket below.
    const auditBucket = new s3.Bucket(this, "AuditLogBucket", {
      bucketName: `${stackPrefix}-audit-log-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // No bucket policy from this stack.
      //
      // enforceSSL would have CloudFormation write a deny-non-TLS statement —
      // the same statement the app's own S3 guardrail writes on every bucket
      // in the account, this one included. Two mechanisms for one job, and
      // whichever lost the race to create it failed the deploy.
      //
      // So the guardrail owns bucket policies, alone. Add the S3 rule in the
      // AWS tab and it covers this bucket like any other — and re-adds the
      // statement on its next sweep if anyone strips it, which CloudFormation
      // would only do on the next deploy.
      //
      // Until that rule exists and is set to enforce, this bucket has no TLS
      // policy. It blocks all public access and only the audit-log role and
      // the ingest Lambda can reach it, but that is the trade being made.
      versioned: false,
      // The audit log is the record of who did what. Deleting the stack must
      // not take it with it, and CDK will refuse rather than silently destroy.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{
        // The raw archive is the complete record; DynamoDB only indexes the
        // consequential part. Thirteen months matches the activity feed's own
        // retention, so both halves of the trail end at the same moment rather
        // than one outliving the other by an unexplained margin.
        id: "match-activity-retention",
        expiration: cdk.Duration.days(400),
        // Most of this is never read twice. Infrequent Access after a month
        // costs less to store and more to retrieve, which is the right way
        // round for an audit archive.
        transitions: [{
          storageClass: s3.StorageClass.INFREQUENT_ACCESS,
          transitionAfter: cdk.Duration.days(30),
        }],
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
      }],
    });

    const auditIngestFn = new NodejsFunction(this, "AuditLogIngest", {
      functionName: `${stackPrefix}-audit-ingest`,
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, "..", "backend", "src", "audit", "ingest.ts"),
      handler: "handler",
      projectRoot: path.join(__dirname, ".."),
      depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
      // One object holds a batch of events, not one event. Gunzip plus a
      // BatchWrite loop is quick, but a large object on a busy enterprise
      // should not be cut off part way — a truncated batch loses audit rows.
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        STACK_NAME: stackPrefix,
        ACTIVITY_TABLE: `${stackPrefix}-activity`,
        // Widen this without a code change once real volume is known. Empty or
        // absent means the built-in list of consequential events.
        AUDIT_EVENT_ALLOWLIST: "",
      },
      bundling: webhookBundling,
    });

    auditBucket.grantRead(auditIngestFn);
    auditIngestFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "WriteAuditRowsToActivity",
      // Write-only, and to one table. This function reads nothing back: it
      // turns objects into rows and has no reason to query the feed.
      actions: ["dynamodb:PutItem", "dynamodb:BatchWriteItem"],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${stackPrefix}-activity`],
    }));

    auditBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(auditIngestFn));

    // ── Audit log streaming: how GitHub authenticates ──
    //
    // GitHub offers two ways to write to the bucket: an AWS access key pair,
    // or OpenID Connect. The key pair means storing long-lived AWS credentials
    // on GitHub, which is a standing liability for a bucket that holds the
    // record of who did what. OIDC hands GitHub a temporary credential per
    // upload and stores nothing.
    //
    // Only built when the enterprise slug is supplied, because the trust policy
    // is worthless without it — a role trusting the issuer but no particular
    // subject would accept uploads from any GitHub enterprise at all.
    //
    //   cdk deploy -c auditEnterprise=your-enterprise-slug
    //
    // The slug is the one in the URL at github.com/enterprises/<slug>, and it
    // is case-sensitive.
    const auditEnterprise = this.node.tryGetContext("auditEnterprise");
    if (auditEnterprise) {
      const auditOidc = new iam.OpenIdConnectProvider(this, "AuditLogOidcProvider", {
        url: "https://oidc-configuration.audit-log.githubusercontent.com",
        clientIds: ["sts.amazonaws.com"],
      });

      const auditStreamRole = new iam.Role(this, "AuditLogStreamRole", {
        roleName: `${stackPrefix}-audit-log-stream`,
        description: "Assumed by GitHub to write enterprise audit log objects into the audit bucket",
        assumedBy: new iam.WebIdentityPrincipal(auditOidc.openIdConnectProviderArn, {
          // Both conditions matter. The audience alone would let any enterprise
          // assume this role; the subject pins it to yours.
          StringEquals: {
            "oidc-configuration.audit-log.githubusercontent.com:aud": "sts.amazonaws.com",
            "oidc-configuration.audit-log.githubusercontent.com:sub": `https://github.com/${auditEnterprise}`,
          },
        }),
      });

      // Write only, and only into this bucket. GitHub has no reason to read
      // back what it has written, and this role should not be able to.
      auditStreamRole.addToPolicy(new iam.PolicyStatement({
        sid: "WriteAuditObjects",
        actions: ["s3:PutObject"],
        resources: [auditBucket.arnForObjects("*")],
      }));

      new cdk.CfnOutput(this, "AuditLogStreamRoleArn", {
        value: auditStreamRole.roleArn,
        description: "Paste into GitHub: Enterprise settings > Audit log > Streaming > Amazon S3 (OIDC)",
      });
    }

    // ── Outputs ──
    new cdk.CfnOutput(this, "GuardrailFunctionName", {
      value: guardrailFn.functionName,
      description: "Guardrail enforcer Lambda (invoked by the app for manual runs)",
    });

    new cdk.CfnOutput(this, "CanChangeAnything", {
      value: "three write actions granted; each rule still chooses report or enforce",
      description: "Whether this deployment's IAM lets the app modify AWS at all",
    });

    new cdk.CfnOutput(this, "GuardrailRoleName", {
      value: guardrailRoleName,
      description: "Role name each additional AWS account must create for guardrails to reach it",
    });

    new cdk.CfnOutput(this, "GuardrailLambdaRoleArn", {
      value: guardrailFn.role!.roleArn,
      description: "Principal to trust in each additional account's guardrail role",
    });

    new cdk.CfnOutput(this, "GuardrailDlqUrl", {
      value: guardrailDlq.queueUrl,
      description: "Dead-letter queue for failed guardrail invocations",
    });

    new cdk.CfnOutput(this, "AuditLogBucketName", {
      value: auditBucket.bucketName,
      description: "Point GitHub's enterprise audit log streaming at this bucket",
    });

    new cdk.CfnOutput(this, "WebhookUrl", {
      value: `${webhookApi.url}webhooks/github`,
      description: "GitHub webhook payload URL — set this in the org's webhook settings",
    });

    new cdk.CfnOutput(this, "WebhookQueueUrl", {
      value: webhookQueue.queueUrl,
      description: "Queue between the receiver and the worker",
    });

    new cdk.CfnOutput(this, "WebhookDlqUrl", {
      value: webhookDlq.queueUrl,
      description: "Dead-letter queue for webhook deliveries that failed five times",
    });
  }
}
