import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
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
const GITHUB_WEBHOOK_CIDRS = [
  "192.30.252.0/22",
  "185.199.108.0/22",
  "140.82.112.0/20",
  "143.55.64.0/20",
];

interface GitHubControlHubProps extends cdk.StackProps {
  /** EC2 instance size. Defaults to t3.small */
  instanceType?: string;
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

    // ── VPC (default VPC) ──
    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    // ── Security Group ──
    const sg = new ec2.SecurityGroup(this, "SecurityGroup", {
      vpc,
      description: "GitHub Control Hub - HTTPS only, no SSH",
      allowAllOutbound: true,
    });

    // HTTPS restricted to GitHub webhook IP ranges (from https://api.github.com/meta → hooks)
    for (const cidr of GITHUB_WEBHOOK_CIDRS) {
      sg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), `GitHub webhooks (${cidr})`);
    }

    // No SSH port — use SSM Session Manager instead

    // The only role this app may ever assume, anywhere.
    //
    // Named exactly, and the grants below are scoped to this name alone. The
    // roles AWS creates by default in organisation member accounts —
    // OrganizationAccountAccessRole, AWSControlTowerExecution — carry
    // AdministratorAccess, and this app is deliberately unable to assume them.
    // Convenience is not worth an application in a production account holding
    // administrator anywhere.
    const guardrailRoleName = `${stackPrefix}-guardrail-access`;

    // ── IAM Role ──
    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      // SSM Session Manager — connect to the instance without SSH
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });

    // S3 access for deploy script (Docker image transfer)
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject"],
      resources: [`arn:aws:s3:::github-control-hub-deploy-${this.account}/*`],
    }));

    // Secrets Manager access
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${secretName}*`],
    }));

    // Access keys for AWS accounts that are not in an organisation, written
    // from the Accounts screen. Scoped to this app's own prefix so the grant
    // cannot reach the GitHub credentials next to it.
    role.addToPolicy(new iam.PolicyStatement({
      sid: "StoreAccountKeys",
      actions: ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${stackPrefix}/aws-account/*`],
    }));

    // Listing the organisation is what removes the setup work: the account ids
    // and names are already recorded here, so nobody has to type them.
    role.addToPolicy(new iam.PolicyStatement({
      sid: "DiscoverOrganizationAccounts",
      actions: ["organizations:ListAccounts", "organizations:DescribeOrganization", "organizations:ListRoots"],
      resources: ["*"],   // neither call supports resource-level scoping
    }));

    // Adding an account verifies it before storing it, which means the app
    // itself has to be able to assume the role and ask who it is.
    //
    // One role name, in any account. Not "*": a grant of sts:AssumeRole on
    // every role would let this app become anything that trusts it, which is
    // the whole ballgame.
    role.addToPolicy(new iam.PolicyStatement({
      sid: "VerifyAccountAccess",
      actions: ["sts:AssumeRole"],
      resources: [`arn:aws:iam::*:role/${guardrailRoleName}`],
    }));

    // DynamoDB access for app tables
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
        "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:Query",
        "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
      ],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${stackPrefix}-*`],
    }));

    // ── EC2 Instance ──
    const instance = new ec2.Instance(this, "Instance", {
      vpc,
      instanceType: new ec2.InstanceType(props.instanceType ?? "t3.small"),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
      role,
      ssmSessionPermissions: true,
      blockDevices: [{
        deviceName: "/dev/xvda",
        // Encrypted at rest. The volume holds the application image and
        // whatever the container writes; secrets are fetched into memory
        // rather than stored, but a snapshot of an unencrypted root volume is
        // still a copy of the app somebody can mount.
        volume: ec2.BlockDeviceVolume.ebs(20, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
        }),
      }],
      // IMDSv2 only. Version 1 answers an unauthenticated GET, so any
      // server-side request forgery in the app becomes a way to read the
      // instance role's credentials. The running instance already has this;
      // stating it here stops a future replacement quietly losing it.
      requireImdsv2: true,
    });

    // UserData — install Docker and generate self-signed SSL cert
    instance.addUserData(
      "yum update -y",
      "yum install -y docker",
      "systemctl enable docker",
      "systemctl start docker",
      "usermod -aG docker ec2-user",
      "",
      "# Generate self-signed SSL certificate",
      "mkdir -p /etc/ssl/github-control-hub",
      'openssl req -x509 -nodes -days 365 -newkey rsa:2048 \\',
      '  -keyout /etc/ssl/github-control-hub/server.key \\',
      '  -out /etc/ssl/github-control-hub/server.crt \\',
      '  -subj "/CN=github-control-hub"',
      // The certificate is public by definition. The key was chmod'ed 644
      // alongside it, which made the server's private key readable by every
      // account on the instance.
      //
      // It cannot simply be 600 root-owned: the container runs as the `node`
      // user and mounts this directory to read the key, which is the reason
      // the permissive mode was there. So give it to that uid instead of to
      // everyone — 1000 is `node` in the node:24-alpine image, and ec2-user on
      // the host. Root still reads it; nothing else does.
      "chown 1000:1000 /etc/ssl/github-control-hub/server.key",
      "chmod 600 /etc/ssl/github-control-hub/server.key",
      "chmod 644 /etc/ssl/github-control-hub/server.crt",
    );

    cdk.Tags.of(instance).add("Name", "github-control-hub");

    // ── Elastic IP ──
    // Without this the instance's public IP changes on every stop/start, which
    // silently breaks the GitHub webhook (it points at a bare IP, not a DNS name).
    // Free while associated with a running instance.
    const eip = new ec2.CfnEIP(this, "Eip", {
      domain: "vpc",
      instanceId: instance.instanceId,
      tags: [{ key: "Name", value: "github-control-hub" }],
    });

    // ── AWS guardrails ──
    // Enforcement runs here rather than on the instance: it needs no inbound
    // connectivity, so the security group stays closed to everything but
    // GitHub's webhook ranges.
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

    // The app invokes this directly for manual runs and previews.
    guardrailFn.grantInvoke(role);

    // The Accounts screen shows both role ARNs a watched account must trust,
    // and one of them is this function's. Reading its own configuration beats
    // asking a person to go and find it in a stack output.
    role.addToPolicy(new iam.PolicyStatement({
      sid: "ReadOwnEngineRole",
      actions: ["lambda:GetFunctionConfiguration"],
      resources: [guardrailFn.functionArn],
    }));

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
      // Auto-apply waits five seconds for provisioning and then retries four
      // times, and the scanner runs that used to be unbounded background time
      // on a long-lived server now happen inside the invocation.
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      // Must be at least the event source's maxConcurrency below.
      reservedConcurrentExecutions: 5,
      environment: {
        STACK_NAME: stackPrefix,
        SECRET_NAME: secretName,
        ACTIVITY_TABLE: `${stackPrefix}-activity`,
        TEMPLATES_TABLE: `${stackPrefix}-templates`,
        SCANNERS_TABLE: `${stackPrefix}-scanners`,
        ALERTS_TABLE: `${stackPrefix}-alerts`,
        ORG_CONFIG_TABLE: `${stackPrefix}-org-config`,
        GRAPH_EDGES_TABLE: `${stackPrefix}-graph-edges`,
        EXCLUSIONS_TABLE: `${stackPrefix}-exclusions`,
        COMPLIANCE_CACHE_TABLE: `${stackPrefix}-compliance-cache`,
        RULE_TEMPLATES_TABLE: `${stackPrefix}-rule-templates`,
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

    new cdk.CfnOutput(this, "InstanceId", {
      value: instance.instanceId,
      description: "EC2 instance ID (use with: aws ssm start-session --target <id>)",
    });

    new cdk.CfnOutput(this, "PublicIp", {
      value: eip.ref,
      description: "Elastic IP — stable across instance restarts",
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

    new cdk.CfnOutput(this, "ConnectCommand", {
      value: `aws ssm start-session --target ${instance.instanceId}`,
      description: "Connect to instance (no SSH key needed)",
    });
  }
}
