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

interface GitHubControlHubProps extends cdk.StackProps {
  /** Secrets Manager secret name. Defaults to "github-control-hub/secrets" */
  secretName?: string;
  /** DynamoDB table prefix. Defaults to "github-control-hub" */
  stackPrefix?: string;
  /**
   * Whether this app may change anything in AWS. Default: no.
   *
   * Off, the guardrail engine holds nothing but Describe and List. A rule set
   * to enforce still finds the violation and still reports the fix it would
   * make; AWS refuses the write, and the finding says so. The app is
   * incapable of altering the account it watches, and that is a property of
   * IAM rather than a promise made by this code.
   *
   * Turning it on grants exactly three actions — PutBucketPolicy,
   * PutRetentionPolicy, DeleteRetentionPolicy — and nothing else. Set with
   * `cdk deploy -c enforce=true`.
   */
  allowRemediation?: boolean;
}

export class GitHubControlHubStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GitHubControlHubProps = {}) {
    super(scope, id, props);

    const secretName = props.secretName ?? "github-control-hub/secrets";
    const stackPrefix = props.stackPrefix ?? "github-control-hub";

    // Off unless someone deliberately asks for it, on the command line, in
    // this account. A read-only default is the difference between a tool that
    // could damage production and one that cannot.
    const allowRemediation =
      props.allowRemediation ?? this.node.tryGetContext("enforce") === "true";

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

    if (allowRemediation) {
      // Three actions. Not s3:* and not logs:*, so a later version of this app
      // cannot quietly start doing something this account never agreed to
      // without the policy visibly changing.
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
        SECRET_NAME: secretName,
        WEBHOOK_QUEUE_URL: webhookQueue.queueUrl,
      },
      bundling: webhookBundling,
    });

    // Two grants, and that is the whole of it. This function is the only thing
    // here reachable from the internet.
    receiverFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "ReadWebhookSecret",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${secretName}*`],
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
      },
      bundling: webhookBundling,
    });

    workerFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "ReadAppSecrets",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${secretName}*`],
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
            conditions: { NotIpAddress: { "aws:SourceIp": GITHUB_WEBHOOK_CIDRS } },
          }),
        ],
      }),
    });

    webhookApi.root
      .addResource("webhooks")
      .addResource("github")
      .addMethod("POST", new apigateway.LambdaIntegration(receiverFn));

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

    // ── Outputs ──
    new cdk.CfnOutput(this, "GuardrailFunctionName", {
      value: guardrailFn.functionName,
      description: "Guardrail enforcer Lambda (invoked by the app for manual runs)",
    });

    new cdk.CfnOutput(this, "CanChangeAnything", {
      value: allowRemediation ? "yes — three write actions granted" : "no — read-only",
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
