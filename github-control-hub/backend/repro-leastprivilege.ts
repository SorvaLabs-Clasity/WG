/**
 * Tests that this app cannot obtain broad AWS access.
 *
 * These are not tests of behaviour — they read the IAM the project ships and
 * assert what it does not contain. That is the point: every other test here
 * checks that the code does the right thing, and this one checks that the code
 * *could not* do the wrong thing even if it tried, because AWS would refuse.
 *
 * They exist because the failure they guard against is silent and permanent.
 * Nobody notices an app quietly holding administrator in a production account
 * until the day it matters, and by then the permission has been there for
 * months.
 */
import fs from "fs";
import path from "path";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const ROOT = path.join(__dirname, "../..");
const cdk = fs.readFileSync(path.join(ROOT, "github-control-hub/infra/cdk-stack.ts"), "utf8");
const template = fs.readFileSync(path.join(ROOT, "scripts/guardrail-account-role.yaml"), "utf8");
const accountsTs = fs.readFileSync(path.join(__dirname, "src/aws-guardrails/accounts.ts"), "utf8");

/** Strip comments, so prose about a role is not mistaken for a grant of it. */
const code = (src: string) => src
  .split("\n")
  .filter(l => !/^\s*(\/\/|#|\*|\/\*)/.test(l))
  .map(l => l.replace(/\s+\/\/.*$/, "").replace(/\s+#.*$/, ""))
  .join("\n");

const cdkCode = code(cdk);
const templateCode = code(template);
const accountsCode = code(accountsTs);

(async () => {
  // ── the administrator roles AWS hands out ──────────────────────────
  {
    for (const role of ["OrganizationAccountAccessRole", "AWSControlTowerExecution", "AdministratorAccess"]) {
      check(`the stack never grants access to ${role}`,
        !cdkCode.includes(role), role);
      check(`  and the app never tries to assume it`,
        !accountsCode.includes(role), role);
    }
  }

  // ── sts:AssumeRole is scoped to one role name ──────────────────────
  //
  // Two of these grants used to exist: the instance role's, so the app could
  // verify an account before storing it, and the guardrail engine's, so it
  // could sweep one. The instance role is gone with the webhook-on-Lambda
  // migration, so only the engine's grant remains.
  {
    const assumeBlocks = [...cdkCode.matchAll(/sts:AssumeRole[\s\S]{0,400}?resources:\s*\[([\s\S]*?)\]/g)]
      .map(m => m[1]);
    check("every sts:AssumeRole grant names resources",
      assumeBlocks.length >= 1, assumeBlocks.length);
    for (const block of assumeBlocks) {
      check("  and none of them is a wildcard role",
        !/["'`]\*["'`]/.test(block) && !/role\/\*/.test(block), block.trim());
      check("  each names exactly one role",
        block.split(",").filter(x => x.trim()).length === 1, block.trim());
      check("  which is the guardrail role",
        block.includes("guardrailRoleName"), block.trim());
    }
  }

  // ── no IAM, ever ───────────────────────────────────────────────────
  {
    check("the app is granted no IAM actions at all",
      !/["']iam:/.test(cdkCode), "cdk-stack.ts grants an iam: action");
    check("  nor any Organizations action beyond reading the account list",
      [...cdkCode.matchAll(/["']organizations:(\w+)["']/g)].every(m =>
        ["ListAccounts", "DescribeOrganization", "ListRoots"].includes(m[1])),
      [...cdkCode.matchAll(/["']organizations:(\w+)["']/g)].map(m => m[1]));
  }

  // ── it cannot read anyone's data ───────────────────────────────────
  {
    // The engine's own role. This is the one that walks every bucket and log
    // group in every account, so it is the one that must never be able to read
    // what is inside them.
    const enginePolicy = cdkCode
      .split("guardrailFn.addToRolePolicy")
      .slice(1)
      .join("\n");

    const forbidden = [
      "s3:GetObject", "s3:GetObjectVersion", "s3:*",
      "logs:GetLogEvents", "logs:FilterLogEvents", "logs:*",
      "dynamodb:*", "secretsmanager:*", "ec2:*", "*:*",
    ];
    for (const action of forbidden) {
      check(`the guardrail engine is never granted ${action}`,
        !enginePolicy.includes(`"${action}"`), action);
      check(`  nor is the role deployed into other accounts`,
        !new RegExp(`-\\s*${action.replace(/\*/g, "\\*")}\\s*$`, "m").test(
          templateCode.split("Effect: Deny")[0]), action);
    }

    // GetObject used to appear once, on the instance role: the deploy script
    // pulled a Docker image from a bucket this stack owns. That role — and
    // the grant with it — is gone with the webhook-on-Lambda migration, so
    // there should be no s3:GetObject grant anywhere in the stack now.
    const getObjectGrants = [...cdkCode.matchAll(/["']s3:GetObject["'][\s\S]{0,300}?resources:\s*\[([^\]]*)\]/g)]
      .map(m => m[1].trim());
    check("no s3:GetObject grant remains in the stack",
      getObjectGrants.length === 0,
      getObjectGrants);
  }

  // ── writing is off unless someone asks for it ──────────────────────
  {
    check("remediation permissions are behind a flag, not granted unconditionally",
      /if\s*\(allowRemediation\)/.test(cdkCode), "no allowRemediation guard in cdk-stack.ts");
    check("  and the flag defaults to off",
      /tryGetContext\("enforce"\)\s*===\s*"true"/.test(cdkCode), "enforce flag is not opt-in");
    check("the account role template defaults to read-only",
      /ReadOnly:[\s\S]{0,120}?Default:\s*"true"/.test(template), "ReadOnly does not default to true");
  }

  // ── the internet-facing function is the smallest thing here ────────
  //
  // The receiver is the only component reachable from the internet. The
  // privilege split is the reason it is a separate function at all, so a
  // grant creeping into it is the regression this guards.
  {
    const receiverBlock = cdkCode.slice(
      cdkCode.indexOf("const receiverFn"),
      cdkCode.indexOf("const workerFn"),
    );
    check("the webhook receiver holds no DynamoDB",
      receiverBlock.length > 0 && !/dynamodb:/.test(receiverBlock),
      "the internet-facing function gained table access");
    check("  and cannot assume a role",
      !/sts:AssumeRole/.test(receiverBlock),
      "the internet-facing function gained cross-account reach");
    check("  and cannot invoke anything",
      !/lambda:InvokeFunction/.test(receiverBlock));

    check("the webhook API restricts source IPs to GitHub",
      /NotIpAddress/.test(cdkCode) && /GITHUB_WEBHOOK_CIDRS/.test(cdkCode),
      "the allow-list the security group used to hold was not carried over");
    check("  with an explicit deny, not just an allow",
      /Effect\.DENY/.test(cdkCode),
      "an allow alone does not exclude anyone");
  }

  // ── the writes that do exist are exactly three ─────────────────────
  {
    const block = cdkCode.split("RemediateThreeThings")[1]?.split("}))")[0] ?? "";
    const actions = [...block.matchAll(/["'](s3|logs):(\w+)["']/g)].map(m => `${m[1]}:${m[2]}`);
    check("enforcement grants exactly three actions",
      actions.length === 3, actions);
    check("  and they are the three the two rules make",
      actions.sort().join() === "logs:DeleteRetentionPolicy,logs:PutRetentionPolicy,s3:PutBucketPolicy",
      actions);
  }

  // ── the deployed role denies the dangerous things outright ─────────
  {
    const denySection = templateCode.slice(templateCode.indexOf("NeverPolicy"));
    for (const action of ["s3:GetObject", "s3:DeleteBucket", "iam:*", "sts:AssumeRole",
                          "s3:PutBucketAcl", "logs:DeleteLogGroup"]) {
      check(`the account role explicitly denies ${action}`,
        denySection.includes(action), action);
    }
    check("  and the denies live under Resources, not Outputs",
      template.indexOf("NeverPolicy") > template.indexOf("\nResources:")
      && template.indexOf("NeverPolicy") < template.indexOf("\nOutputs:"),
      "NeverPolicy is in the wrong section");
  }

  // ── secrets and tables stay inside this app's own prefix ───────────
  {
    const secretGrants = [...cdkCode.matchAll(/secretsmanager:[\s\S]{0,300}?resources:\s*\[([^\]]*)\]/g)]
      .map(m => m[1]);
    check("no secrets grant reaches every secret in the account",
      secretGrants.every(r => !/secret:\*/.test(r) && !/["'`]\*["'`]/.test(r)), secretGrants);

    const dynamoGrants = [...cdkCode.matchAll(/dynamodb:[\s\S]{0,400}?resources:\s*\[([^\]]*)\]/g)]
      .map(m => m[1]);
    check("no DynamoDB grant reaches every table in the account",
      dynamoGrants.every(r => r.includes("stackPrefix")), dynamoGrants);
  }

  // ── the embedded template is the same as the repo's ────────────────
  {
    const { ACCOUNT_ROLE_TEMPLATE } = await import("./src/aws-guardrails/accountRoleTemplate");
    check("the template the app hands out is byte-identical to the repo's",
      ACCOUNT_ROLE_TEMPLATE === template,
      ACCOUNT_ROLE_TEMPLATE === template ? "" : "run: npx tsx sync-account-role-template.ts");
    check("  so neither copy can quietly become the lenient one",
      ACCOUNT_ROLE_TEMPLATE.includes("NeverPolicy")
      && /ReadOnly:[\s\S]{0,120}?Default:\s*"true"/.test(ACCOUNT_ROLE_TEMPLATE),
      "the embedded template lost its denies or its read-only default");
  }

  // ── the app cannot create roles anywhere ───────────────────────────
  {
    // Creating an IAM role across an organisation needs
    // cloudformation:CreateStackSet with CAPABILITY_NAMED_IAM. Whoever holds
    // that can deploy an administrator role into every account — strictly
    // worse than the administrator access this app was built without. So the
    // app builds the parameters and a human presses Create.
    for (const action of ["cloudformation:CreateStackSet", "cloudformation:CreateStackInstances",
                          "cloudformation:CreateStack", "cloudformation:UpdateStackSet",
                          "iam:CreateRole", "iam:AttachRolePolicy", "iam:PutRolePolicy",
                          "iam:PassRole", "organizations:EnableAWSServiceAccess"]) {
      check(`the app is never granted ${action}`, !cdkCode.includes(action), action);
    }

    const routes = fs.readFileSync(path.join(__dirname, "src/routes/awsGuardrails.ts"), "utf8");
    check("  and no route tries to create a stack or a stack set",
      !/CreateStackSetCommand|CreateStackCommand|CreateStackInstancesCommand/.test(routes),
      "a route creates CloudFormation resources");
  }

  // ── the lambda read that used to replace asking a person ───────────
  //
  // The instance role held lambda:GetFunctionConfiguration so the app could
  // read the guardrail engine's own role ARN instead of a person hunting for
  // it in a stack output. That role is gone with the webhook-on-Lambda
  // migration; the capability moved to the desktop app, which calls the same
  // API with the signed-in user's own AWS credentials
  // (src/aws-guardrails/accounts.ts, controlHubPrincipals) and falls back to
  // pointing at the "GuardrailLambdaRoleArn" stack output if that fails. The
  // stack itself should grant nothing for it any more.
  {
    check("the stack no longer grants lambda:GetFunctionConfiguration to anyone",
      !/lambda:GetFunctionConfiguration/.test(cdkCode),
      "an unexpected grant of lambda:GetFunctionConfiguration remains in cdk-stack.ts");
  }

  // ── a bundled dependency npm cannot reach ──────────────────────────
  {
    // aws-cdk-lib ships its dependencies inside its own tarball, so npm
    // installs them from there rather than resolving them: `overrides` has no
    // effect and `npm audit fix` has nothing to fix. GHSA-rgw5-rvv9-x895 in
    // brace-expansion is therefore only fixable by replacing the file, which a
    // postinstall does — and which nothing would notice had stopped working.
    const infra = JSON.parse(fs.readFileSync(
      path.join(ROOT, "github-control-hub/infra/package.json"), "utf8"));

    check("the bundled-dependency patch runs on every install",
      infra.scripts?.postinstall?.includes("patch-bundled-brace-expansion"),
      infra.scripts?.postinstall ?? "no postinstall");

    check("  and the replacement version is pinned as a dependency",
      /\^5\.0\.(9|[1-9]\d)/.test(infra.devDependencies?.["brace-expansion"] ?? ""),
      infra.devDependencies?.["brace-expansion"] ?? "absent");

    check("  the script it names exists",
      fs.existsSync(path.join(ROOT, "github-control-hub/infra/scripts/patch-bundled-brace-expansion.mjs")));

    // Only when installed — CI typechecks before it installs infra.
    const bundledPkg = path.join(ROOT,
      "github-control-hub/infra/node_modules/aws-cdk-lib/node_modules/brace-expansion/package.json");
    if (fs.existsSync(bundledPkg)) {
      const v = JSON.parse(fs.readFileSync(bundledPkg, "utf8")).version;
      const [maj, min, pat] = v.split(".").map(Number);
      check("  and the copy on disk is actually patched",
        maj > 5 || (maj === 5 && (min > 0 || pat >= 9)), v);
    }
  }

  // ── one role name, agreed by all three files ───────────────────────
  {
    const suffix = "-guardrail-access";
    check("the stack, the app and the template use the same role name",
      cdkCode.includes(suffix) && accountsCode.includes(suffix)
      && template.includes(`github-control-hub${suffix}`),
      suffix);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
