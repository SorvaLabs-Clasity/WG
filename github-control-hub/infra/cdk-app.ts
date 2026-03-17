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

const app = new cdk.App();

new GitHubControlHubStack(app, "GitHubControlHub", {
  env: {
    account: getAccount(),
    region: process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
  instanceType: app.node.tryGetContext("instanceType") || "t3.small",
});
