#!/usr/bin/env node
import { execSync } from "child_process";
import * as cdk from "aws-cdk-lib";
import { GitHubControlHubStack } from "./cdk-stack";

// Auto-detect account ID from AWS CLI if not set
function getAccount(): string {
  if (process.env.CDK_DEFAULT_ACCOUNT) return process.env.CDK_DEFAULT_ACCOUNT;
  try {
    return execSync("aws sts get-caller-identity --query Account --output text", { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Could not detect AWS account. Run 'aws configure' or set CDK_DEFAULT_ACCOUNT.");
  }
}

// Never a default.
//
// This used to fall back to us-east-1, so a deploy with CDK_DEFAULT_REGION
// unset built the entire stack — instance, Lambda, elastic IP — in a region
// nobody had named, and said nothing. AWS_REGION does not help: cdk-app only
// ever read CDK_DEFAULT_REGION, so exporting the one the CLI uses left this
// silently wrong.
function getRegion(): string {
  const region = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION;
  if (region) return region;
  try {
    const fromProfile = execSync("aws configure get region", { encoding: "utf8" }).trim();
    if (fromProfile) return fromProfile;
  } catch { /* no profile configured */ }
  throw new Error(
    "No AWS region. Set CDK_DEFAULT_REGION (or AWS_REGION), or give your AWS profile one.\n" +
    "Refusing to guess: a stack deployed to the wrong region is a stack you have to find first."
  );
}

const app = new cdk.App();

new GitHubControlHubStack(app, "GitHubControlHub", {
  env: {
    account: getAccount(),
    region: getRegion(),
  },
  instanceType: app.node.tryGetContext("instanceType") || "t3.small",
});
