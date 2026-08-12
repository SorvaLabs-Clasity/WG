import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

interface GitHubControlHubProps extends cdk.StackProps {
  /** EC2 instance size. Defaults to t3.small */
  instanceType?: string;
  /** Secrets Manager secret name. Defaults to "github-control-hub/secrets" */
  secretName?: string;
  /** DynamoDB table prefix. Defaults to "github-control-hub" */
  stackPrefix?: string;
}

export class GitHubControlHubStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GitHubControlHubProps = {}) {
    super(scope, id, props);

    const secretName = props.secretName ?? "github-control-hub/secrets";
    const stackPrefix = props.stackPrefix ?? "github-control-hub";

    // ── VPC (default VPC) ──
    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    // ── Security Group ──
    const sg = new ec2.SecurityGroup(this, "SecurityGroup", {
      vpc,
      description: "GitHub Control Hub - HTTPS only, no SSH",
      allowAllOutbound: true,
    });

    // HTTPS restricted to GitHub webhook IP ranges (from https://api.github.com/meta → hooks)
    for (const cidr of [
      "192.30.252.0/22",
      "185.199.108.0/22",
      "140.82.112.0/20",
      "143.55.64.0/20",
    ]) {
      sg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), `GitHub webhooks (${cidr})`);
    }

    // No SSH port — use SSM Session Manager instead

    // The narrow role this app assumes in another account when that account
    // has bothered to create one. Fixed by name so the trust policy over
    // there, the template we hand out, and the grants here all say the same
    // thing.
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
      actions: ["organizations:ListAccounts", "organizations:DescribeOrganization"],
      resources: ["*"],   // neither call supports resource-level scoping
    }));

    // Adding an account verifies it before storing it, which means the app
    // itself has to be able to assume the role and ask who it is.
    role.addToPolicy(new iam.PolicyStatement({
      sid: "VerifyAccountAccess",
      actions: ["sts:AssumeRole"],
      resources: [
        `arn:aws:iam::*:role/${guardrailRoleName}`,
        "arn:aws:iam::*:role/OrganizationAccountAccessRole",
        "arn:aws:iam::*:role/AWSControlTowerExecution",
      ],
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
        volume: ec2.BlockDeviceVolume.ebs(20, { volumeType: ec2.EbsDeviceVolumeType.GP3 }),
      }],
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
      "chmod 644 /etc/ssl/github-control-hub/server.key /etc/ssl/github-control-hub/server.crt",
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
    });

    const guardrailFn = new NodejsFunction(this, "GuardrailEnforcer", {
      functionName: `${stackPrefix}-guardrail-enforcer`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "..", "backend", "src", "aws-guardrails", "handler.ts"),
      handler: "handler",
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
        // The Node 20 Lambda runtime ships AWS SDK v3, so bundling it would
        // only make the artifact larger and slower to cold-start.
        externalModules: ["@aws-sdk/*"],
        minify: false,
        sourceMap: true,
      },
    });

    guardrailFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "ReadState",
      actions: [
        "s3:ListAllMyBuckets", "s3:GetBucketPolicy", "s3:GetBucketTagging",
        "logs:DescribeLogGroups", "logs:ListTagsForResource",
      ],
      resources: ["*"], // every one of these is a List/Describe with no resource-level scoping
    }));

    guardrailFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "Remediate",
      actions: [
        "s3:PutBucketPolicy",
        "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy",
      ],
      resources: ["*"],
    }));

    // Reaching other accounts. The role name is fixed rather than "*" so this
    // grant cannot be pointed at an arbitrary role someone happens to name in
    // the accounts table — the target account still has to trust us back, but
    // there is no reason for this side to be wider than it needs to be.
    guardrailFn.addToRolePolicy(new iam.PolicyStatement({
      sid: "AssumeGuardrailRoleInOtherAccounts",
      actions: ["sts:AssumeRole"],
      // The scoped role first, then the two roles AWS itself creates in
      // organisation accounts. Those carry AdministratorAccess, which is far
      // more than this app needs — but they exist without anyone deploying
      // anything, and an account that is actually being checked beats a
      // narrower grant on an account nobody got round to onboarding.
      resources: [
        `arn:aws:iam::*:role/${guardrailRoleName}`,
        "arn:aws:iam::*:role/OrganizationAccountAccessRole",
        "arn:aws:iam::*:role/AWSControlTowerExecution",
      ],
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

    // ── Outputs ──
    new cdk.CfnOutput(this, "GuardrailFunctionName", {
      value: guardrailFn.functionName,
      description: "Guardrail enforcer Lambda (invoked by the app for manual runs)",
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
      value: `https://${eip.ref}/api/webhooks/github`,
      description: "GitHub webhook payload URL",
    });

    new cdk.CfnOutput(this, "ConnectCommand", {
      value: `aws ssm start-session --target ${instance.instanceId}`,
      description: "Connect to instance (no SSH key needed)",
    });
  }
}
